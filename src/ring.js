// Bounded event buffer for what arrives over /comms. Bounded by count and by bytes, because
// Node-RED publishes debug output without any rate limit and one busy flow can fill memory.
import { randomBytes } from 'node:crypto';

export class Ring {
    constructor({ maxItems, maxBytes, maxItemChars = 4000 }) {
        this.maxItems = maxItems;
        this.maxBytes = maxBytes;
        this.maxItemChars = maxItemChars;
        this.bootId = randomBytes(4).toString('hex');
        this.items = [];
        this.bytes = 0;
        this.seq = 0;
        this.dropped = 0;
    }

    push(item) {
        const entry = { seq: ++this.seq, ...item };
        if (typeof entry.msg === 'string' && entry.msg.length > this.maxItemChars) {
            entry.msg = entry.msg.slice(0, this.maxItemChars);
            entry.msgTruncated = true;
        }
        const size = JSON.stringify(entry).length;
        this.items.push({ entry, size });
        this.bytes += size;
        while (this.items.length > this.maxItems || (this.bytes > this.maxBytes && this.items.length > 1)) {
            this.bytes -= this.items.shift().size;
            this.dropped += 1;
        }
        return entry.seq;
    }

    /**
     * The newest `limit` matching entries after `cursor`, oldest first. `skipped` counts older
     * matches left out, `missed` the entries evicted before they could be read. The returned cursor
     * is always the head, so the next read sees only what arrives after this one. A cursor from
     * before a restart (another boot id) reads from the oldest entry and says `reset`.
     */
    read({ cursor, filter = () => true, limit }) {
        let after = 0;
        let reset = false;
        if (cursor) {
            const [boot, seq] = String(cursor).split(':');
            if (boot === this.bootId && Number.isInteger(Number(seq))) after = Number(seq);
            else reset = true;
        }
        const oldest = this.items[0]?.entry.seq ?? this.seq + 1;
        const missed = after && after + 1 < oldest ? oldest - after - 1 : 0;
        const matching = this.items.map((i) => i.entry).filter((e) => e.seq > after && filter(e));
        const page = matching.slice(-limit);
        return {
            items: page,
            skipped: matching.length - page.length || undefined,
            missed: missed || undefined,
            reset: reset || undefined,
            cursor: `${this.bootId}:${this.seq}`,
        };
    }

    stats() {
        return { items: this.items.length, bytes: this.bytes, dropped: this.dropped, maxItems: this.maxItems, maxBytes: this.maxBytes };
    }
}
