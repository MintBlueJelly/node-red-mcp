// The editor's WebSocket (`/comms`): the only place Node-RED publishes node status, debug output,
// node warnings and errors, and runtime notifications. One long-lived connection per process.

const TOPICS = ['status/#', 'debug', 'notification/#'];
// Node-RED replays retained messages straight after a subscribe; anything inside this window is a
// replay, so its real time is unknown.
const RETAINED_WINDOW_MS = 1000;
const LEVELS = { 20: 'error', 30: 'warn' };

export function commsUrl(nodeRedUrl) {
    const url = new URL(nodeRedUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/comms`;
    return url.toString();
}

export class Comms {
    constructor({ url, token, ring, heartbeatTimeoutMs = 45000, WebSocketImpl = globalThis.WebSocket, log = () => {}, now = Date.now }) {
        this.url = url;
        this.token = token;
        this.ring = ring;
        this.heartbeatTimeoutMs = heartbeatTimeoutMs;
        this.WebSocketImpl = WebSocketImpl;
        this.log = log;
        this.now = now;
        this.statuses = new Map();
        this.replayed = new Set();
        this.connected = false;
        this.since = null;
        this.lastMessageAt = null;
        this.lastDeployAt = null;
        this.runtimeState = null;
        this.reconnects = 0;
        this.backoffMs = 1000;
        this.stopped = true;
    }

    start() {
        this.stopped = false;
        this.connect();
        this.watchdog = setInterval(() => this.checkHeartbeat(), 5000);
        this.watchdog.unref?.();
    }

    stop() {
        this.stopped = true;
        clearInterval(this.watchdog);
        clearTimeout(this.retryTimer);
        this.ws?.close();
    }

    connect() {
        // Doubles as the connect deadline: a handshake that hangs is closed by the watchdog too.
        this.lastMessageAt = this.now();
        let ws;
        try {
            ws = new this.WebSocketImpl(this.url);
        } catch (err) {
            this.log('comms', { event: 'connect-failed', error: err.message });
            this.scheduleReconnect();
            return;
        }
        this.ws = ws;
        ws.onopen = () => {
            this.lastMessageAt = this.now();
            if (this.token) ws.send(JSON.stringify({ auth: this.token }));
            else this.subscribe(ws);
        };
        ws.onmessage = (event) => this.onMessage(ws, event.data);
        ws.onerror = () => {};
        ws.onclose = () => {
            if (this.ws !== ws) return;
            const wasConnected = this.connected;
            this.connected = false;
            this.ws = null;
            if (wasConnected) this.log('comms', { event: 'disconnected' });
            if (!this.stopped) this.scheduleReconnect();
        };
    }

    subscribe(ws) {
        for (const topic of TOPICS) ws.send(JSON.stringify({ subscribe: topic }));
        this.statuses.clear();
        this.replayed = new Set();
        this.connected = true;
        this.since = this.now();
        this.backoffMs = 1000;
        this.log('comms', { event: 'connected', url: this.url });
    }

    scheduleReconnect() {
        clearTimeout(this.retryTimer);
        this.reconnects += 1;
        const delay = this.backoffMs;
        this.backoffMs = Math.min(this.backoffMs * 2, 30000);
        this.retryTimer = setTimeout(() => this.connect(), delay);
        this.retryTimer.unref?.();
    }

    checkHeartbeat() {
        if (this.ws && this.lastMessageAt && this.now() - this.lastMessageAt > this.heartbeatTimeoutMs) {
            this.log('comms', { event: 'heartbeat-timeout' });
            const ws = this.ws;
            ws.onclose?.();
            try { ws.close(); } catch { /* already gone */ }
        }
    }

    onMessage(ws, raw) {
        this.lastMessageAt = this.now();
        let parsed;
        try { parsed = JSON.parse(typeof raw === 'string' ? raw : raw.toString()); } catch { return; }
        if (!Array.isArray(parsed) && parsed?.auth !== undefined) {
            if (parsed.auth === 'ok') this.subscribe(ws);
            else {
                this.log('comms', { event: 'auth-failed' });
                ws.close();
            }
            return;
        }
        for (const message of [].concat(parsed)) this.handle(message);
    }

    handle({ topic, data }) {
        if (typeof topic !== 'string') return;
        const at = this.now();
        const inWindow = this.since !== null && at - this.since < RETAINED_WINDOW_MS;
        // The replay sends each topic once, so a second message for a topic is live even inside the window.
        const retained = inWindow && !this.replayed.has(topic);
        if (inWindow) this.replayed.add(topic);
        if (topic.startsWith('status/')) {
            const id = topic.slice(7);
            if (!data || Object.keys(data).length === 0) this.statuses.delete(id);
            else this.statuses.set(id, { fill: data.fill, shape: data.shape, text: data.text, at: retained ? null : at, retained: retained || undefined });
            return;
        }
        if (topic === 'debug' && data) {
            this.ring.push({
                kind: data.level ? LEVELS[data.level] ?? 'log' : 'debug',
                at: data.timestamp ?? at,
                id: data.id,
                alias: data._alias,
                flow: typeof data.path === 'string' ? data.path.split('/')[0] : data.z,
                path: data.path,
                name: data.name || undefined,
                type: data.type,
                topic: data.topic,
                property: data.property,
                format: data.format,
                msg: data.msg,
            });
            return;
        }
        if (topic.startsWith('notification/')) {
            const event = topic.slice(13);
            if (event === 'runtime-deploy') this.lastDeployAt = retained ? this.lastDeployAt : at;
            if (event === 'runtime-state') this.runtimeState = data;
            if (!retained) this.ring.push({ kind: 'runtime', at, event, data });
        }
    }

    state() {
        const iso = (t) => (t ? new Date(t).toISOString() : undefined);
        return {
            connected: this.connected,
            since: iso(this.since),
            reconnects: this.reconnects || undefined,
        };
    }
}
