import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compareIssues, installedTypesFrom, validateFlows } from '../../src/validate.js';
import { INSTALLED_TYPES, storedFixture } from '../support/fixture.js';

const types = new Set(INSTALLED_TYPES);
const codes = (issues) => issues.map((i) => `${i.code}:${i.id}`).sort();
const withNode = (node) => [...storedFixture(), node];

describe('validateFlows', () => {
    it('accepts the fixture', () => {
        assert.deepEqual(validateFlows(storedFixture(), types), []);
    });
    it('refuses what would break a deploy', () => {
        const cases = [
            [{ id: 'A_env', type: 'comment', z: 'A' }, 'duplicate-id:A_env'],
            [{ id: 'x', type: 'no-such-type', z: 'A' }, 'unknown-type:x'],
            [{ id: 'x', type: 'subflow:nope', z: 'A' }, 'unknown-subflow:x'],
            [{ id: 'x', type: 'comment', z: 'nowhere' }, 'unknown-container:x'],
            [{ id: 'x', type: 'debug', z: 'A', wires: [['missing']] }, 'wire-missing:x'],
            [{ id: 'x', type: 'debug', z: 'A', wires: [['B_alone']] }, 'wire-cross-flow:x'],
            [{ id: 'x', type: 'debug', z: 'A', wires: 'B_alone' }, 'bad-wires:x'],
            [{ id: 'x', type: 'debug', z: 'A', g: 'nope' }, 'group-missing:x'],
            [{ id: 'x', type: 'group', z: 'A', nodes: ['B_alone'] }, 'group-member-missing:x'],
            [{ id: 'x', type: 'debug', z: 'A', credentials: { a: 1 } }, 'credentials:x'],
            [{ id: 'x', type: 'function', z: 'A', libs: [{ var: 'm', module: 'some-module' }] }, 'external-modules:x'],
            [{ id: 'x', type: 'exec', z: 'A' }, 'exec:x'],
            [{ id: 'x', type: 'group', z: 'A', g: 'x' }, 'group-cycle:x'],
            [{ id: 'x', type: 'subflow:SF1', z: 'A', env: [{ name: 'S', type: 'cred', value: 'plain' }] }, 'cred-env:x'],
            [{ id: 'x', type: 'group', z: 'A', env: [{ name: 'S', type: 'cred', value: 'plain' }] }, 'cred-env:x'],
        ];
        for (const [node, expected] of cases) {
            assert.deepEqual(codes(validateFlows(withNode(node), types)), [expected], expected);
        }
    });
    it('warns about a dangling link but does not refuse it', () => {
        const issues = validateFlows(withNode({ id: 'x', type: 'link out', z: 'A', links: ['gone'] }), types);
        assert.deepEqual(issues.map((i) => [i.level, i.code]), [['warning', 'link-missing']]);
    });
    it('checks subflow ports', () => {
        const flows = storedFixture().map((o) => (o.id === 'SF1' ? { ...o, out: [{ wires: [{ id: 'A_env' }] }] } : o));
        assert.deepEqual(codes(validateFlows(flows, types)), ['subflow-port-missing:SF1']);
    });
    it('skips the type check without a type list', () => {
        assert.deepEqual(validateFlows(withNode({ id: 'x', type: 'anything', z: 'A' }), null), []);
    });
});

describe('cycles and code', () => {
    it('refuses a two-group cycle', () => {
        const flows = [...storedFixture(), { id: 'g1', type: 'group', z: 'A', g: 'g2' }, { id: 'g2', type: 'group', z: 'A', g: 'g1' }];
        assert.deepEqual(codes(validateFlows(flows, types)), ['group-cycle:g1', 'group-cycle:g2']);
    });
    it('refuses a subflow that contains itself, directly or through another', () => {
        const direct = [...storedFixture(), { id: 'self', type: 'subflow:SF1', z: 'SF1' }];
        assert.deepEqual(codes(validateFlows(direct, types)), ['subflow-cycle:SF1']);
        const indirect = [
            ...storedFixture(),
            { id: 'SF2', type: 'subflow', name: 'two', in: [], out: [] },
            { id: 'i1', type: 'subflow:SF2', z: 'SF1' },
            { id: 'i2', type: 'subflow:SF1', z: 'SF2' },
        ];
        assert.deepEqual(codes(validateFlows(indirect, types)), ['subflow-cycle:SF1', 'subflow-cycle:SF2']);
    });
    it('keeps an existing libs entry editable, and refuses a new module on it', () => {
        const lib = (modules) => ({ id: 'L', type: 'function', z: 'A', libs: modules.map((m) => ({ var: m, module: m })) });
        const before = validateFlows([...storedFixture(), lib(['a'])], types);
        assert.deepEqual(compareIssues(before, validateFlows([...storedFixture(), { ...lib(['a']), name: 'renamed' }], types)).errors, []);
        assert.deepEqual(codes(compareIssues(before, validateFlows([...storedFixture(), lib(['a', 'b'])], types)).errors), ['external-modules:L']);
    });
    it('refuses a cred env value on a tab and a subflow definition', () => {
        const flows = storedFixture().map((o) => (o.id === 'A' || o.id === 'SF1' ? { ...o, env: [{ name: 'S', type: 'cred', value: 'plain' }] } : o));
        assert.deepEqual(codes(validateFlows(flows, types)), ['cred-env:A', 'cred-env:SF1']);
    });
});

describe('compareIssues', () => {
    it('refuses only what the change introduces', () => {
        const broken = withNode({ id: 'old', type: 'debug', z: 'B', wires: [['missing']] });
        const before = validateFlows(broken, types);
        const after = validateFlows([...broken, { id: 'new', type: 'debug', z: 'A', wires: [['missing2']] }], types);
        const { errors, warnings } = compareIssues(before, after);
        assert.deepEqual(codes(errors), ['wire-missing:new']);
        assert.deepEqual(warnings.map((w) => [w.id, w.preexisting]), [['old', true]]);
    });
});

describe('installedTypesFrom', () => {
    it('leaves out disabled node sets and sets that failed to load', () => {
        const t = installedTypesFrom([{ types: ['a', 'b'], enabled: true }, { types: ['c'], enabled: false }, { types: ['d'], enabled: true, err: 'Error: cannot find module' }]);
        assert.deepEqual([...t].sort(), ['a', 'b']);
    });
});
