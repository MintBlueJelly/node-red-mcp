// Pure functions over Node-RED's flat flow array (`GET /flows`, API v2). Nothing here talks to
// Node-RED, so everything a write does to the array can be tested without a runtime.
import { createHash, randomBytes } from 'node:crypto';
import { deployScope } from './diff.js';

export const CONTAINER_TYPES = new Set(['tab', 'subflow']);

// Keys `update_flow` may change on a tab. Everything else on the tab object is carried over as it
// is, which is what stops a write from clearing `locked` or a key Node-RED adds later.
export const TAB_KEYS = ['label', 'info', 'disabled', 'env'];

// The subflow definition's own keys a write may change; `id` and `type` never move.
export const SUBFLOW_KEYS = ['name', 'info', 'category', 'in', 'out', 'env', 'meta', 'color', 'inputLabels',
    'outputLabels', 'icon', 'status'];

/** Stable JSON: object keys sorted at every level, so key order never counts as a change. */
export function canonical(value) {
    return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value && typeof value === 'object') {
        const out = {};
        for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
        return out;
    }
    return value;
}

export function etagOf(objects) {
    return createHash('sha256').update(canonical(objects)).digest('hex').slice(0, 16);
}

export function newId() {
    return randomBytes(8).toString('hex');
}

/** Index of a flow array: containers in order, members by container, and lookups by id. */
export function indexFlows(flows) {
    const byId = new Map();
    const tabs = [];
    const subflows = [];
    const globals = [];
    const members = new Map();
    for (const obj of flows) {
        byId.set(obj.id, obj);
        if (obj.type === 'tab') tabs.push(obj);
        else if (obj.type === 'subflow') subflows.push(obj);
        else if (!obj.z) globals.push(obj);
        if (obj.z) {
            if (!members.has(obj.z)) members.set(obj.z, []);
            members.get(obj.z).push(obj);
        }
    }
    return { byId, tabs, subflows, globals, members, membersOf: (id) => members.get(id) ?? [] };
}

/** The container object followed by its members, in array order: the unit an etag covers. */
export function containerObjects(index, id) {
    const container = index.byId.get(id);
    if (!container) return null;
    if (CONTAINER_TYPES.has(container.type)) return [container, ...index.membersOf(id)];
    return [container];
}

/** Display name of whatever an id refers to, for results a person reads. */
export function labelOf(obj) {
    if (!obj) return undefined;
    return obj.label ?? obj.name ?? undefined;
}

function firstLine(text, max = 120) {
    if (typeof text !== 'string' || !text.trim()) return undefined;
    const line = text.trim().split(/\r?\n/)[0];
    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * Resolves a status id to its node and tab. A node inside a subflow instance runs as
 * `<instance>-<node>`, and inside nested instances as `<outer>-<inner>-<node>`; `instance` is then
 * the chain of instance ids, outermost first, joined by `/`. `stale` marks what Node-RED still
 * replays but no running node can have set: the status of a deleted node, of a node in a disabled
 * tab, or under the own id of a node in a subflow definition, which never runs as itself.
 */
export function resolveStatus(index, id) {
    const direct = index.byId.get(id);
    if (direct) {
        const container = direct.z ? index.byId.get(direct.z) : undefined;
        const template = container?.type === 'subflow';
        const flowDisabled = container?.type === 'tab' && Boolean(container.disabled);
        return { node: direct, tab: direct.z, instance: undefined, unknownNode: false, template, flowDisabled, stale: template || flowDisabled };
    }
    const chain = [];
    let rest = id;
    let scope = null;
    let node;
    search: for (;;) {
        for (let i = rest.indexOf('-'); i > 0; i = rest.indexOf('-', i + 1)) {
            const candidate = index.byId.get(rest.slice(0, i));
            const inScope = scope === null ? index.byId.get(candidate?.z)?.type === 'tab' : candidate?.z === scope;
            if (candidate?.type?.startsWith('subflow:') && inScope) {
                chain.push(candidate.id);
                scope = candidate.type.slice(8);
                rest = rest.slice(i + 1);
                const inner = index.byId.get(rest);
                if (inner?.z === scope) {
                    node = inner;
                    break search;
                }
                continue search;
            }
        }
        break;
    }
    const tab = chain.length ? index.byId.get(chain[0]).z : undefined;
    const flowDisabled = Boolean(tab && index.byId.get(tab)?.disabled);
    return { node, tab, instance: chain.length ? chain.join('/') : undefined, unknownNode: !node, template: false, flowDisabled, stale: !node || flowDisabled };
}

export const isProblem = (status) => ['red', 'yellow'].includes(status?.fill);

/**
 * The compact listing `list_flows` returns. `problems` counts the nodes of a running tab, inside its
 * subflow instances too, whose current status is red or yellow — the cheapest signal of where to
 * look first.
 */
export function summarize(flows, statuses = new Map()) {
    const index = indexFlows(flows);
    const problems = new Map();
    for (const [id, status] of statuses) {
        const r = resolveStatus(index, id);
        if (!r.stale && isProblem(status)) problems.set(r.tab, (problems.get(r.tab) ?? 0) + 1);
    }
    const problemsIn = (id) => problems.get(id) ?? 0;
    const instancesOf = (sfId) => flows.filter((n) => n.type === `subflow:${sfId}`).length;
    return {
        tabs: index.tabs.map((t) => ({
            id: t.id,
            label: t.label,
            disabled: Boolean(t.disabled) || undefined,
            locked: Boolean(t.locked) || undefined,
            nodes: index.membersOf(t.id).length,
            problems: problemsIn(t.id) || undefined,
            info: firstLine(t.info),
        })),
        subflows: index.subflows.map((s) => ({
            id: s.id,
            name: s.name,
            nodes: index.membersOf(s.id).length,
            instances: instancesOf(s.id),
            info: firstLine(s.info),
        })),
        configNodes: index.globals.length,
    };
}

/** Matches ids, types, names, labels, info and function code; returns locations, never bodies. */
export function searchNodes(flows, { query, type, flowId, limit }) {
    const index = indexFlows(flows);
    const q = query?.toLowerCase();
    const fields = ['id', 'name', 'label', 'info', 'topic', 'func', 'initialize', 'finalize', 'url'];
    const hits = [];
    let total = 0;
    for (const obj of flows) {
        if (type && obj.type !== type) continue;
        if (flowId && obj.z !== flowId && obj.id !== flowId) continue;
        let matched;
        if (q) {
            matched = fields.find((f) => typeof obj[f] === 'string' && obj[f].toLowerCase().includes(q));
            if (!matched) continue;
        }
        total += 1;
        if (hits.length >= limit) continue;
        const container = obj.z ? index.byId.get(obj.z) : undefined;
        hits.push({
            id: obj.id,
            type: obj.type,
            name: labelOf(obj) || undefined,
            flow: obj.z,
            flowLabel: labelOf(container),
            matched: matched && matched !== 'name' && matched !== 'label' ? matched : undefined,
        });
    }
    return { hits, total, truncated: total > hits.length || undefined };
}

/**
 * Replaces the objects of one container in the array, in place: an existing object keeps its
 * position, a removed one is dropped, a new one goes after the container's last member. Everything
 * outside the container is left byte-identical, which `assertOnlyContainerChanged` then checks.
 */
export function replaceContainer(flows, id, nextObjects) {
    const ownIds = new Set(containerIds(flows, id));
    const nextById = new Map(nextObjects.map((o) => [o.id, o]));
    const placed = new Set();
    const out = [];
    let lastOwnIndex = -1;
    for (const obj of flows) {
        if (!ownIds.has(obj.id)) {
            out.push(obj);
            continue;
        }
        if (nextById.has(obj.id)) {
            out.push(nextById.get(obj.id));
            placed.add(obj.id);
            lastOwnIndex = out.length - 1;
        }
    }
    const added = nextObjects.filter((o) => !placed.has(o.id));
    if (lastOwnIndex === -1) out.push(...added);
    else out.splice(lastOwnIndex + 1, 0, ...added);
    return out;
}

function containerIds(flows, id) {
    return flows.filter((o) => o.id === id || o.z === id).map((o) => o.id);
}

/** Inserts a new tab after the last existing tab, so it opens last in the editor. */
export function insertTab(flows, tab, members) {
    let lastTab = -1;
    flows.forEach((o, i) => { if (o.type === 'tab') lastTab = i; });
    const out = [...flows];
    out.splice(lastTab + 1, 0, tab);
    out.push(...members);
    return out;
}

export function removeContainer(flows, id) {
    return flows.filter((o) => o.id !== id && o.z !== id);
}

/** Throws unless every object outside `allowedIds` is identical before and after. */
export function assertOnlyContainerChanged(before, after, allowedIds) {
    const outside = (flows) => flows.filter((o) => !allowedIds.has(o.id)).map(canonical);
    const a = outside(before);
    const b = outside(after);
    if (a.length !== b.length || a.some((s, i) => s !== b[i])) {
        throw new Error('internal check failed: the write would change objects outside its target');
    }
}

/**
 * What a write restarts, per flow, in tab order with the global config nodes last. The scope comes
 * from `deployScope`, which follows Node-RED's own diff; see `src/diff.js`.
 */
export function describeScope(before, after) {
    const scope = deployScope(before, after);
    const order = [...after, ...before].filter((o) => o.type === 'tab').map((o) => o.id);
    const rank = (id) => (id === 'global' ? Infinity : order.indexOf(id));
    const label = (id) => (id === 'global' ? 'global config nodes' : labelOf(after.find((o) => o.id === id) ?? before.find((o) => o.id === id)));
    const restarts = [...scope.flows]
        .sort(([a], [b]) => rank(a) - rank(b))
        .map(([flow, ids]) => ({ flow, label: label(flow), nodes: ids.size }));
    return { fullRestart: scope.fullRestart || undefined, restarts };
}
