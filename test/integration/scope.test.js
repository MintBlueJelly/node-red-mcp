// What a write reports as restarting, against what the pinned Node-RED restarts, measured with On
// Start counters: config nodes used by config nodes, nested subflows, config nodes inside subflow
// templates, and single-target link nodes across tabs.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { connect } from '../support/mcp-client.js';
import { startNodeRed, startServer, waitFor } from '../support/harness.js';
import { SCOPE_COUNTERS, scopeFlows } from '../support/scope-fixture.js';

let nr;
let srv;
let mcp;

before(async () => {
    nr = await startNodeRed();
    await nr.seed(scopeFlows(), SCOPE_COUNTERS);
    srv = await startServer(nr.url);
    mcp = await connect(`${srv.url}/mcp`);
});

after(async () => {
    await mcp?.close();
    await srv?.stop();
    await nr?.cleanup();
});

// Which tab each counter runs on; the subflow counters run inside the instances on TN and TP.
const TAB_OF = { SFI: 'TN', SFO: 'TN', SFP: 'TP' };
const tabOf = (counter) => TAB_OF[counter] ?? counter.split('_')[0];
const reportedTabs = (result) => result.restarts.map((r) => r.flow).filter((f) => f !== 'global').sort();
const movedTabs = (moved) => [...new Set(moved.map(tabOf))].sort();

async function measure(action) {
    const { result, moved } = await nr.restartedBy(action, SCOPE_COUNTERS);
    assert.equal(result.result, 'deployed', JSON.stringify(result));
    return { result, moved };
}

describe('the reported restarts match what Node-RED restarts', () => {
    it('a config node used by another config node', async () => {
        const t = await mcp.call('get_flow', { id: 'T1' });
        const { result, moved } = await measure(() => mcp.call('update_global', { id: 'T1', etag: t.etag, node: { ...t.node, name: 'tls1 renamed' } }));
        assert.deepEqual(moved, ['TB_chain']);
        assert.deepEqual(reportedTabs(result), movedTabs(moved));
    });

    it('the inner subflow of a nested pair', async () => {
        const sf = await mcp.call('get_flow', { id: 'SFI' });
        const nodes = sf.nodes.map((n) => ({ ...n, func: 'return msg; // changed' }));
        const { result, moved } = await measure(() => mcp.call('update_global', { id: 'SFI', etag: sf.etag, nodes }));
        assert.deepEqual(moved, ['SFI', 'SFO', 'TN_chain']);
        assert.deepEqual(reportedTabs(result), movedTabs(moved));
    });

    it('a config node used only inside a subflow template', async () => {
        const p = await mcp.call('get_flow', { id: 'P1' });
        const { result, moved } = await measure(() => mcp.call('update_global', { id: 'P1', etag: p.etag, node: { ...p.node, url: 'http://proxy2.invalid:3128' } }));
        assert.deepEqual(moved, ['SFP', 'TP_chain']);
        assert.deepEqual(reportedTabs(result), movedTabs(moved));
    });

    it('a link in targeted by a single-target link out on another tab', async () => {
        const f = await mcp.call('get_flow', { id: 'TL1' });
        const nodes = f.nodes.map((n) => (n.id === 'TL1_li' ? { ...n, name: 'target renamed' } : n));
        const { result, moved } = await measure(() => mcp.call('update_flow', { id: 'TL1', etag: f.etag, flow: { nodes } }));
        assert.deepEqual(moved, ['TL1_chain', 'TL2_up']);
        assert.deepEqual(reportedTabs(result), movedTabs(moved));
    });

    it('a link in called by a single-target link call on another tab', async () => {
        const f = await mcp.call('get_flow', { id: 'TL1' });
        const nodes = f.nodes.map((n) => (n.id === 'TL1_li2' ? { ...n, name: 'callee renamed' } : n));
        const { result, moved } = await measure(() => mcp.call('update_flow', { id: 'TL1', etag: f.etag, flow: { nodes } }));
        assert.deepEqual(moved, ['TL1_ret', 'TL3_up']);
        assert.deepEqual(reportedTabs(result), movedTabs(moved));
    });
});

describe('status inside nested subflow instances', () => {
    it('resolves to the node and the tab, and counts as a problem there', async () => {
        const status = await waitFor(async () => (await mcp.call('get_node_status', { flow_id: 'TN' })).statuses.find((s) => s.text === 'inner red'), { what: 'the nested status' });
        assert.deepEqual([status.name, status.subflowInstance, status.stale], ['SFI', 'TN_sf/sfo_inst', undefined]);
        assert.equal((await mcp.call('list_flows')).tabs.find((t) => t.id === 'TN').problems, 1);
    });
});
