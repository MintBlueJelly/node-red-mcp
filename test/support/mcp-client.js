// A real MCP client over Streamable HTTP, so tests exercise the same protocol path as a client.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export async function connect(url) {
    const client = new Client({ name: 'node-red-mcp-test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    return {
        client,
        /** Calls a tool and returns its parsed JSON; `isError` results come back as `{ isError, ...body }`. */
        async call(name, args = {}) {
            const res = await client.callTool({ name, arguments: args });
            const body = JSON.parse(res.content[0].text);
            return res.isError ? { isError: true, ...body } : body;
        },
        close: () => client.close(),
    };
}
