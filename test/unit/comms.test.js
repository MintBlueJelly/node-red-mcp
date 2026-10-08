import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { Comms, commsUrl } from '../../src/comms.js';
import { Ring } from '../../src/ring.js';

class FakeSocket {
    static instances = [];
    constructor(url) {
        this.url = url;
        this.sent = [];
        this.closed = false;
        FakeSocket.instances.push(this);
    }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.closed = true; }
    open() { this.onopen?.(); }
    deliver(...messages) { this.onmessage?.({ data: JSON.stringify(messages) }); }
}

function setup({ token } = {}) {
    FakeSocket.instances = [];
    let t = 1_000_000;
    const clock = { now: () => t, advance: (ms) => { t += ms; } };
    const ring = new Ring({ maxItems: 100, maxBytes: 1e6 });
    const comms = new Comms({ url: 'ws://nr/comms', token, ring, heartbeatTimeoutMs: 45000, WebSocketImpl: FakeSocket, now: clock.now });
    return { comms, ring, clock, socket: () => FakeSocket.instances.at(-1) };
}

let current;
afterEach(() => current?.stop());

describe('commsUrl', () => {
    it('maps http to ws and keeps a path prefix', () => {
        assert.equal(commsUrl('http://nodered:1880'), 'ws://nodered:1880/comms');
        assert.equal(commsUrl('https://host/red/'), 'wss://host/red/comms');
    });
});

describe('Comms', () => {
    it('subscribes on open and marks replayed statuses as retained', () => {
        const s = setup();
        current = s.comms;
        s.comms.start();
        s.socket().open();
        assert.deepEqual(s.socket().sent.map((m) => m.subscribe), ['status/#', 'debug', 'notification/#']);
        s.socket().deliver({ topic: 'status/n1', data: { fill: 'red', shape: 'ring', text: 'down' } });
        assert.equal(s.comms.statuses.get('n1').retained, true);
        s.clock.advance(100);
        s.socket().deliver({ topic: 'status/n1', data: { fill: 'red', shape: 'ring', text: 'down again' } });
        assert.equal(s.comms.statuses.get('n1').retained, undefined, 'a second message for a topic is live');
        s.clock.advance(5000);
        s.socket().deliver({ topic: 'status/n2', data: { fill: 'green', text: 'up' } }, { topic: 'status/n1', data: {} });
        assert.equal(s.comms.statuses.get('n2').retained, undefined);
        assert.equal(s.comms.statuses.has('n1'), false);
    });
    it('authenticates first when it has a token', () => {
        const s = setup({ token: 'tok' });
        current = s.comms;
        s.comms.start();
        s.socket().open();
        assert.deepEqual(s.socket().sent, [{ auth: 'tok' }]);
        s.socket().onmessage({ data: JSON.stringify({ auth: 'ok' }) });
        assert.equal(s.socket().sent.length, 4);
        assert.equal(s.comms.connected, true);
    });
    it('puts debug output, warnings, errors and runtime events in the ring', () => {
        const s = setup();
        current = s.comms;
        s.comms.start();
        s.socket().open();
        s.clock.advance(5000);
        s.socket().deliver(
            { topic: 'debug', data: { id: 'd1', z: 'A', path: 'A', name: 'dbg', msg: '42', format: 'number', timestamp: 7 } },
            { topic: 'debug', data: { level: 30, id: 'C_sf-f1', _alias: 'f1', z: 'C_sf', path: 'C/C_sf', msg: 'careful', type: 'function' } },
            { topic: 'debug', data: { level: 20, id: 'f2', path: 'B', msg: 'boom' } },
            { topic: 'notification/runtime-deploy', data: { revision: 'r' } },
            { topic: 'hb', data: 1 },
        );
        const items = s.ring.read({ limit: 10 }).items;
        assert.deepEqual(items.map((e) => e.kind), ['debug', 'warn', 'error', 'runtime']);
        assert.equal(items[1].flow, 'C');
        assert.equal(items[1].alias, 'f1');
        assert.equal(s.comms.lastDeployAt, s.clock.now());
    });
    it('does not log a replayed deploy notification as a new event', () => {
        const s = setup();
        current = s.comms;
        s.comms.start();
        s.socket().open();
        s.socket().deliver({ topic: 'notification/runtime-deploy', data: { revision: 'r' } });
        assert.equal(s.ring.read({ limit: 10 }).items.length, 0);
        assert.equal(s.comms.lastDeployAt, null);
    });
    it('reconnects when the heartbeat stops, and clears statuses on the new connection', (t) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
        const s = setup();
        current = s.comms;
        s.comms.start();
        s.socket().open();
        s.socket().deliver({ topic: 'status/n1', data: { fill: 'red' } });
        const first = s.socket();
        s.clock.advance(46000);
        t.mock.timers.tick(5000);
        assert.equal(first.closed, true);
        assert.equal(s.comms.connected, false);
        t.mock.timers.tick(1000);
        assert.notEqual(s.socket(), first);
        s.socket().open();
        assert.equal(s.comms.connected, true);
        assert.equal(s.comms.statuses.size, 0);
    });
    it('backs off between failed attempts and resets once connected', (t) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
        const s = setup();
        current = s.comms;
        s.comms.start();
        for (const wait of [1000, 2000, 4000]) {
            s.socket().onclose();
            const before = FakeSocket.instances.length;
            t.mock.timers.tick(wait - 1);
            assert.equal(FakeSocket.instances.length, before);
            t.mock.timers.tick(1);
            assert.equal(FakeSocket.instances.length, before + 1);
        }
        s.socket().open();
        assert.equal(s.comms.backoffMs, 1000);
    });
});
