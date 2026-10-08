// Tool results: compact JSON, capped, and errors the model can act on.
import { NodeRedError } from './nodered.js';

/** A refusal the caller can fix: wrong id, stale etag, a rule this server enforces. */
export class UserError extends Error {
    constructor(message, detail = {}) {
        super(message);
        this.name = 'UserError';
        this.detail = detail;
    }
}

export function ok(value, maxChars) {
    const text = JSON.stringify(value);
    if (text.length <= maxChars) return { content: [{ type: 'text', text }] };
    return {
        content: [{
            type: 'text',
            text: JSON.stringify({
                truncated: true,
                chars: text.length,
                hint: 'The result is larger than this server returns at once. Narrow it: search_nodes to find ids, filters, or a smaller limit.',
                preview: text.slice(0, maxChars - 400),
            }),
        }],
    };
}

export function fail(err) {
    if (err instanceof UserError) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: err.message, ...err.detail }) }] };
    }
    if (err instanceof NodeRedError) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: err.message, status: err.status || undefined }) }] };
    }
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: `internal error: ${err.message}` }) }] };
}
