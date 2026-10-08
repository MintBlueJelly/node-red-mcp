// The HTTP surface as a proxy in front of it sees it: stateless JSON responses, both protocol
// revisions clients negotiate today, and no session id to lose.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startNodeRed, startServer } from '../support/harness.js';

let nr;
let srv;

before(async () => {
    nr = await startNodeRed();
    srv = await startServer(nr.url);
});

after(async () => {
    await srv?.stop();
    await nr?.cleanup();
});

async function rpc(method, params, extraHeaders = {}) {
    const res = await fetch(`${srv.url}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...extraHeaders },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return { status: res.status, type: res.headers.get('content-type'), session: res.headers.get('mcp-session-id'), body: await res.json() };
}

describe('Streamable HTTP, stateless', () => {
    for (const version of ['2025-11-25', '2025-06-18']) {
        it(`initializes with protocol ${version}, in JSON, without a session`, async () => {
            const res = await rpc('initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'test', version: '0' } });
            assert.equal(res.status, 200);
            assert.match(res.type, /application\/json/);
            assert.equal(res.session, null);
            assert.equal(res.body.result.protocolVersion, version);
            assert.equal(res.body.result.serverInfo.name, 'node-red-mcp');
        });
    }

    it('answers tools/list without an initialize on the same connection', async () => {
        const res = await rpc('tools/list', {}, { 'mcp-protocol-version': '2025-11-25' });
        assert.equal(res.body.result.tools.length, 17);
        for (const tool of res.body.result.tools) assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    });

    it('refuses GET and DELETE, and serves /healthz', async () => {
        assert.equal((await fetch(`${srv.url}/mcp`)).status, 405);
        assert.equal((await fetch(`${srv.url}/mcp`, { method: 'DELETE' })).status, 405);
        const health = await (await fetch(`${srv.url}/healthz`)).json();
        assert.equal(health.status, 'ok');
        assert.equal(health.comms.connected, true);
    });
});
