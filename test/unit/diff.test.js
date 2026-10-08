// Differential test: `diffFlows` against Node-RED's own `diffConfigs`, loaded from the pinned
// devDependency, over every change the generator below can make to two fixtures.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { deployScope, diffFlows } from '../../src/diff.js';
import { storedFixture } from '../support/fixture.js';
import { scopeFlows } from '../support/scope-fixture.js';

const require = createRequire(import.meta.url);
const nodeRed = require('@node-red/runtime/lib/flows/util.js');

function reference(before, after) {
    return nodeRed.diffConfigs(nodeRed.parseConfig(structuredClone(before)), nodeRed.parseConfig(structuredClone(after)));
}

const FIELDS = ['added', 'changed', 'removed', 'rewired', 'linked', 'flowChanged'];
const normalize = (d) => ({ ...Object.fromEntries(FIELDS.map((f) => [f, [...d[f]].sort()])), globalConfigChanged: d.globalConfigChanged });

function* mutations(flows) {
    const edit = (o, patch) => flows.map((x) => (x === o ? { ...x, ...patch } : x));
    for (const o of flows) {
        if (o.type === 'tab') {
            yield [`relabel tab ${o.id}`, edit(o, { label: `${o.label}*`, info: 'changed' })];
            yield [`change env of tab ${o.id}`, edit(o, { env: [...(o.env ?? []), { name: 'MUT', value: '1', type: 'str' }] })];
            yield [`toggle tab ${o.id}`, edit(o, { disabled: !o.disabled })];
            yield [`delete tab ${o.id}`, flows.filter((x) => x.id !== o.id && x.z !== o.id)];
            yield [`add a node to tab ${o.id}`, [...flows, { id: `new-${o.id}`, type: 'function', z: o.id, name: 'n', func: '', outputs: 1, x: 1, y: 1, wires: [[]] }]];
        } else if (o.type === 'subflow') {
            yield [`change subflow ${o.id}`, edit(o, { info: 'changed' })];
            yield [`add a node to subflow ${o.id}`, [...flows, { id: `new-${o.id}`, type: 'function', z: o.id, name: 'n', func: '', outputs: 1, x: 1, y: 1, wires: [[]] }]];
        } else {
            yield [`rename ${o.id}`, edit(o, { name: `${o.name ?? ''}*` })];
            yield [`move ${o.id}`, edit(o, { x: (o.x ?? 0) + 5, y: (o.y ?? 0) + 5 })];
            yield [`remove ${o.id}`, flows.filter((x) => x.id !== o.id)];
            if (Array.isArray(o.wires)) yield [`unwire ${o.id}`, edit(o, { wires: o.wires.map(() => []) })];
            if (o.z) yield [`disable node ${o.id}`, edit(o, { d: true })];
            if (o.type === 'group') yield [`empty group ${o.id}`, edit(o, { nodes: [] })];
        }
    }
}

describe('diffFlows matches Node-RED diffConfigs', () => {
    for (const [name, fixture] of [['shipped fixture', storedFixture()], ['scope fixture', scopeFlows()]]) {
        it(`on every generated change to the ${name}`, () => {
            let cases = 0;
            for (const [label, after] of mutations(fixture)) {
                assert.deepEqual(normalize(diffFlows(fixture, after)), normalize(reference(fixture, after)), label);
                cases += 1;
            }
            assert.ok(cases > 50, `only ${cases} cases`);
        });
    }
});

describe('deployScope', () => {
    const flows = scopeFlows();
    const edit = (id, patch) => flows.map((o) => (o.id === id ? { ...o, ...patch } : o));
    const tabs = (before, after) => Object.fromEntries([...deployScope(before, after).flows].map(([k, v]) => [k, [...v].sort()]));

    it('a config node used by another config node restarts that one\'s users and their chain', () => {
        assert.deepEqual(tabs(flows, edit('T1', { name: 'x' })), { global: ['M1', 'T1'], TB: ['TB_chain', 'TB_in'] });
    });
    it('the inner subflow of a nested pair restarts the outer instance and its chain', () => {
        assert.deepEqual(tabs(flows, edit('sfi_fn', { name: 'x' })), { TN: ['TN_chain', 'TN_sf'] });
    });
    it('a config node used only inside a subflow template restarts the instance and its chain', () => {
        assert.deepEqual(tabs(flows, edit('P1', { url: 'http://other.invalid' })), { global: ['P1'], TP: ['TP_chain', 'TP_sf'] });
    });
    it('a single-target link in restarts the chain of the link out on another tab', () => {
        assert.deepEqual(tabs(flows, edit('TL1_li', { name: 'x' })), { TL1: ['TL1_chain', 'TL1_li'], TL2: ['TL2_lo', 'TL2_up'] });
        assert.deepEqual(tabs(flows, edit('TL1_li2', { name: 'x' })), { TL1: ['TL1_li2', 'TL1_ret', 'TL1_rlo'], TL3: ['TL3_call', 'TL3_up'] });
    });
    it('disabling a tab stops all of it; a layout change restarts nothing', () => {
        assert.deepEqual(tabs(flows, edit('TX', { disabled: true })), { TX: ['TX_alone', 'TX_fn'] });
        assert.deepEqual(tabs(flows, edit('TX_alone', { x: 999 })), {});
    });
});
