// The tool surface. What is absent is deliberate: installing, removing or enabling npm modules,
// starting or stopping the runtime, deleting context and full deploys are not implemented at all.
import { z } from 'zod';
import { containerObjects, etagOf, indexFlows, isProblem, labelOf, resolveStatus, searchNodes, summarize } from './flows.js';
import { UserError } from './output.js';
import { check, plans } from './writer.js';

const READ = { readOnlyHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

const nodeList = z.array(z.record(z.string(), z.unknown()))
    .describe('Every node of the flow as Node-RED stores it (id, type, wires, properties). The list is complete: a node left out is deleted. x/y may be omitted for existing nodes. Never include credentials.');
const tabFields = {
    label: z.string().optional().describe('Name of the flow tab'),
    info: z.string().optional().describe('Markdown description of the flow'),
    disabled: z.boolean().optional().describe('true stops the flow; false makes it run'),
    env: z.array(z.record(z.string(), z.unknown())).optional().describe('Flow environment variables, [{name, value, type}]'),
};
const iso = (t) => (t ? new Date(t).toISOString() : undefined);

function flowLabel(index, id) {
    return labelOf(index.byId.get(id));
}

export function defineTools() {
    return [
        {
            name: 'list_flows',
            description: 'List the Node-RED flows (tabs) and subflows with id, label, whether disabled or locked, node count, the first line of their description, and how many nodes currently show a red or yellow status. Start here; then use get_flow for one flow.',
            annotations: READ,
            input: {},
            async handler(_args, { client, comms }) {
                const { flows } = await client.getFlows();
                return { ...summarize(flows, comms.statuses), comms: comms.state() };
            },
        },
        {
            name: 'get_flow',
            description: 'Get one Node-RED flow (tab) or subflow with all its nodes, or one global config node, plus the etag that update_flow, delete_flow and update_global require. Pass "global" for an index of global config nodes and subflows.',
            annotations: READ,
            input: { id: z.string().describe('A flow, subflow or config node id from list_flows, or "global"') },
            async handler({ id }, { client, config }) {
                const { flows } = await client.getFlows();
                const index = indexFlows(flows);
                if (id === 'global') {
                    return {
                        configNodes: index.globals.map((n) => ({ id: n.id, type: n.type, name: n.name || undefined, users: flows.filter((o) => o.id !== n.id && Object.values(o).includes(n.id)).length })),
                        subflows: index.subflows.map((s) => ({ id: s.id, name: s.name, nodes: index.membersOf(s.id).length, instances: flows.filter((o) => o.type === `subflow:${s.id}`).length })),
                    };
                }
                const objects = containerObjects(index, id);
                if (!objects) throw new UserError(`no flow, subflow or config node with id ${id}; list_flows shows the ids`);
                const [head, ...nodes] = objects;
                if (head.z) throw new UserError(`${id} is a ${head.type} in flow ${head.z}; get that flow instead`);
                if (head.type !== 'tab' && head.type !== 'subflow') return { etag: etagOf(objects), node: head };
                const result = { etag: etagOf(objects), flow: head, nodes };
                // A truncated flow cannot be written back, so it is refused whole, and without its etag:
                // a write from a partial node list would delete every node left out.
                const size = JSON.stringify(result).length;
                if (size > config.resultMaxChars - 200) {
                    throw new UserError(`flow ${id} is too large to return at once (${size} characters, ${nodes.length} nodes); find what you need with search_nodes and change this flow in the editor`);
                }
                return result;
            },
        },
        {
            name: 'search_nodes',
            description: 'Find Node-RED nodes by text (matched against id, name, label, description, topic, URL and function code), by node type, and/or by flow. Returns where each node is, not its full definition.',
            annotations: READ,
            input: {
                query: z.string().optional().describe('Text to look for, case-insensitive'),
                type: z.string().optional().describe('Exact node type, e.g. "function", "http request", "subflow:<id>"'),
                flow_id: z.string().optional().describe('Only nodes in this flow or subflow'),
                limit: z.number().int().min(1).max(100).default(25),
            },
            async handler({ query, type, flow_id: flowId, limit }, { client }) {
                if (!query && !type && !flowId) throw new UserError('pass query, type or flow_id');
                const { flows } = await client.getFlows();
                return searchNodes(flows, { query, type, flowId, limit });
            },
        },
        {
            name: 'get_node_status',
            description: 'Current status of Node-RED nodes — the coloured dot and text the editor shows under a node (e.g. "connected", "ENOTFOUND"). Filter by flow or node, or only red and yellow ones. Statuses replayed at connect, or set within a second of it, are marked retained; ones older than the last deploy beforeLastDeploy; and leftovers from deleted nodes or disabled flows stale — only_problems leaves those out.',
            annotations: READ,
            input: {
                flow_id: z.string().optional(),
                node_id: z.string().optional(),
                only_problems: z.boolean().default(false).describe('Only red and yellow statuses of running nodes'),
            },
            async handler({ flow_id: flowId, node_id: nodeId, only_problems: onlyProblems }, { client, comms }) {
                const { flows } = await client.getFlows();
                const index = indexFlows(flows);
                const statuses = [];
                for (const [id, s] of comms.statuses) {
                    const r = resolveStatus(index, id);
                    if (flowId && r.tab !== flowId) continue;
                    if (nodeId && id !== nodeId && r.node?.id !== nodeId && !r.instance?.split('/').includes(nodeId)) continue;
                    if (onlyProblems && (!isProblem(s) || r.stale)) continue;
                    statuses.push({
                        id,
                        name: labelOf(r.node) || undefined,
                        type: r.node?.type,
                        flow: r.tab,
                        flowLabel: flowLabel(index, r.tab),
                        subflowInstance: r.instance,
                        unknownNode: r.unknownNode || undefined,
                        flowDisabled: r.flowDisabled || undefined,
                        stale: r.stale || undefined,
                        fill: s.fill,
                        shape: s.shape,
                        text: s.text,
                        at: iso(s.at),
                        retained: s.retained,
                        beforeLastDeploy: s.at && comms.lastDeployAt && s.at < comms.lastDeployAt ? true : undefined,
                    });
                }
                return { statuses: statuses.slice(0, 300), more: statuses.length > 300 ? statuses.length - 300 : undefined, comms: comms.state() };
            },
        },
        {
            name: 'get_debug_messages',
            description: 'Recent Node-RED debug sidebar output: debug-node messages, node warnings and errors, and runtime events (deploys, start/stop), newest last. Pass the returned cursor next time to see only what arrived since — e.g. after trigger_inject. The buffer lives in this server and starts empty when it restarts.',
            annotations: READ,
            input: {
                flow_id: z.string().optional(),
                node_id: z.string().optional().describe('A node id; matches nodes inside subflow instances by their template id too'),
                level: z.enum(['all', 'problems', 'error', 'warn', 'debug', 'runtime']).default('all').describe('problems = warn + error'),
                cursor: z.string().optional().describe('From a previous call'),
                limit: z.number().int().min(1).max(200).default(30),
            },
            async handler({ flow_id: flowId, node_id: nodeId, level, cursor, limit }, { ring, comms }) {
                const filter = (e) => {
                    if (flowId && e.flow !== flowId) return false;
                    if (nodeId && e.id !== nodeId && e.alias !== nodeId) return false;
                    if (level === 'problems') return e.kind === 'warn' || e.kind === 'error';
                    return level === 'all' || e.kind === level;
                };
                const page = ring.read({ cursor, filter, limit });
                return {
                    ...page,
                    items: undefined,
                    messages: page.items.map(({ at, ...e }) => ({ ...e, at: iso(at) })),
                    buffer: ring.stats(),
                    comms: comms.state(),
                };
            },
        },
        {
            name: 'get_context',
            description: 'Read Node-RED context: global, one flow\'s, or one node\'s. Without key, lists the keys and values of the scope.',
            annotations: READ,
            input: {
                scope: z.enum(['global', 'flow', 'node']),
                id: z.string().optional().describe('Flow id for scope flow, node id for scope node'),
                key: z.string().optional(),
                store: z.string().optional().describe('Context store; omit for the default'),
            },
            async handler({ scope, id, key, store }, { client }) {
                if (scope !== 'global' && !id) throw new UserError(`scope ${scope} needs id`);
                return client.getContext(scope, id, key, store);
            },
        },
        {
            name: 'get_flow_state',
            description: 'Whether the Node-RED runtime is running its flows, the last runtime state event (e.g. missing node types), and when flows were last deployed.',
            annotations: READ,
            input: {},
            async handler(_args, { client, comms }) {
                return {
                    ...(await client.getFlowsState()),
                    runtime: comms.runtimeState ?? undefined,
                    lastDeploy: iso(comms.lastDeployAt),
                    comms: comms.state(),
                };
            },
        },
        {
            name: 'get_nodes',
            description: 'The node types installed in Node-RED, grouped by module with versions. A flow may only use these types.',
            annotations: READ,
            input: {},
            async handler(_args, { client }) {
                const modules = new Map();
                for (const set of await client.getNodes()) {
                    const m = modules.get(set.module) ?? { module: set.module, version: set.version, types: [] };
                    if (set.enabled === false) m.disabledSets = [...(m.disabledSets ?? []), set.name];
                    else if (set.err) m.failedSets = [...(m.failedSets ?? []), { name: set.name, error: String(set.err).slice(0, 200) }];
                    else m.types.push(...(set.types ?? []));
                    modules.set(set.module, m);
                }
                return { modules: [...modules.values()] };
            },
        },
        {
            name: 'get_settings',
            description: 'Node-RED runtime settings as the editor sees them (version, context stores, editor options).',
            annotations: READ,
            input: {},
            handler: (_args, { client }) => client.getSettings(),
        },
        {
            name: 'get_diagnostics',
            description: 'Node-RED diagnostics report: versions, Node.js, OS, memory and the settings that matter for support.',
            annotations: READ,
            input: {},
            handler: (_args, { client }) => client.getDiagnostics(),
        },
        {
            name: 'validate_flow',
            description: 'Check a Node-RED flow change without deploying it: the same checks update_flow and create_flow run (ids, wiring, groups, link nodes, cycles, installed node types; no npm modules or exec nodes), plus where nodes would restart. Pass flow_id to check an update, omit it to check a new flow.',
            annotations: READ,
            input: {
                flow_id: z.string().optional(),
                flow: z.strictObject({ ...tabFields, nodes: nodeList.optional() }),
            },
            async handler({ flow_id: flowId, flow }, { client }) {
                const { flows } = await client.getFlows();
                const plan = flowId ? plans.updateTab(flows, { id: flowId, flow }) : plans.createTab(flows, { flow });
                if (plan.unchanged) return { valid: true, unchanged: true };
                const checked = await check(client, flows, plan);
                return {
                    valid: checked.errors.length === 0 && !checked.fullRestart,
                    errors: checked.errors.length ? checked.errors : undefined,
                    warnings: checked.warnings.length ? checked.warnings : undefined,
                    restarts: checked.scope.restarts,
                    starts: plan.started || undefined,
                };
            },
        },
        {
            name: 'create_flow',
            description: 'Create a new Node-RED flow (tab) and deploy it. Refused if a flow with the same label exists. It starts running at once unless disabled is true. Nodes are wired by their ids; node ids must not exist yet.',
            annotations: { ...WRITE, destructiveHint: false },
            input: { flow: z.strictObject({ ...tabFields, label: z.string(), nodes: nodeList.optional() }) },
            handler: ({ flow }, { write }) => write((flows) => plans.createTab(flows, { flow })),
        },
        {
            name: 'update_flow',
            description: 'Change one Node-RED flow (tab) and deploy it as a modified-flows deploy; the result lists every flow where Node-RED restarts nodes, which can include other tabs reached through link or config nodes. Needs the etag from get_flow; refused if the flow changed since, or is locked in the editor. Send nodes as the complete list. Only label, info, disabled, env and nodes can change.',
            annotations: { ...WRITE, idempotentHint: true },
            input: { id: z.string(), etag: z.string().describe('From get_flow'), flow: z.strictObject({ ...tabFields, nodes: nodeList.optional() }) },
            handler: ({ id, etag, flow }, { write }) => write((flows) => plans.updateTab(flows, { id, flow }), { etag }),
        },
        {
            name: 'delete_flow',
            description: 'Delete one Node-RED flow (tab) with all its nodes. Only a disabled, unlocked flow can be deleted; disable it with update_flow first. Needs the etag from get_flow.',
            annotations: { ...WRITE, idempotentHint: true },
            input: { id: z.string(), etag: z.string().describe('From get_flow') },
            handler: ({ id, etag }, { write }) => write((flows) => plans.deleteTab(flows, { id }), { etag }),
        },
        {
            name: 'update_global',
            description: 'Change one Node-RED subflow (its definition and/or its nodes) or one global config node, and deploy. Every flow that uses it, directly or through nested subflows and config nodes, restarts the affected nodes; the result lists them. Needs the etag from get_flow. The global-config node (global environment) cannot be changed here.',
            annotations: { ...WRITE, idempotentHint: true },
            input: {
                id: z.string().describe('Subflow or global config node id'),
                etag: z.string().describe('From get_flow'),
                subflow: z.record(z.string(), z.unknown()).optional().describe('Subflow keys to change: name, info, category, in, out, env, meta, color, inputLabels, outputLabels, icon, status'),
                nodes: nodeList.optional(),
                node: z.record(z.string(), z.unknown()).optional().describe('For a config node: the complete node object'),
            },
            handler: ({ id, etag, subflow, nodes, node }, { write }) => write((flows) => plans.updateGlobal(flows, { id, subflow, nodes, node }), { etag }),
        },
        {
            name: 'set_debug_state',
            description: 'Switch one Node-RED debug node on or off in the running flow. Not saved: the next deploy that restarts the node sets it back to its configured state.',
            annotations: { ...WRITE, destructiveHint: false, idempotentHint: true },
            input: { node_id: z.string(), enabled: z.boolean() },
            async handler({ node_id: nodeId, enabled }, { client }) {
                await client.setDebugState(nodeId, enabled);
                return { node: nodeId, enabled };
            },
        },
        {
            name: 'trigger_inject',
            description: 'Press the button of one Node-RED inject node, sending its configured message into the flow — this runs real automation. Any other node is refused. The same node is refused again within a short cooldown unless repeat is true. Follow with get_debug_messages to see what happened.',
            annotations: WRITE,
            input: { node_id: z.string().describe('An inject node id; inside a subflow instance, <instance>-<node>'), repeat: z.boolean().default(false).describe('Allow a repeat inside the cooldown') },
            async handler({ node_id: nodeId, repeat }, { client, ring, injects, config }) {
                // Node-RED's endpoint sends a message into whatever node the id names, so the type is
                // checked here.
                const { flows } = await client.getFlows();
                const r = resolveStatus(indexFlows(flows), nodeId);
                if (r.node?.type !== 'inject' || r.template) {
                    const what = r.template ? 'the definition inside a subflow; use <instance>-<node>' : r.node ? `a ${r.node.type}` : 'no known node';
                    throw new UserError(`${nodeId} is ${what}, not an inject node`);
                }
                const last = injects.get(nodeId);
                const now = Date.now();
                if (!repeat && last && now - last < config.injectCooldownMs) {
                    throw new UserError(`node ${nodeId} was triggered ${Math.round((now - last) / 1000)} s ago; pass repeat: true to trigger it again`);
                }
                // Set before the next await, so two calls at once cannot both pass the check.
                injects.set(nodeId, now);
                const cursor = ring.read({ limit: 1 }).cursor;
                try {
                    await client.inject(nodeId);
                } catch (err) {
                    injects.delete(nodeId);
                    throw err;
                }
                return { node: nodeId, triggered: true, cursor };
            },
        },
    ];
}
