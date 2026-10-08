// Pure functions over Node-RED's flat flow array (`GET /flows`, API v2). Nothing here talks to
// Node-RED, so everything a write does to the array can be tested without a runtime.
import { createHash, randomBytes } from 'node:crypto';

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
 * Resolves a status id to its node and tab, including the `<instance>-<node>` ids of nodes inside a
 * subflow instance. `stale` marks what Node-RED still replays but no running node can have set: the
 * status of a deleted node, or of a node in a disabled tab.
 */
export function resolveStatus(index, id) {
    let node = index.byId.get(id);
    let tab = node?.z;
    let instance;
    if (!node) {
        for (let i = id.indexOf('-'); i > 0; i = id.indexOf('-', i + 1)) {
            const candidate = index.byId.get(id.slice(0, i));
            if (candidate?.type?.startsWith('subflow:')) {
                instance = candidate.id;
                tab = candidate.z;
                node = index.byId.get(id.slice(i + 1));
                break;
            }
        }
    }
    const container = tab ? index.byId.get(tab) : undefined;
    return { node, tab, instance, unknownNode: !node, flowDisabled: Boolean(container?.disabled), stale: !node || Boolean(container?.disabled) };
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
 * What Node-RED 5 restarts for a `flows`-type deploy, mirroring `diffConfigs` and `stop` in
 * `@node-red/runtime/lib/flows`: changed, added, removed and rewired nodes, the nodes that use a
 * changed config node, the instances of a changed subflow, the members of a changed group, every
 * node of a tab whose `env` or `disabled` changed — and then everything transitively wired to any of
 * them. A changed `global-config` node restarts everything.
 */
export function restartScope(before, after) {
    const oldById = new Map(before.map((o) => [o.id, o]));
    const newById = new Map(after.map((o) => [o.id, o]));
    const restarting = new Set();
    const changed = new Set();
    let fullRestart = false;

    for (const [id, obj] of newById) {
        const old = oldById.get(id);
        if (obj.type === 'tab') {
            if (!old || Boolean(old.disabled) !== Boolean(obj.disabled) || canonical(old.env) !== canonical(obj.env)) {
                for (const m of after) if (m.z === id) restarting.add(m.id);
            }
            continue;
        }
        if (!old || nodeChanged(old, obj) || canonical(old.wires) !== canonical(obj.wires)) changed.add(id);
        if (obj.type === 'global-config' && old && nodeChanged(old, obj)) fullRestart = true;
    }
    for (const [id, old] of oldById) if (!newById.has(id) && old.type !== 'tab') changed.add(id);

    const changedSubflows = new Set();
    for (const id of changed) {
        const obj = newById.get(id) ?? oldById.get(id);
        if (obj.type === 'subflow') changedSubflows.add(id);
        const parent = obj.z && (newById.get(obj.z) ?? oldById.get(obj.z));
        if (parent?.type === 'subflow') changedSubflows.add(parent.id);
    }
    for (const obj of after) {
        if (CONTAINER_TYPES.has(obj.type)) continue;
        const inTab = obj.z && newById.get(obj.z)?.type === 'tab';
        if (changed.has(obj.id) && (inTab || !obj.z)) restarting.add(obj.id);
        if (obj.type.startsWith('subflow:') && changedSubflows.has(obj.type.slice(8))) restarting.add(obj.id);
        if (references(obj, changed)) restarting.add(obj.id);
        if (obj.type === 'group' && changed.has(obj.id)) for (const m of obj.nodes ?? []) restarting.add(m);
    }

    const links = wireGraph(before, after);
    const queue = [...restarting, ...[...changed].filter((id) => !newById.has(id))];
    while (queue.length) {
        const id = queue.pop();
        for (const next of links.get(id) ?? []) {
            if (!restarting.has(next)) {
                restarting.add(next);
                queue.push(next);
            }
        }
    }
    return { fullRestart, nodes: [...restarting].filter((id) => newById.has(id)) };
}

// `diffNodes`: layout and wiring are not a change of the node itself; a group's membership, style
// and size are not either.
function nodeChanged(old, obj) {
    const ignore = obj.type === 'group' ? new Set(['x', 'y', 'wires', 'nodes', 'style', 'w', 'h']) : new Set(['x', 'y', 'wires']);
    const strip = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !ignore.has(k)));
    return canonical(strip(old)) !== canonical(strip(obj));
}

function references(obj, ids) {
    if (!ids.size) return false;
    return Object.entries(obj).some(([key, value]) => key !== 'id' && key !== 'z' && typeof value === 'string' && ids.has(value));
}

function wireGraph(...flowSets) {
    const graph = new Map();
    const link = (a, b) => {
        if (!graph.has(a)) graph.set(a, new Set());
        if (!graph.has(b)) graph.set(b, new Set());
        graph.get(a).add(b);
        graph.get(b).add(a);
    };
    for (const flows of flowSets) {
        for (const obj of flows) {
            if (!Array.isArray(obj.wires)) continue;
            for (const port of obj.wires) {
                if (Array.isArray(port)) for (const target of port) link(obj.id, target);
            }
        }
    }
    return graph;
}

/** Groups the restarting node ids by tab, for a result a person can act on. */
export function describeScope(flows, scope) {
    const index = indexFlows(flows);
    const byTab = new Map();
    for (const id of scope.nodes) {
        const obj = index.byId.get(id);
        const tab = obj?.z && index.byId.get(obj.z);
        if (!tab || tab.type !== 'tab') continue;
        if (!byTab.has(tab.id)) byTab.set(tab.id, { flow: tab.id, label: tab.label, nodes: 0 });
        byTab.get(tab.id).nodes += 1;
    }
    return { fullRestart: scope.fullRestart || undefined, restarts: [...byTab.values()] };
}
