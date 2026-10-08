// An in-memory Admin API with Node-RED's own `rev` guard, for testing the write path without a
// runtime. `beforeDeploy` lets a test slip in someone else's deploy between read and write.
import { createHash } from 'node:crypto';
import { NodeRedError } from '../../src/nodered.js';
import { INSTALLED_TYPES, storedFixture } from './fixture.js';

const revOf = (flows) => createHash('sha256').update(JSON.stringify(flows)).digest('hex');

export function fakeClient({ flows = storedFixture(), types = INSTALLED_TYPES } = {}) {
    const state = { flows: structuredClone(flows), deploys: 0, beforeDeploy: null };
    state.rev = revOf(state.flows);
    return {
        state,
        externalDeploy(mutate) {
            state.flows = mutate(structuredClone(state.flows));
            state.rev = revOf(state.flows);
        },
        getFlows: async () => ({ rev: state.rev, flows: structuredClone(state.flows) }),
        getNodes: async () => [{ module: 'node-red', types, enabled: true }],
        async deployFlows(rev, flows) {
            if (state.beforeDeploy) {
                const hook = state.beforeDeploy;
                state.beforeDeploy = null;
                hook();
            }
            if (rev !== state.rev) throw new NodeRedError('Node-RED answered POST /flows with 409: version_mismatch', 409);
            state.flows = structuredClone(flows);
            state.rev = revOf(state.flows);
            state.deploys += 1;
            return { rev: state.rev };
        },
    };
}
