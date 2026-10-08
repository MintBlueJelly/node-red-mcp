// Structural validation of a flow array. A write is refused only for problems it introduces: a
// problem that already exists elsewhere is reported as a warning and never blocks the edit.
import { CONTAINER_TYPES, indexFlows } from './flows.js';

// Not registered node types, but legal in a flow file.
const STRUCTURAL_TYPES = new Set(['tab', 'subflow', 'group']);

/**
 * @param {object[]} flows the complete flow array
 * @param {Set<string>|null} installedTypes from `GET /nodes`; null skips the type check
 * @returns {{level: 'error'|'warning', code: string, id?: string, message: string}[]}
 */
export function validateFlows(flows, installedTypes) {
    const issues = [];
    const add = (level, code, id, message) => issues.push({ level, code, id, message });
    const seen = new Map();
    for (const obj of flows) {
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
            add('error', 'not-an-object', undefined, 'every entry must be an object');
            continue;
        }
        if (typeof obj.id !== 'string' || !obj.id) add('error', 'missing-id', undefined, `a ${obj.type ?? 'node'} has no id`);
        if (typeof obj.type !== 'string' || !obj.type) add('error', 'missing-type', obj.id, `${obj.id} has no type`);
        if (typeof obj.id === 'string') {
            if (seen.has(obj.id)) add('error', 'duplicate-id', obj.id, `id ${obj.id} is used more than once`);
            seen.set(obj.id, obj);
        }
    }
    const index = indexFlows(flows.filter((o) => o && typeof o === 'object'));
    const subflowIds = new Set(index.subflows.map((s) => s.id));

    for (const obj of index.byId.values()) {
        if (typeof obj.type !== 'string') continue;
        if (obj.z !== undefined && obj.z !== '' && !CONTAINER_TYPES.has(index.byId.get(obj.z)?.type)) {
            add('error', 'unknown-container', obj.id, `${obj.id} sits in ${obj.z}, which is neither a tab nor a subflow`);
        }
        if (obj.type.startsWith('subflow:')) {
            if (!subflowIds.has(obj.type.slice(8))) add('error', 'unknown-subflow', obj.id, `${obj.id} is an instance of a subflow that does not exist`);
        } else if (installedTypes && !STRUCTURAL_TYPES.has(obj.type) && !installedTypes.has(obj.type)) {
            add('error', 'unknown-type', obj.id, `type "${obj.type}" is not installed; Node-RED would stop at "waiting for missing types"`);
        }
        if (obj.credentials !== undefined) {
            add('error', 'credentials', obj.id, `${obj.id} carries credentials; set them in the editor, never through this server`);
        }
        checkWires(obj, index, add);
        checkGroup(obj, index, add);
        checkLinks(obj, index, add);
        if (obj.type === 'subflow') checkSubflowPorts(obj, index, add);
    }
    return issues;
}

function checkWires(obj, index, add) {
    if (obj.wires === undefined) return;
    if (!Array.isArray(obj.wires) || obj.wires.some((p) => !Array.isArray(p))) {
        add('error', 'bad-wires', obj.id, `${obj.id}: wires must be an array of arrays of node ids`);
        return;
    }
    for (const target of obj.wires.flat()) {
        const t = index.byId.get(target);
        if (!t) add('error', 'wire-missing', obj.id, `${obj.id} is wired to ${target}, which does not exist`);
        else if (t.z !== obj.z) add('error', 'wire-cross-flow', obj.id, `${obj.id} is wired to ${target} in another flow; use link nodes`);
    }
}

function checkGroup(obj, index, add) {
    if (obj.g !== undefined) {
        const g = index.byId.get(obj.g);
        if (!g || g.type !== 'group' || g.z !== obj.z) add('error', 'group-missing', obj.id, `${obj.id} names group ${obj.g}, which is not a group in the same flow`);
    }
    if (obj.type === 'group' && Array.isArray(obj.nodes)) {
        for (const id of obj.nodes) {
            const m = index.byId.get(id);
            if (!m || m.z !== obj.z) add('error', 'group-member-missing', obj.id, `group ${obj.id} lists ${id}, which is not in the same flow`);
        }
    }
}

// Node-RED tolerates a dangling link, so it is a warning: the message just goes nowhere.
function checkLinks(obj, index, add) {
    if (!['link in', 'link out', 'link call'].includes(obj.type) || !Array.isArray(obj.links)) return;
    for (const id of obj.links) {
        if (!index.byId.has(id)) add('warning', 'link-missing', obj.id, `${obj.id} links to ${id}, which does not exist`);
    }
}

function checkSubflowPorts(sf, index, add) {
    const ports = [...(sf.in ?? []), ...(sf.out ?? [])];
    for (const port of ports) {
        for (const w of port.wires ?? []) {
            const target = index.byId.get(w.id);
            if (w.id !== sf.id && (!target || target.z !== sf.id)) {
                add('error', 'subflow-port-missing', sf.id, `subflow ${sf.id} has a port wired to ${w.id}, which is not inside it`);
            }
        }
    }
}

const keyOf = (i) => `${i.code}|${i.id}|${i.message}`;

/** Splits the issues of `after` into those the write introduces and those that were already there. */
export function compareIssues(before, after) {
    const old = new Set(before.map(keyOf));
    const introduced = after.filter((i) => !old.has(keyOf(i)));
    return {
        errors: introduced.filter((i) => i.level === 'error'),
        warnings: [...introduced.filter((i) => i.level === 'warning'), ...after.filter((i) => old.has(keyOf(i))).map((i) => ({ ...i, level: 'warning', preexisting: true }))],
    };
}

/** Node types Node-RED has registered, from the node sets `GET /nodes` returns. */
export function installedTypesFrom(nodeSets) {
    const types = new Set();
    for (const set of nodeSets ?? []) {
        if (set.enabled === false) continue;
        for (const t of set.types ?? []) types.add(t);
    }
    return types;
}
