// Runs a real Node-RED (the pinned devDependency, the same runtime as the production image) and this
// server as child processes, so tests can restart or pause Node-RED and read both logs.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureFlows } from './fixture.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const NODE_RED = join(ROOT, 'node_modules', 'node-red', 'red.js');
const SERVER = join(ROOT, 'src', 'index.js');
const H = { 'Node-RED-API-Version': 'v2', 'Content-Type': 'application/json', Accept: 'application/json' };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function freePort() {
    return new Promise((resolve) => {
        const s = createServer();
        s.listen(0, '127.0.0.1', () => {
            const { port } = s.address();
            s.close(() => resolve(port));
        });
    });
}

export async function waitFor(check, { timeoutMs = 30000, intervalMs = 250, what = 'condition' } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        try {
            last = await check();
            if (last) return last;
        } catch (err) {
            last = err;
        }
        await sleep(intervalMs);
    }
    throw new Error(`timed out waiting for ${what}: ${last?.message ?? last}`);
}

function capture(proc, lines) {
    for (const stream of [proc.stdout, proc.stderr]) {
        stream.setEncoding('utf8');
        stream.on('data', (chunk) => lines.push(...chunk.split(/\r?\n/).filter(Boolean)));
    }
}

async function stopProcess(proc) {
    if (!proc || proc.exitCode !== null) return;
    const exited = new Promise((r) => proc.once('exit', r));
    proc.kill();
    await exited;
}

export async function startNodeRed() {
    const userDir = mkdtempSync(join(tmpdir(), 'nr-mcp-test-'));
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const nr = { url, userDir, port, logs: [], proc: null };

    nr.api = async (method, path, body, headers = {}) => {
        const res = await fetch(url + path, { method, headers: { ...H, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await res.text();
        let json;
        try { json = JSON.parse(text); } catch { json = text; }
        return { status: res.status, body: json };
    };
    nr.start = async () => {
        nr.proc = spawn(process.execPath, [NODE_RED, '--userDir', userDir, '--port', String(port)], { cwd: ROOT });
        capture(nr.proc, nr.logs);
        await waitFor(async () => (await fetch(`${url}/settings`)).ok, { what: 'Node-RED to start' });
    };
    nr.stop = () => stopProcess(nr.proc);
    nr.restart = async () => {
        await nr.stop();
        await nr.start();
    };
    nr.signal = (sig) => nr.proc.kill(sig);
    nr.seed = async () => {
        const res = await nr.api('POST', '/flows', { flows: fixtureFlows() }, { 'Node-RED-Deployment-Type': 'full' });
        if (res.status !== 200) throw new Error(`seeding failed: ${res.status} ${JSON.stringify(res.body)}`);
        await waitFor(async () => (await nr.counters()).A_alone === 1, { what: 'flows to start' });
    };
    nr.context = async (key) => {
        const res = await nr.api('GET', `/context/global/${encodeURIComponent(key)}`);
        return res.body?.msg;
    };
    nr.counters = async () => {
        const out = {};
        for (const k of ['A_alone', 'A_chain', 'B_alone', 'B_chain', 'C_alone', 'E_alone', 'SF1']) {
            const v = await nr.context(`start_${k}`);
            out[k] = v === undefined || v === '(undefined)' ? 0 : Number(v);
        }
        return out;
    };
    nr.cleanup = async () => {
        await nr.stop();
        rmSync(userDir, { recursive: true, force: true });
    };
    await nr.start();
    return nr;
}

export async function startServer(nodeRedUrl, env = {}) {
    const port = await freePort();
    const srv = { url: `http://127.0.0.1:${port}`, logs: [], proc: null };
    srv.proc = spawn(process.execPath, [SERVER], {
        cwd: ROOT,
        env: { ...process.env, NODE_RED_URL: nodeRedUrl, PORT: String(port), HOST: '127.0.0.1', ...env },
    });
    capture(srv.proc, srv.logs);
    srv.health = async () => (await fetch(`${srv.url}/healthz`)).json();
    srv.stop = () => stopProcess(srv.proc);
    await waitFor(async () => (await srv.health()).comms.connected, { what: 'the server to connect to Node-RED' });
    return srv;
}
