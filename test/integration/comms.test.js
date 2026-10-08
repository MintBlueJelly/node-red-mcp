// /comms against a real Node-RED 5.0.4: status and debug capture, buffer bounds under a flood, and
// recovery when Node-RED restarts or stops answering.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { connect } from '../support/mcp-client.js';
import { sleep, startNodeRed, startServer, waitFor } from '../support/harness.js';

let nr;
let srv;
let mcp;

before(async () => {
    nr = await startNodeRed();
    await nr.seed();
    await nr.api('POST', '/inject/A_inj');
    await sleep(500);
    srv = await startServer(nr.url, { COMMS_HEARTBEAT_TIMEOUT_MS: '6000', DEBUG_BUFFER_ITEMS: '200', DEBUG_BUFFER_BYTES: '65536' });
    mcp = await connect(`${srv.url}/mcp`);
});

after(async () => {
    await mcp?.close();
    await srv?.stop();
    await nr?.cleanup();
});

describe('status and debug output', () => {
    it('replays the statuses that were set before the server connected', async () => {
        // The replay lands a few milliseconds after the subscribe that marks the server connected.
        const probe = await waitFor(async () => (await mcp.call('get_node_status', { flow_id: 'A' })).statuses.find((s) => s.id === 'A_env'), { what: 'the replay', timeoutMs: 5000 });
        assert.deepEqual({ fill: probe.fill, text: probe.text, retained: probe.retained }, { fill: 'red', text: 'probed', retained: true });
    });

    it('captures what an inject produces, from the cursor on', async () => {
        const { cursor } = await mcp.call('trigger_inject', { node_id: 'A_inj' });
        const page = await waitFor(async () => {
            const p = await mcp.call('get_debug_messages', { cursor, flow_id: 'A' });
            return p.messages.length >= 2 && p;
        }, { what: 'debug output' });
        assert.deepEqual(page.messages.map((m) => [m.kind, m.id]), [['warn', 'A_env'], ['debug', 'A_dbg']]);
        assert.equal(page.messages[0].msg, 'probe warning');
        const status = (await mcp.call('get_node_status', { node_id: 'A_env' })).statuses[0];
        assert.equal(status.retained, undefined);
        assert.ok(status.at);
    });

    it('attributes a status inside a subflow instance to its tab', async () => {
        const sf = await mcp.call('get_flow', { id: 'SF1' });
        const nodes = sf.nodes.map((n) => ({ ...n, initialize: `${n.initialize} node.status({fill:'yellow',text:'sf up'}); node.warn('sf warn');` }));
        await mcp.call('update_global', { id: 'SF1', etag: sf.etag, nodes });
        const status = await waitFor(async () => (await mcp.call('get_node_status', { flow_id: 'C' })).statuses.find((s) => s.text === 'sf up'), { what: 'the subflow status' });
        assert.deepEqual([status.subflowInstance, status.name], ['C_sf', 'sf fn']);
        const warn = await waitFor(async () => (await mcp.call('get_debug_messages', { node_id: 'sf1fn', level: 'warn' })).messages[0], { what: 'the subflow warning' });
        assert.equal(warn.flow, 'C');
    });
});

describe('the buffer under a flood', () => {
    it('stays within its count and byte bounds', async () => {
        const flood = {
            label: 'Flood',
            nodes: [
                { id: 'fl_inj', type: 'inject', props: [{ p: 'payload' }], repeat: '0.01', once: true, onceDelay: 0.1, payload: 'x'.repeat(1024), payloadType: 'str', x: 100, y: 100, wires: [['fl_dbg']] },
                { id: 'fl_dbg', type: 'debug', active: true, tosidebar: true, console: false, complete: 'payload', targetType: 'msg', x: 300, y: 100, wires: [] },
            ],
        };
        const created = await mcp.call('create_flow', { flow: flood });
        await sleep(4000);
        const { etag } = await mcp.call('get_flow', { id: created.flow });
        await mcp.call('update_flow', { id: created.flow, etag, flow: { disabled: true } });
        const page = await mcp.call('get_debug_messages', { flow_id: created.flow, limit: 5 });
        assert.ok(page.buffer.items <= 200, `items ${page.buffer.items}`);
        assert.ok(page.buffer.bytes <= 65536, `bytes ${page.buffer.bytes}`);
        assert.ok(page.buffer.dropped > 0, 'the flood should have pushed entries out');
        assert.equal(page.messages.length, 5);
        assert.ok(page.skipped > 0);
    });
});

describe('recovery', () => {
    it('answers tools/list while Node-RED is down, and reconnects when it is back', async () => {
        await nr.stop();
        const tools = await mcp.client.listTools();
        assert.equal(tools.tools.length, 17);
        const down = await mcp.call('list_flows');
        assert.equal(down.isError, true);
        assert.match(down.error, /did not answer/);
        await waitFor(async () => !(await srv.health()).comms.connected, { what: 'the server to notice' });
        await nr.start();
        await waitFor(async () => (await srv.health()).comms.connected, { what: 'the server to reconnect', timeoutMs: 45000 });
        const res = await mcp.call('get_node_status', {});
        assert.ok(res.comms.reconnects >= 1);
    });

    it('reconnects after Node-RED stops answering without closing the socket', { skip: process.platform === 'win32' && 'SIGSTOP does not exist on Windows' }, async () => {
        nr.signal('SIGSTOP');
        try {
            await waitFor(async () => !(await srv.health()).comms.connected, { what: 'the heartbeat watchdog', timeoutMs: 20000 });
        } finally {
            nr.signal('SIGCONT');
        }
        await waitFor(async () => (await srv.health()).comms.connected, { what: 'the server to reconnect', timeoutMs: 45000 });
    });
});
