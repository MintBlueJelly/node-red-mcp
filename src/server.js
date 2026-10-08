// Streamable HTTP, stateless: every POST gets a fresh MCP server over the shared process state.
// A gateway in front of it may probe it every few seconds for every client it serves, and a
// stateless server has no sessions to pile up or to lose on restart.
import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { fail, ok } from './output.js';
import { defineTools } from './tools.js';

const tools = defineTools();
export const toolNames = tools.map((t) => t.name);

function buildMcpServer(deps, version) {
    const server = new McpServer({ name: 'node-red-mcp', version }, { capabilities: { tools: {} } });
    for (const tool of tools) {
        server.registerTool(tool.name, { description: tool.description, inputSchema: z.strictObject(tool.input), annotations: tool.annotations }, async (args) => {
            const started = Date.now();
            try {
                const result = ok(await tool.handler(args ?? {}, deps), deps.config.resultMaxChars);
                deps.log('tool', { name: tool.name, ms: Date.now() - started, ok: true });
                return result;
            } catch (err) {
                deps.log('tool', { name: tool.name, ms: Date.now() - started, ok: false, error: err.message });
                return fail(err);
            }
        });
    }
    return server;
}

function sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

export function createHttpServer(deps, version) {
    return createServer(async (req, res) => {
        const path = new URL(req.url, 'http://localhost').pathname;
        if (path === '/healthz') return sendJson(res, 200, { status: 'ok', comms: deps.comms.state() });
        if (path !== '/mcp') return sendJson(res, 404, { error: 'not found' });
        if (req.method !== 'POST') {
            return sendJson(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this server is stateless' }, id: null });
        }
        const server = buildMcpServer(deps, version);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on('close', () => {
            transport.close();
            server.close();
        });
        try {
            await server.connect(transport);
            await transport.handleRequest(req, res);
        } catch (err) {
            deps.log('http', { error: err.message });
            if (!res.headersSent) sendJson(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
        }
    });
}
