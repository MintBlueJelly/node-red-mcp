import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { loadConfig } from '../../src/config.js';
import { ok } from '../../src/output.js';
import { toolNames } from '../../src/server.js';

describe('tool names', () => {
    // Deployments allowlist these tools by name, and an allowlist withholds a renamed tool without
    // any error. A rename has to fail here first.
    it('match tools.snapshot.txt', () => {
        const snapshot = readFileSync(new URL('../tools.snapshot.txt', import.meta.url), 'utf8').split(/\r?\n/).filter(Boolean);
        assert.deepEqual([...toolNames].sort(), snapshot);
    });
    it('include nothing that installs modules, stops the runtime, deletes context or deploys in full', () => {
        for (const name of toolNames) assert.doesNotMatch(name, /install|remove_node|module|set_flow_state|delete_context|set_flows/);
    });
});

describe('loadConfig', () => {
    it('needs NODE_RED_URL and refuses values that do not parse', () => {
        assert.throws(() => loadConfig({}), /NODE_RED_URL is required/);
        assert.throws(() => loadConfig({ NODE_RED_URL: 'nodered:1880x' }), /not an http\(s\) URL/);
        assert.throws(() => loadConfig({ NODE_RED_URL: 'http://n:1880', PORT: '80a' }), /PORT must be an integer/);
    });
    it('takes the port from MCP_PORT when PORT is unset', () => {
        assert.equal(loadConfig({ NODE_RED_URL: 'http://n:1880', MCP_PORT: '9090' }).port, 9090);
        assert.equal(loadConfig({ NODE_RED_URL: 'http://n:1880', MCP_PORT: '9090', PORT: '7070' }).port, 7070);
    });
    it('defaults', () => {
        const c = loadConfig({ NODE_RED_URL: 'http://n:1880/' });
        assert.equal(c.nodeRedUrl, 'http://n:1880');
        assert.equal(c.port, 8080);
        assert.equal(c.injectCooldownMs, 10000);
    });
});

describe('ok', () => {
    it('caps a large result and says how to narrow it', () => {
        const res = JSON.parse(ok({ big: 'x'.repeat(5000) }, 1000).content[0].text);
        assert.equal(res.truncated, true);
        assert.ok(res.preview.length <= 1000);
    });
});
