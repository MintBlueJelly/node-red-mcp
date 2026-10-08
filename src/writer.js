// The one write path. Every change is computed against a fresh `GET /flows`, checked, and deployed
// as a "modified flows" deploy with Node-RED's own `rev` guard, so tab order and every key outside
// the target survive and Node-RED restarts no more than the editor's own deploy would.
import {
    SUBFLOW_KEYS, TAB_KEYS, assertOnlyContainerChanged, canonical, containerObjects, describeScope, etagOf,
    indexFlows, insertTab, newId, removeContainer, replaceContainer,
} from './flows.js';
import { UserError } from './output.js';
import { compareIssues, installedTypesFrom, validateFlows } from './validate.js';

const MAX_WARNINGS = 15;

function normalizeMembers(nodes, containerId, current, index) {
    if (!Array.isArray(nodes)) throw new UserError('nodes must be an array of node objects');
    const old = new Map(current.map((o) => [o.id, o]));
    const given = new Set();
    return nodes.map((node, i) => {
        if (!node || typeof node !== 'object' || Array.isArray(node)) throw new UserError(`nodes[${i}] is not an object`);
        if (node.credentials !== undefined) {
            throw new UserError(`nodes[${i}] carries credentials; this server never writes credentials — set them in the editor`);
        }
        if (typeof node.type !== 'string' || !node.type) throw new UserError(`nodes[${i}] has no type`);
        if (node.type === 'tab' || node.type === 'subflow') throw new UserError(`nodes[${i}] is a ${node.type}; a flow cannot contain one`);
        const out = { ...node };
        if (out.id === undefined) out.id = newId();
        if (typeof out.id !== 'string' || !out.id) throw new UserError(`nodes[${i}] has an invalid id`);
        // Two entries with one id would leave only one in place, and the other would vanish silently.
        if (given.has(out.id)) throw new UserError(`id ${out.id} appears more than once in nodes`);
        given.add(out.id);
        if (out.z === undefined) out.z = containerId;
        if (out.z !== containerId) throw new UserError(`node ${out.id} has z "${out.z}", but it belongs to ${containerId}`);
        const elsewhere = index.byId.get(out.id);
        if (elsewhere && elsewhere.z !== containerId && elsewhere.id !== containerId) {
            throw new UserError(`id ${out.id} is already used by a ${elsewhere.type} in ${elsewhere.z ?? 'the global scope'}`);
        }
        const before = old.get(out.id);
        if (before) {
            for (const k of ['x', 'y']) if (out[k] === undefined && before[k] !== undefined) out[k] = before[k];
        }
        return out;
    });
}

function pickKeys(input, allowed, what) {
    const extra = Object.keys(input).filter((k) => !allowed.includes(k));
    if (extra.length) throw new UserError(`${what} cannot change ${extra.join(', ')}; allowed: ${allowed.join(', ')}`);
    return input;
}

/** Builders: each takes the current flows and returns the change, or a refusal. Pure. */
export const plans = {
    updateTab(flows, { id, flow }) {
        const index = indexFlows(flows);
        const tab = index.byId.get(id);
        if (!tab) throw new UserError(`no flow with id ${id}; list_flows shows the ids`);
        if (tab.type === 'subflow' || !tab.z && tab.type !== 'tab') throw new UserError(`${id} is a ${tab.type}; use update_global`);
        if (tab.type !== 'tab') throw new UserError(`${id} is a node, not a flow; update the flow it belongs to (${tab.z})`);
        if (tab.locked) throw new UserError(`flow "${tab.label}" is locked in the editor; unlock it there first`);
        const { nodes, ...tabInput } = flow;
        pickKeys(tabInput, TAB_KEYS, 'update_flow');
        const current = containerObjects(index, id);
        const nextTab = { ...tab, ...tabInput };
        const members = nodes === undefined ? current.slice(1) : normalizeMembers(nodes, id, current.slice(1), index);
        const nextObjects = [nextTab, ...members];
        return {
            target: id,
            currentEtag: etagOf(current),
            unchanged: canonical(nextObjects) === canonical(current),
            next: replaceContainer(flows, id, nextObjects),
            touched: new Set([...current, ...nextObjects].map((o) => o.id)),
            started: Boolean(tab.disabled) && !nextTab.disabled,
        };
    },

    createTab(flows, { flow }) {
        const index = indexFlows(flows);
        const { nodes = [], ...tabInput } = flow;
        pickKeys(tabInput, TAB_KEYS, 'create_flow');
        if (typeof tabInput.label !== 'string' || !tabInput.label.trim()) throw new UserError('a new flow needs a label');
        const existing = index.tabs.find((t) => t.label === tabInput.label);
        if (existing) throw new UserError(`a flow labelled "${tabInput.label}" already exists`, { id: existing.id });
        const tab = { id: newId(), type: 'tab', label: tabInput.label, disabled: Boolean(tabInput.disabled), info: tabInput.info ?? '', env: tabInput.env ?? [] };
        const members = normalizeMembers(nodes, tab.id, [], index);
        return {
            target: tab.id,
            unchanged: false,
            next: insertTab(flows, tab, members),
            touched: new Set([tab.id, ...members.map((m) => m.id)]),
            started: !tab.disabled,
        };
    },

    deleteTab(flows, { id }) {
        const index = indexFlows(flows);
        const tab = index.byId.get(id);
        if (!tab) return { target: id, gone: true };
        if (tab.type !== 'tab') throw new UserError(`${id} is a ${tab.type}, not a flow`);
        if (tab.locked) throw new UserError(`flow "${tab.label}" is locked in the editor; unlock it there first`);
        if (!tab.disabled) throw new UserError(`flow "${tab.label}" is running; disable it with update_flow first, then delete it`);
        const current = containerObjects(index, id);
        const ownIds = new Set(current.map((o) => o.id));
        const linkedFrom = flows
            .filter((o) => !ownIds.has(o.id) && Array.isArray(o.links) && o.links.some((l) => ownIds.has(l)))
            .map((o) => ({ id: o.id, type: o.type, name: o.name || undefined, flow: o.z }));
        return {
            target: id,
            currentEtag: etagOf(current),
            unchanged: false,
            next: removeContainer(flows, id),
            touched: ownIds,
            result: 'deleted',
            linkedFrom,
        };
    },

    updateGlobal(flows, { id, subflow, nodes, node }) {
        const index = indexFlows(flows);
        const target = index.byId.get(id);
        if (!target) throw new UserError(`no subflow or config node with id ${id}; get_flow("global") lists them`);
        if (target.type === 'tab') throw new UserError(`${id} is a flow; use update_flow`);
        if (target.type === 'global-config') {
            throw new UserError('the global-config node holds global environment variables, and changing it restarts every flow; change it in the editor');
        }
        if (target.type === 'subflow') {
            if (node !== undefined) throw new UserError('for a subflow, pass subflow and/or nodes, not node');
            const current = containerObjects(index, id);
            const def = { ...target, ...pickKeys(subflow ?? {}, SUBFLOW_KEYS, 'update_global on a subflow') };
            const members = nodes === undefined ? current.slice(1) : normalizeMembers(nodes, id, current.slice(1), index);
            const nextObjects = [def, ...members];
            return {
                target: id,
                currentEtag: etagOf(current),
                unchanged: canonical(nextObjects) === canonical(current),
                next: replaceContainer(flows, id, nextObjects),
                touched: new Set([...current, ...nextObjects].map((o) => o.id)),
            };
        }
        if (target.z) throw new UserError(`${id} belongs to flow ${target.z}; change it with update_flow`);
        if (subflow !== undefined || nodes !== undefined) throw new UserError('for a config node, pass node only');
        if (!node || typeof node !== 'object') throw new UserError('pass node: the complete config node object');
        if (node.credentials !== undefined) throw new UserError('this server never writes credentials; set them in the editor');
        if ((node.id ?? id) !== id || (node.type ?? target.type) !== target.type) throw new UserError('a config node keeps its id and type');
        if (node.z !== undefined) throw new UserError('a global config node has no z');
        const next = { ...node, id, type: target.type };
        return {
            target: id,
            currentEtag: etagOf([target]),
            unchanged: canonical(next) === canonical(target),
            next: flows.map((o) => (o.id === id ? next : o)),
            touched: new Set([id]),
        };
    },
};

/** Validates and scopes a planned change without deploying it. */
export async function check(client, flows, plan) {
    const types = installedTypesFrom(await client.getNodes());
    const issues = compareIssues(validateFlows(flows, types), validateFlows(plan.next, types));
    const relevant = issues.warnings.filter((w) => !w.preexisting || plan.touched.has(w.id));
    const scope = describeScope(flows, plan.next);
    return {
        errors: issues.errors,
        warnings: relevant.slice(0, MAX_WARNINGS),
        moreWarnings: relevant.length > MAX_WARNINGS ? relevant.length - MAX_WARNINGS : undefined,
        scope,
        fullRestart: scope.fullRestart,
    };
}

export function createWriter({ client, log = () => {} }) {
    let chain = Promise.resolve();
    const serialize = (fn) => {
        const run = chain.then(fn, fn);
        chain = run.catch(() => {});
        return run;
    };

    async function attempt(build, etag) {
        const { rev, flows } = await client.getFlows();
        const plan = build(flows);
        if (plan.gone) return { done: { result: 'already_deleted', flow: plan.target } };
        if (plan.unchanged) return { done: { result: 'no_op', flow: plan.target, etag: plan.currentEtag } };
        if (etag !== undefined && plan.currentEtag !== etag) {
            // No current etag in the refusal: a client would resend its stale nodes with it and delete
            // what the other person added.
            throw new UserError('the flow changed since you read it; call get_flow again and apply your change to what it returns');
        }
        assertOnlyContainerChanged(flows, plan.next, plan.touched);
        const checked = await check(client, flows, plan);
        if (checked.errors.length) throw new UserError('refused: the change would introduce these problems', { errors: checked.errors });
        if (checked.fullRestart) throw new UserError('refused: the change would restart every flow');
        return { rev, flows, plan, checked };
    }

    return function write(build, { etag } = {}) {
        return serialize(async () => {
            let prepared = await attempt(build, etag);
            if (prepared.done) return prepared.done;
            let deployed;
            try {
                deployed = await client.deployFlows(prepared.rev, prepared.plan.next);
            } catch (err) {
                if (err.status !== 409) throw err;
                // Someone else deployed in between. Retry once on the new flows: the etag still
                // guards the target, so the retry only succeeds if they did not touch it.
                log('write', { event: 'rev-conflict', target: prepared.plan.target });
                prepared = await attempt(build, etag ?? prepared.plan.currentEtag);
                if (prepared.done) return prepared.done;
                deployed = await client.deployFlows(prepared.rev, prepared.plan.next);
            }
            const { plan, checked } = prepared;
            const index = indexFlows(plan.next);
            const objects = containerObjects(index, plan.target);
            return {
                result: plan.result ?? 'deployed',
                flow: plan.target,
                etag: objects ? etagOf(objects) : undefined,
                rev: deployed?.rev,
                started: plan.started || undefined,
                restarts: checked.scope.restarts,
                linkedFrom: plan.linkedFrom?.length ? plan.linkedFrom : undefined,
                warnings: checked.warnings.length ? checked.warnings : undefined,
                moreWarnings: checked.moreWarnings,
            };
        });
    };
}
