// What a "modified flows" deploy changes, computed the way Node-RED does it. This follows
// `diffConfigs` and `diffNodes` in `@node-red/runtime/lib/flows/util.js` (Node-RED, Apache License
// 2.0) step by step, and `test/unit/diff.test.js` checks it against that function over generated
// changes. Keep the plain objects: Node-RED looks ids up with `changed[node[prop]]`, so a
// one-element array matches its element, and the result depends on that coercion.

function compareObjects(a, b) {
    if (a === b) return true;
    if (a == null || b == null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => compareObjects(v, b[i]));
    if (typeof a !== 'object' || typeof b !== 'object') return false;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((k) => compareObjects(a[k], b[k]));
}

function diffNodes(oldNode, newNode) {
    if (oldNode == null) return true;
    const keyFilter = (p) => p !== 'x' && p !== 'y' && p !== 'wires';
    const groupKeyFilter = (p) => keyFilter(p) && p !== 'nodes' && p !== 'style' && p !== 'w' && p !== 'h';
    const oldKeys = Object.keys(oldNode).filter(oldNode.type === 'group' ? groupKeyFilter : keyFilter);
    const newKeys = Object.keys(newNode).filter(newNode.type === 'group' ? groupKeyFilter : keyFilter);
    if (oldKeys.length !== newKeys.length) return true;
    return newKeys.some((p) => !compareObjects(oldNode[p], newNode[p]));
}

// The parts of `parseConfig` the diff reads. A node whose container does not exist gets a stand-in
// tab, as Node-RED gives it one.
function parse(config) {
    const allNodes = {};
    const flows = {};
    const subflows = {};
    for (const n of config) {
        allNodes[n.id] = structuredClone(n);
        if (n.type === 'tab') flows[n.id] = n;
        else if (n.type === 'subflow') subflows[n.id] = n;
    }
    for (const n of config) {
        if (n.type !== 'subflow' && n.type !== 'tab' && n.type !== 'group' && n.z && !subflows[n.z] && !flows[n.z]) {
            flows[n.z] = { type: 'tab', id: n.z };
        }
    }
    return { allNodes, flows };
}

/**
 * @returns {{added: string[], changed: string[], removed: string[], rewired: string[], linked: string[],
 *   flowChanged: string[], globalConfigChanged: boolean}}
 */
export function diffFlows(before, after) {
    const oldConfig = parse(before);
    const newConfig = parse(after);
    const changedSubflows = {};
    const added = {};
    const removed = {};
    const changed = {};
    const flowChanged = {};
    const wiringChanged = {};
    let globalConfigChanged = false;
    const linkMap = {};
    const allNestedGroups = [];
    const has = (obj, id) => Object.prototype.hasOwnProperty.call(obj, id);

    for (const id in oldConfig.flows) {
        if (!has(newConfig.flows, id)) removed[id] = oldConfig.allNodes[id];
    }
    for (const id in oldConfig.flows) {
        if (has(newConfig.flows, id)) {
            const was = oldConfig.flows[id].disabled || false;
            const is = newConfig.flows[id].disabled || false;
            if (was !== is) {
                if (was) added[id] = oldConfig.allNodes[id];
                else removed[id] = oldConfig.allNodes[id];
            }
        }
    }

    const markContainer = (node, set, setName) => {
        const container = newConfig.allNodes[node.z];
        if (!container) return;
        changed[node.z] = container;
        if (container.type === 'subflow') {
            changedSubflows[node.z] = container;
            if (setName) delete set[node.id];
        }
    };

    for (const id in oldConfig.allNodes) {
        const node = oldConfig.allNodes[id];
        if (node.type !== 'tab') {
            if (node.wires) {
                linkMap[node.id] = linkMap[node.id] || [];
                for (const port of node.wires) {
                    for (const target of port) {
                        linkMap[node.id].push(target);
                        const nn = oldConfig.allNodes[target];
                        if (nn) {
                            linkMap[nn.id] = linkMap[nn.id] || [];
                            linkMap[nn.id].push(node.id);
                        }
                    }
                }
            }
            if (removed[node.z] || !has(newConfig.allNodes, id)) {
                removed[id] = node;
                if (!removed[node.z] && newConfig.allNodes[node.z]) markContainer(node, null, null);
            } else if (added[node.z]) {
                added[id] = node;
            } else {
                const next = newConfig.allNodes[id];
                if (!node.d && next.d) removed[id] = node;
                if (diffNodes(node, next) || next.credentials) {
                    changed[id] = next;
                    if (next.type === 'subflow') changedSubflows[id] = next;
                    markContainer(next, changed, 'changed');
                    if (next.type === 'global-config') globalConfigChanged = true;
                }
                if (!compareObjects(node.wires, next.wires)) {
                    wiringChanged[id] = next;
                    markContainer(next, wiringChanged, 'wiringChanged');
                }
            }
        } else if (!removed[id]) {
            if (JSON.stringify(node.env) !== JSON.stringify(newConfig.allNodes[id].env)) flowChanged[id] = newConfig.allNodes[id];
        }
    }

    for (const id in newConfig.allNodes) {
        const node = newConfig.allNodes[id];
        if (node.type === 'group') {
            if (node.g) allNestedGroups.push(node);
            if (changed[node.id] && node.nodes) {
                for (const nid of node.nodes) if (!changed[nid]) changed[nid] = true;
            }
        }
        if (node.wires) {
            linkMap[node.id] = linkMap[node.id] || [];
            for (const port of node.wires) {
                for (const target of port) {
                    if (!linkMap[node.id].includes(target)) linkMap[node.id].push(target);
                    const nn = newConfig.allNodes[target];
                    if (nn) {
                        linkMap[nn.id] = linkMap[nn.id] || [];
                        if (!linkMap[nn.id].includes(node.id)) linkMap[nn.id].push(node.id);
                    }
                }
            }
        }
        if (!has(oldConfig.allNodes, id)) {
            added[id] = node;
            markContainer(node, added, 'added');
        }
    }

    // References to changed or removed nodes, repeated until nothing more changes.
    let madeChange;
    do {
        madeChange = false;
        for (const id in newConfig.allNodes) {
            const node = newConfig.allNodes[id];
            for (const prop in node) {
                if (!has(node, prop) || prop === 'z' || prop === 'id' || prop === 'wires') continue;
                const changeOrigin = changed[node[prop]];
                if (!(changeOrigin || removed[node[prop]]) || changed[node.id]) continue;
                if (changeOrigin && prop === 'g' && changeOrigin.type === 'group') {
                    const oldNode = oldConfig.allNodes[node.id];
                    if (oldNode && node.g === oldNode.g) continue;
                }
                madeChange = true;
                changed[node.id] = node;
                if (newConfig.allNodes[node.z]) {
                    changed[node.z] = newConfig.allNodes[node.z];
                    if (changed[node.z].type === 'subflow') changedSubflows[node.z] = changed[node.z];
                }
            }
        }
    } while (madeChange);

    // Nodes on a subflow template never run; the changed subflow stands for them.
    for (const id in newConfig.allNodes) {
        const node = newConfig.allNodes[id];
        if (newConfig.allNodes[node.z] && newConfig.allNodes[node.z].type === 'subflow') delete changed[node.id];
    }

    do {
        madeChange = false;
        for (const group of allNestedGroups) {
            if (!changed[group.id] && group.g && changed[group.g]) {
                changed[group.id] = true;
                madeChange = true;
            }
            if (changed[group.id] && group.nodes) {
                for (const nid of group.nodes) {
                    if (!changed[nid]) {
                        changed[nid] = true;
                        madeChange = true;
                    }
                }
            }
        }
    } while (madeChange);

    // Instances of changed subflows; an instance inside another subflow changes that subflow in turn.
    const stack = Object.keys(changedSubflows);
    while (stack.length > 0) {
        const subflowId = stack.pop();
        for (const id in newConfig.allNodes) {
            const node = newConfig.allNodes[id];
            if (node.type !== `subflow:${subflowId}` || changed[node.id]) continue;
            changed[node.id] = node;
            if (!changed[node.z] && newConfig.allNodes[node.z]) {
                changed[node.z] = newConfig.allNodes[node.z];
                if (newConfig.allNodes[node.z].type === 'subflow') {
                    stack.push(node.z);
                    delete changed[node.id];
                }
            }
        }
    }

    const diff = {
        added: Object.keys(added),
        changed: Object.keys(changed),
        removed: Object.keys(removed),
        rewired: Object.keys(wiringChanged),
        linked: [],
        flowChanged: Object.keys(flowChanged),
        globalConfigChanged,
    };
    let modified = [...diff.added, ...diff.changed, ...diff.removed, ...diff.rewired];
    const visited = {};
    while (modified.length > 0) {
        const node = modified.pop();
        if (visited[node]) continue;
        visited[node] = true;
        if (linkMap[node]) {
            if (!changed[node] && !added[node] && !removed[node] && !wiringChanged[node]) diff.linked.push(node);
            modified = modified.concat(linkMap[node]);
        }
    }
    return diff;
}

/**
 * The nodes a `flows`-type deploy stops or starts, grouped by the flow they run in, as `stop` and
 * `start` in `@node-red/runtime/lib/flows/index.js` apply a diff: every node of a tab that is added,
 * removed or whose env changed, otherwise the changed, removed, linked, rewired and added nodes.
 * Only running nodes count: nodes on enabled tabs, and global config nodes. A subflow instance counts
 * as one node; its inner nodes restart with it.
 */
export function deployScope(before, after) {
    const diff = diffFlows(before, after);
    const oldById = new Map(before.map((o) => [o.id, o]));
    const newById = new Map(after.map((o) => [o.id, o]));
    const wholeTabs = new Set([...diff.flowChanged, ...diff.added, ...diff.removed]);
    const touched = new Set([...diff.changed, ...diff.removed, ...diff.linked, ...diff.rewired, ...diff.added]);
    const runningTab = (byId, z) => byId.get(z)?.type === 'tab' && !byId.get(z).disabled;
    const isGlobalConfig = (o) => o && !o.z && !['tab', 'subflow', 'group'].includes(o.type);
    const scope = new Map();
    const count = (flow, id) => {
        if (!scope.has(flow)) scope.set(flow, new Set());
        scope.get(flow).add(id);
    };
    for (const byId of [oldById, newById]) {
        for (const obj of byId.values()) {
            if (obj.type === 'tab' || obj.type === 'subflow' || obj.d) continue;
            if (isGlobalConfig(obj)) {
                if (touched.has(obj.id)) count('global', obj.id);
                continue;
            }
            if (!runningTab(byId, obj.z) || obj.type === 'group') continue;
            if (wholeTabs.has(obj.z) || touched.has(obj.id)) count(obj.z, obj.id);
        }
    }
    return { fullRestart: diff.globalConfigChanged, flows: scope };
}
