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
    it('leaves out disabled node sets', () => {
        const t = installedTypesFrom([{ types: ['a', 'b'], enabled: true }, { types: ['c'], enabled: false }]);
        assert.deepEqual([...t].sort(), ['a', 'b']);
    });
});
