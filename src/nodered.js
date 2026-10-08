// Node-RED Admin API client. Only the endpoints this server needs, and deliberately none that
// install modules, stop the runtime, delete context or do a full deploy.

export class NodeRedError extends Error {
    constructor(message, status, body) {
        super(message);
        this.name = 'NodeRedError';
        this.status = status;
        this.body = body;
    }
}

export function createClient({ baseUrl, token, timeoutMs, fetchImpl = globalThis.fetch }) {
    const root = baseUrl.replace(/\/+$/, '');
    const enc = encodeURIComponent;

    async function request(method, path, { body, headers = {} } = {}) {
        const h = { 'Node-RED-API-Version': 'v2', Accept: 'application/json', ...headers };
        if (token) h.Authorization = `Bearer ${token}`;
        let payload;
        if (body !== undefined) {
            h['Content-Type'] = 'application/json';
            payload = JSON.stringify(body);
        }
        let res;
        try {
            res = await fetchImpl(root + path, { method, headers: h, body: payload, signal: AbortSignal.timeout(timeoutMs) });
        } catch (err) {
            throw new NodeRedError(`Node-RED did not answer ${method} ${path}: ${err.cause?.code ?? err.message}`, 0);
        }
        const text = await res.text();
        let parsed = text;
        if (text && (res.headers.get('content-type') ?? '').includes('json')) {
            try { parsed = JSON.parse(text); } catch { /* keep the text */ }
        }
        if (!res.ok) {
            const detail = typeof parsed === 'object' ? (parsed.message ?? parsed.code ?? text) : text;
            throw new NodeRedError(`Node-RED answered ${method} ${path} with ${res.status}: ${String(detail).slice(0, 300)}`, res.status, parsed);
        }
        return text ? parsed : null;
    }

    return {
        /** `{rev, flows}`; never includes credentials. */
        getFlows: () => request('GET', '/flows'),
        /** A "modified flows" deploy: Node-RED restarts only what changed and what is wired to it. */
        deployFlows: (rev, flows) => request('POST', '/flows', {
            body: { rev, flows },
            headers: { 'Node-RED-Deployment-Type': 'flows' },
        }),
        getNodes: () => request('GET', '/nodes'),
        getSettings: () => request('GET', '/settings'),
        getDiagnostics: () => request('GET', '/diagnostics'),
        getFlowsState: () => request('GET', '/flows/state'),
        getContext: (scope, id, key, store) => {
            let path = `/context/${scope}`;
            if (scope !== 'global') path += `/${enc(id)}`;
            if (key) path += `/${enc(key)}`;
            if (store) path += `?store=${enc(store)}`;
            return request('GET', path);
        },
        setDebugState: (id, enabled) => request('POST', `/debug/${enc(id)}/${enabled ? 'enable' : 'disable'}`),
        inject: (id) => request('POST', `/inject/${enc(id)}`),
    };
}
