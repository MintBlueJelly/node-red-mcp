import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { containerObjects, etagOf, indexFlows } from '../../src/flows.js';
import { UserError } from '../../src/output.js';
import { createWriter, plans } from '../../src/writer.js';
import { fakeClient } from '../support/fake-node-red.js';

function setup() {
    const client = fakeClient();
    return { client, write: createWriter({ client }) };
}
const etag = (client, id) => etagOf(containerObjects(indexFlows(client.state.flows), id));
const members = (client, id) => indexFlows(client.state.flows).membersOf(id);
const byId = (client, id) => client.state.flows.find((o) => o.id === id);
const tabOrder = (client) => client.state.flows.filter((o) => o.type === 'tab').map((o) => o.id);
const rejects = (promise, pattern) => assert.rejects(promise, (err) => err instanceof UserError && pattern.test(err.message));
const refusedFor = (promise, code) => assert.rejects(promise, (err) => err instanceof UserError && err.detail.errors?.some((e) => e.code === code));

describe('update_flow', () => {
    it('deploys the change, keeps order and every tab key, and returns the new etag', async () => {
        const { client, write } = setup();
        const nodes = members(client, 'A').map((n) => (n.id === 'A_dbg' ? { ...n, name: 'renamed' } : n));
        const before = byId(client, 'A');
        const res = await write((f) => plans.updateTab(f, { id: 'A', flow: { nodes, info: 'new info' } }), { etag: etag(client, 'A') });
        assert.equal(res.result, 'deployed');
        assert.equal(res.etag, etag(client, 'A'));
        assert.deepEqual(res.restarts, [{ flow: 'A', label: 'Tab A', nodes: 6 }]);
        assert.deepEqual(tabOrder(client), ['A', 'B', 'C', 'D', 'E']);
        assert.deepEqual(byId(client, 'A'), { ...before, info: 'new info' });
        assert.equal(byId(client, 'A_dbg').name, 'renamed');
    });
    it('keeps x and y of existing nodes when the model leaves them out', async () => {
        const { client, write } = setup();
        const nodes = members(client, 'A').map(({ x, y, ...n }) => n);
        const res = await write((f) => plans.updateTab(f, { id: 'A', flow: { nodes } }), { etag: etag(client, 'A') });
        assert.equal(res.result, 'no_op');
        assert.equal(client.state.deploys, 0);
    });
    it('answers a repeated call with no_op, even with the old etag', async () => {
        const { client, write } = setup();
        const old = etag(client, 'A');
        const build = (f) => plans.updateTab(f, { id: 'A', flow: { info: 'once' } });
        assert.equal((await write(build, { etag: old })).result, 'deployed');
        assert.equal((await write(build, { etag: old })).result, 'no_op');
        assert.equal(client.state.deploys, 1);
    });
    it('refuses a stale etag, without handing out the current one', async () => {
        const { client, write } = setup();
        const old = etag(client, 'A');
        client.externalDeploy((f) => f.map((o) => (o.id === 'A_dbg' ? { ...o, name: 'by a person' } : o)));
        await assert.rejects(write((f) => plans.updateTab(f, { id: 'A', flow: { info: 'x' } }), { etag: old }), (err) => {
            assert.match(err.message, /changed since you read it/);
            assert.doesNotMatch(JSON.stringify(err.detail), /[0-9a-f]{16}/);
            return true;
        });
    });
    it('retries once on a rev conflict when the target is untouched', async () => {
        const { client, write } = setup();
        client.state.beforeDeploy = () => client.externalDeploy((f) => f.map((o) => (o.id === 'B_alone' ? { ...o, name: 'parallel' } : o)));
        const res = await write((f) => plans.updateTab(f, { id: 'A', flow: { info: 'x' } }), { etag: etag(client, 'A') });
        assert.equal(res.result, 'deployed');
        assert.equal(byId(client, 'B_alone').name, 'parallel');
        assert.equal(byId(client, 'A').info, 'x');
    });
    it('refuses on a rev conflict when someone changed the target', async () => {
        const { client, write } = setup();
        client.state.beforeDeploy = () => client.externalDeploy((f) => f.map((o) => (o.id === 'A_dbg' ? { ...o, name: 'parallel' } : o)));
        await rejects(write((f) => plans.updateTab(f, { id: 'A', flow: { info: 'x' } }), { etag: etag(client, 'A') }), /changed since you read it/);
        assert.equal(byId(client, 'A_dbg').name, 'parallel');
    });
    it('refuses locked tabs, credentials, foreign ids, wrong z and unknown types', async () => {
        const { client, write } = setup();
        const tag = etag(client, 'A');
        const nodes = members(client, 'A');
        await rejects(write((f) => plans.updateTab(f, { id: 'E', flow: { info: 'x' } }), { etag: etag(client, 'E') }), /locked/);
        await rejects(write((f) => plans.updateTab(f, { id: 'A', flow: { nodes: [{ ...nodes[0], credentials: {} }] } }), { etag: tag }), /credentials/);
        await rejects(write((f) => plans.updateTab(f, { id: 'A', flow: { nodes: [...nodes, { id: 'B_alone', type: 'comment' }] } }), { etag: tag }), /already used/);
        await rejects(write((f) => plans.updateTab(f, { id: 'A', flow: { nodes: [{ id: 'q', type: 'comment', z: 'B' }] } }), { etag: tag }), /belongs to A/);
        await rejects(write((f) => plans.updateTab(f, { id: 'A', flow: { nodes: [...nodes, { id: 'q', type: 'nope' }] } }), { etag: tag }), /introduce/);
        await rejects(write((f) => plans.updateTab(f, { id: 'A', flow: { locked: true } }), { etag: tag }), /cannot change locked/);
        await refusedFor(write((f) => plans.updateTab(f, { id: 'A', flow: { env: [{ name: 'S', type: 'cred', value: 'plain' }] } }), { etag: tag }), 'cred-env');
        await rejects(write((f) => plans.updateTab(f, { id: 'A', flow: { nodes: [nodes[0], nodes[0]] } }), { etag: tag }), /more than once/);
        assert.equal(client.state.deploys, 0);
    });
    it('points subflows and config nodes to update_global', async () => {
        const { client, write } = setup();
        await rejects(write((f) => plans.updateTab(f, { id: 'SF1', flow: {} }), { etag: 'x' }), /update_global/);
        await rejects(write((f) => plans.updateTab(f, { id: 'px1', flow: {} }), { etag: 'x' }), /update_global/);
        assert.ok(client);
    });
    it('reports that a disabled tab starts', async () => {
        const { client, write } = setup();
        const res = await write((f) => plans.updateTab(f, { id: 'D', flow: { disabled: false } }), { etag: etag(client, 'D') });
        assert.equal(res.started, true);
    });
    it('runs writes one at a time', async () => {
        const { client, write } = setup();
        const first = write((f) => plans.updateTab(f, { id: 'A', flow: { info: '1' } }), { etag: etag(client, 'A') });
        const second = write((f) => plans.updateTab(f, { id: 'B', flow: { info: '2' } }), { etag: etag(client, 'B') });
        const results = await Promise.all([first, second]);
        assert.deepEqual(results.map((r) => r.result), ['deployed', 'deployed']);
        assert.equal(client.state.deploys, 2);
    });
});

describe('create_flow', () => {
    it('creates a tab last and refuses a second one with the same label', async () => {
        const { client, write } = setup();
        const flow = { label: 'New', disabled: true, nodes: [{ id: 'n1', type: 'inject', wires: [['n2']] }, { id: 'n2', type: 'debug', wires: [] }] };
        const res = await write((f) => plans.createTab(f, { flow }));
        assert.equal(res.result, 'deployed');
        assert.equal(tabOrder(client).at(-1), res.flow);
        assert.equal(byId(client, 'n1').z, res.flow);
        await rejects(write((f) => plans.createTab(f, { flow })), /already exists/);
    });
});

describe('delete_flow', () => {
    it('needs the tab disabled, reports links into it, and is idempotent', async () => {
        const { client, write } = setup();
        await rejects(write((f) => plans.deleteTab(f, { id: 'A' }), { etag: etag(client, 'A') }), /disable it/);
        await write((f) => plans.updateTab(f, { id: 'A', flow: { disabled: true } }), { etag: etag(client, 'A') });
        const tag = etag(client, 'A');
        const res = await write((f) => plans.deleteTab(f, { id: 'A' }), { etag: tag });
        assert.equal(res.result, 'deleted');
        assert.deepEqual(res.linkedFrom.map((l) => l.id), ['B_li']);
        assert.ok(!client.state.flows.some((o) => o.z === 'A'));
        assert.equal((await write((f) => plans.deleteTab(f, { id: 'A' }), { etag: tag })).result, 'already_deleted');
    });
});

describe('update_global', () => {
    it('changes a subflow and reports the tabs using it', async () => {
        const { client, write } = setup();
        const res = await write((f) => plans.updateGlobal(f, { id: 'SF1', subflow: { info: 'x' } }), { etag: etag(client, 'SF1') });
        assert.deepEqual(res.restarts, [{ flow: 'C', label: 'Tab C', nodes: 1 }]);
    });
    it('changes a config node, keeping its id and type', async () => {
        const { client, write } = setup();
        const node = { ...byId(client, 'px1'), url: 'http://other.invalid' };
        const res = await write((f) => plans.updateGlobal(f, { id: 'px1', node }), { etag: etag(client, 'px1') });
        assert.deepEqual(res.restarts, [{ flow: 'B', label: 'Tab B', nodes: 2 }, { flow: 'global', label: 'global config nodes', nodes: 1 }]);
        await rejects(write((f) => plans.updateGlobal(f, { id: 'px1', node: { ...node, type: 'other' } }), { etag: etag(client, 'px1') }), /keeps its id and type/);
    });
    it('refuses the global-config node, tabs and credentials', async () => {
        const { client, write } = setup();
        await rejects(write((f) => plans.updateGlobal(f, { id: 'gc', node: {} }), { etag: 'x' }), /global environment/);
        await rejects(write((f) => plans.updateGlobal(f, { id: 'A', node: {} }), { etag: 'x' }), /update_flow/);
        await rejects(write((f) => plans.updateGlobal(f, { id: 'px1', node: { credentials: {} } }), { etag: 'x' }), /credentials/);
        assert.ok(client);
    });
});
