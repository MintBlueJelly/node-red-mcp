// The write path against a real Node-RED 5.0.4: what restarts, what survives, and what is refused.
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
    srv = await startServer(nr.url);
    mcp = await connect(`${srv.url}/mcp`);
});

after(async () => {
    await mcp?.close();
    await srv?.stop();
    await nr?.cleanup();
});

/** Runs `action` and returns which On Start counters moved. */
async function restartedBy(action) {
    const before = await nr.counters();
    const result = await action();
    await sleep(800);
    const after = await nr.counters();
    return { result, moved: Object.keys(after).filter((k) => after[k] !== before[k]).sort() };
}
const tabOrder = async () => (await nr.api('GET', '/flows')).body.flows.filter((o) => o.type === 'tab').map((o) => o.id);
const stored = async (id) => (await nr.api('GET', '/flows')).body.flows.find((o) => o.id === id);
const readSecret = async () => {
    await mcp.call('trigger_inject', { node_id: 'A_inj', repeat: true });
    return waitFor(async () => (await nr.context('a_secret')) === 's3cret' && nr.context('a_env'), { what: 'the flow to read its env', timeoutMs: 5000 });
};

describe('update_flow', () => {
    it('restarts only the changed node and what is wired to it, as a modified-flows deploy', async () => {
        const flow = await mcp.call('get_flow', { id: 'A' });
        const nodes = flow.nodes.map((n) => (n.id === 'A_dbg' ? { ...n, name: 'renamed' } : n));
        const logStart = nr.logs.length;
        const { result, moved } = await restartedBy(() => mcp.call('update_flow', { id: 'A', etag: flow.etag, flow: { nodes } }));
        assert.equal(result.result, 'deployed');
        assert.deepEqual(result.restarts, [{ flow: 'A', label: 'Tab A', nodes: 6 }]);
        assert.deepEqual(moved, ['A_chain']);
        const logs = nr.logs.slice(logStart).join('\n');
        assert.match(logs, /Stopping modified flows/);
        assert.doesNotMatch(logs, /Stopping flows\b/);
        assert.equal((await mcp.call('get_flow', { id: 'A' })).etag, result.etag);
    });

    it('keeps tab order, locked, info, env and the tab credential', async () => {
        const orderBefore = await tabOrder();
        const flow = await mcp.call('get_flow', { id: 'A' });
        const res = await mcp.call('update_flow', { id: 'A', etag: flow.etag, flow: { info: 'changed by MCP' } });
        assert.equal(res.result, 'deployed');
        assert.deepEqual(await tabOrder(), orderBefore);
        assert.equal((await stored('E')).locked, true);
        assert.deepEqual((await stored('A')).env, flow.flow.env);
        assert.deepEqual((await nr.api('GET', '/credentials/tab/A')).body, { has_A_SECRET: true });
        assert.equal(await readSecret(), 'a1');
    });

    it('refuses a change to a flow a person deployed since it was read', async () => {
        const flow = await mcp.call('get_flow', { id: 'A' });
        const cur = (await nr.api('GET', '/flows')).body;
        const edited = cur.flows.map((o) => (o.id === 'A_dbg' ? { ...o, name: 'by a person' } : o));
        assert.equal((await nr.api('POST', '/flows', { rev: cur.rev, flows: edited }, { 'Node-RED-Deployment-Type': 'flows' })).status, 200);
        const res = await mcp.call('update_flow', { id: 'A', etag: flow.etag, flow: { info: 'mine' } });
        assert.equal(res.isError, true);
        assert.match(res.error, /changed since you read it/);
        assert.equal((await stored('A_dbg')).name, 'by a person');
    });

    it('answers a repeated update with no_op', async () => {
        const flow = await mcp.call('get_flow', { id: 'B' });
        const first = await mcp.call('update_flow', { id: 'B', etag: flow.etag, flow: { info: 'twice' } });
        const second = await mcp.call('update_flow', { id: 'B', etag: flow.etag, flow: { info: 'twice' } });
        assert.deepEqual([first.result, second.result], ['deployed', 'no_op']);
    });

    it('refuses an unknown node type, and the runtime keeps running', async () => {
        const flow = await mcp.call('get_flow', { id: 'B' });
        const res = await mcp.call('update_flow', { id: 'B', etag: flow.etag, flow: { nodes: [...flow.nodes, { id: 'ghost', type: 'no-such-node', x: 1, y: 1, wires: [] }] } });
        assert.equal(res.isError, true);
        assert.equal(res.errors[0].code, 'unknown-type');
        assert.deepEqual((await nr.api('GET', '/flows/state')).body, { state: 'start' });
    });

    it('refuses a locked tab', async () => {
        const flow = await mcp.call('get_flow', { id: 'E' });
        const res = await mcp.call('update_flow', { id: 'E', etag: flow.etag, flow: { info: 'x' } });
        assert.match(res.error, /locked/);
    });
});

describe('create_flow and delete_flow', () => {
    it('create is refused the second time, and delete is idempotent', async () => {
        const flow = { label: 'Created by MCP', disabled: true, nodes: [{ id: 'c1', type: 'inject', x: 100, y: 100, wires: [['c2']] }, { id: 'c2', type: 'debug', active: true, tosidebar: true, x: 300, y: 100, wires: [] }] };
        const { result: created, moved } = await restartedBy(() => mcp.call('create_flow', { flow }));
        assert.equal(created.result, 'deployed');
        assert.deepEqual(moved, []);
        assert.equal((await tabOrder()).at(-1), created.flow);
        assert.match((await mcp.call('create_flow', { flow })).error, /already exists/);
        const { etag } = await mcp.call('get_flow', { id: created.flow });
        assert.equal((await mcp.call('delete_flow', { id: created.flow, etag })).result, 'deleted');
        assert.equal((await mcp.call('delete_flow', { id: created.flow, etag })).result, 'already_deleted');
    });

    it('will not delete a running flow', async () => {
        const { etag } = await mcp.call('get_flow', { id: 'C' });
        assert.match((await mcp.call('delete_flow', { id: 'C', etag })).error, /disable it/);
    });
});

describe('update_global', () => {
    it('a subflow change restarts only its instances', async () => {
        const sf = await mcp.call('get_flow', { id: 'SF1' });
        const nodes = sf.nodes.map((n) => ({ ...n, name: 'sf renamed' }));
        const { result, moved } = await restartedBy(() => mcp.call('update_global', { id: 'SF1', etag: sf.etag, nodes }));
        assert.deepEqual(result.restarts, [{ flow: 'C', label: 'Tab C', nodes: 1 }]);
        assert.deepEqual(moved, ['SF1']);
    });

    it('a config node change restarts its users, and keeps its credentials', async () => {
        const px = await mcp.call('get_flow', { id: 'px1' });
        const { result, moved } = await restartedBy(() => mcp.call('update_global', { id: 'px1', etag: px.etag, node: { ...px.node, url: 'http://proxy2.invalid:3128' } }));
        assert.deepEqual(result.restarts, [{ flow: 'B', label: 'Tab B', nodes: 2 }]);
        assert.deepEqual(moved, ['B_chain']);
        assert.deepEqual((await nr.api('GET', '/credentials/http-proxy/px1')).body, { username: 'u', has_password: true });
    });

    it('refuses the global-config node', async () => {
        const { result, moved } = await restartedBy(() => mcp.call('update_global', { id: 'gc', etag: 'any', node: { env: [] } }));
        assert.match(result.error, /global environment/);
        assert.deepEqual(moved, []);
    });
});

describe('after a Node-RED restart', () => {
    it('every credential is still there', async () => {
        await nr.restart();
        assert.equal(await readSecret(), 'a1');
        assert.deepEqual((await nr.api('GET', '/credentials/http-proxy/px1')).body, { username: 'u', has_password: true });
    });
});
