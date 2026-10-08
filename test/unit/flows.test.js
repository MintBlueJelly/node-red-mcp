import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    assertOnlyContainerChanged, canonical, describeScope, etagOf, indexFlows, insertTab, removeContainer,
    replaceContainer, resolveStatus, restartScope, searchNodes, summarize,
} from '../../src/flows.js';
import { storedFixture } from '../support/fixture.js';

const ids = (flows) => flows.map((o) => o.id);
const tabOrder = (flows) => flows.filter((o) => o.type === 'tab').map((o) => o.id);
const edit = (flows, id, patch) => flows.map((o) => (o.id === id ? { ...o, ...patch } : o));
const scopeOf = (before, after) => restartScope(before, after).nodes.sort();
const pick = (r) => ({ node: r.node?.id, tab: r.tab, instance: r.instance, stale: r.stale });

describe('canonical and etag', () => {
    it('ignores key order', () => {
        assert.equal(canonical({ a: 1, b: { c: 2, d: 3 } }), canonical({ b: { d: 3, c: 2 }, a: 1 }));
        assert.equal(etagOf([{ a: 1, b: 2 }]), etagOf([{ b: 2, a: 1 }]));
    });
    it('changes with any value', () => {
        assert.notEqual(etagOf([{ a: 1 }]), etagOf([{ a: 2 }]));
    });
});

describe('replaceContainer', () => {
    it('keeps every position and every object outside the container', () => {
        const flows = storedFixture();
        const index = indexFlows(flows);
        const members = index.membersOf('A').map((n) => (n.id === 'A_dbg' ? { ...n, name: 'renamed' } : n));
        const next = replaceContainer(flows, 'A', [{ ...index.byId.get('A'), info: 'new' }, ...members]);
        assert.deepEqual(ids(next), ids(flows));
        assert.deepEqual(tabOrder(next), tabOrder(flows));
        assertOnlyContainerChanged(flows, next, new Set(['A', ...members.map((m) => m.id)]));
    });
    it('drops removed members and puts new ones after the last member', () => {
        const flows = storedFixture();
        const index = indexFlows(flows);
        const members = index.membersOf('A').filter((n) => n.id !== 'A_alone');
        const next = replaceContainer(flows, 'A', [index.byId.get('A'), ...members, { id: 'A_new', type: 'comment', z: 'A' }]);
        assert.ok(!ids(next).includes('A_alone'));
        assert.equal(ids(next).indexOf('A_new'), ids(next).indexOf('A_grp') + 1);
    });
    it('the invariant check catches a change outside the target', () => {
        const flows = storedFixture();
        assert.throws(() => assertOnlyContainerChanged(flows, edit(flows, 'B_alone', { name: 'x' }), new Set(['A'])), /outside its target/);
    });
});

describe('insertTab and removeContainer', () => {
    it('opens a new tab last and removes a tab with its nodes', () => {
        const flows = storedFixture();
        const next = insertTab(flows, { id: 'N', type: 'tab', label: 'N' }, [{ id: 'N1', type: 'comment', z: 'N' }]);
        assert.deepEqual(tabOrder(next), [...tabOrder(flows), 'N']);
        const back = removeContainer(next, 'N');
        assert.deepEqual(back, flows);
    });
});

describe('restartScope mirrors Node-RED 5', () => {
    const flows = storedFixture();
    it('a changed node restarts itself and everything wired to it, transitively', () => {
        assert.deepEqual(scopeOf(flows, edit(flows, 'A_dbg', { name: 'x' })), ['A_chain', 'A_dbg', 'A_env', 'A_inj', 'A_j', 'A_lo']);
    });
    it('a move restarts nothing', () => {
        assert.deepEqual(scopeOf(flows, edit(flows, 'A_alone', { x: 999, y: 1 })), []);
    });
    it('a tab label or info change restarts nothing; env or disabled restarts the whole tab', () => {
        assert.deepEqual(scopeOf(flows, edit(flows, 'A', { info: 'x', label: 'y' })), []);
        assert.equal(scopeOf(flows, edit(flows, 'A', { env: [] })).length, 8);
        assert.equal(scopeOf(flows, edit(flows, 'D', { disabled: false })).length, 1);
    });
    it('a subflow change restarts its instances and what they are wired to', () => {
        assert.deepEqual(scopeOf(flows, edit(flows, 'sf1fn', { name: 'x' })), ['C_sf']);
        assert.deepEqual(scopeOf(flows, edit(flows, 'SF1', { info: 'x' })), ['C_sf']);
    });
    it('a config node change restarts its users and their wired neighbours', () => {
        assert.deepEqual(scopeOf(flows, edit(flows, 'px1', { url: 'http://other.invalid' })), ['B_chain', 'B_http', 'px1']);
    });
    it('a group change restarts its members', () => {
        assert.deepEqual(scopeOf(flows, edit(flows, 'A_grp', { name: 'renamed' })), ['A_alone', 'A_grp']);
    });
    it('a global-config change is a full restart', () => {
        assert.equal(restartScope(flows, edit(flows, 'gc', { env: [] })).fullRestart, true);
    });
    it('describeScope groups by tab', () => {
        const scope = restartScope(flows, edit(flows, 'A_dbg', { name: 'x' }));
        assert.deepEqual(describeScope(flows, scope).restarts, [{ flow: 'A', label: 'Tab A', nodes: 6 }]);
    });
});

describe('summarize and searchNodes', () => {
    const flows = storedFixture();
    it('lists tabs in order with counts and problems', () => {
        const s = summarize(flows, new Map([
            ['A_env', { fill: 'red' }],
            ['B_http', { fill: 'green' }],
            ['C_sf-sf1fn', { fill: 'yellow' }],
            ['D_alone', { fill: 'red' }],
            ['deleted', { fill: 'red' }],
        ]));
        assert.deepEqual(s.tabs.map((t) => t.id), ['A', 'B', 'C', 'D', 'E']);
        assert.equal(s.tabs[0].problems, 1);
        assert.equal(s.tabs[1].problems, undefined);
        assert.equal(s.tabs[2].problems, 1, 'a node inside a subflow instance counts for its tab');
        assert.equal(s.tabs[3].problems, undefined, 'a disabled tab has only leftovers');
        assert.equal(s.tabs[3].disabled, true);
        assert.equal(s.tabs[4].locked, true);
        assert.deepEqual(s.subflows, [{ id: 'SF1', name: 'Sub 1', nodes: 1, instances: 1, info: undefined }]);
    });
    it('resolves statuses and marks leftovers stale', () => {
        const index = indexFlows(flows);
        assert.deepEqual(pick(resolveStatus(index, 'C_sf-sf1fn')), { node: 'sf1fn', tab: 'C', instance: 'C_sf', stale: false });
        assert.deepEqual(pick(resolveStatus(index, 'D_alone')), { node: 'D_alone', tab: 'D', instance: undefined, stale: true });
        assert.deepEqual(pick(resolveStatus(index, 'deleted')), { node: undefined, tab: undefined, instance: undefined, stale: true });
    });
    it('finds by function code and caps', () => {
        const r = searchNodes(flows, { query: 'env.get', limit: 10 });
        assert.deepEqual(r.hits.map((h) => [h.id, h.matched]), [['A_env', 'func']]);
        const capped = searchNodes(flows, { type: 'function', limit: 2 });
        assert.equal(capped.hits.length, 2);
        assert.equal(capped.truncated, true);
    });
});
