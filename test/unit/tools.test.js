import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UserError } from '../../src/output.js';
import { Ring } from '../../src/ring.js';
import { defineTools } from '../../src/tools.js';
import { fakeClient } from '../support/fake-node-red.js';

const tools = Object.fromEntries(defineTools().map((t) => [t.name, t]));

function deps(overrides = {}) {
    const client = fakeClient();
    client.injected = [];
    client.inject = async (id) => {
        await new Promise((r) => setTimeout(r, 10));
        client.injected.push(id);
    };
    return { client, ring: new Ring({ maxItems: 10, maxBytes: 1e6 }), injects: new Map(), config: { injectCooldownMs: 10000, resultMaxChars: 40000 }, ...overrides };
}

describe('trigger_inject', () => {
    it('refuses anything that is not an inject node', async () => {
        const d = deps();
        await assert.rejects(tools.trigger_inject.handler({ node_id: 'A_env', repeat: false }, d), (err) => err instanceof UserError && /a function, not an inject node/.test(err.message));
        await assert.rejects(tools.trigger_inject.handler({ node_id: 'nope', repeat: false }, d), /no known node/);
        assert.deepEqual(d.client.injected, []);
    });
    it('lets only one of two concurrent calls through the cooldown', async () => {
        const d = deps();
        const results = await Promise.allSettled([
            tools.trigger_inject.handler({ node_id: 'A_inj', repeat: false }, d),
            tools.trigger_inject.handler({ node_id: 'A_inj', repeat: false }, d),
        ]);
        assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
        assert.deepEqual(d.client.injected, ['A_inj']);
    });
    it('clears the cooldown when the inject fails', async () => {
        const d = deps();
        d.client.inject = async () => { throw new Error('no answer'); };
        await assert.rejects(tools.trigger_inject.handler({ node_id: 'A_inj', repeat: false }, d), /no answer/);
        assert.equal(d.injects.has('A_inj'), false);
    });
});

describe('get_flow', () => {
    it('puts the etag first', async () => {
        const res = await tools.get_flow.handler({ id: 'A' }, deps());
        assert.equal(Object.keys(res)[0], 'etag');
    });
    it('refuses a flow too large to return whole, without its etag', async () => {
        const d = deps({ config: { injectCooldownMs: 0, resultMaxChars: 1000 } });
        await assert.rejects(tools.get_flow.handler({ id: 'A' }, d), (err) => {
            assert.match(err.message, /too large/);
            assert.deepEqual(err.detail, {});
            return true;
        });
    });
});
