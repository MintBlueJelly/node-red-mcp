#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Comms, commsUrl } from './comms.js';
import { loadConfig } from './config.js';
import { createClient } from './nodered.js';
import { Ring } from './ring.js';
import { createHttpServer } from './server.js';
import { createWriter } from './writer.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function log(event, fields = {}) {
    process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), event, ...fields })}\n`);
}

let config;
try {
    config = loadConfig();
} catch (err) {
    process.stderr.write(`node-red-mcp: ${err.message}\n`);
    process.exit(2);
}

const client = createClient({ baseUrl: config.nodeRedUrl, token: config.nodeRedToken, timeoutMs: config.requestTimeoutMs });
const ring = new Ring({ maxItems: config.debugBufferItems, maxBytes: config.debugBufferBytes });
const comms = new Comms({ url: commsUrl(config.nodeRedUrl), token: config.nodeRedToken, ring, heartbeatTimeoutMs: config.heartbeatTimeoutMs, log });
const deps = { client, comms, ring, config, log, injects: new Map(), write: createWriter({ client, log }) };

comms.start();
const server = createHttpServer(deps, version);
server.listen(config.port, config.host, () => log('listening', { version, port: config.port, nodeRed: config.nodeRedUrl }));

function shutdown(signal) {
    log('shutdown', { signal });
    comms.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
