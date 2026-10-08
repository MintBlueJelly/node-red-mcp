import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Ring } from '../../src/ring.js';

describe('Ring', () => {
    it('is bounded by count', () => {
        const ring = new Ring({ maxItems: 3, maxBytes: 1e6 });
        for (let i = 0; i < 10; i++) ring.push({ msg: `m${i}` });
        assert.deepEqual(ring.read({ limit: 10 }).items.map((e) => e.msg), ['m7', 'm8', 'm9']);
        assert.equal(ring.stats().dropped, 7);
    });
    it('is bounded by bytes, and keeps the newest entry even when it alone is large', () => {
        const ring = new Ring({ maxItems: 1000, maxBytes: 2000, maxItemChars: 10000 });
        for (let i = 0; i < 50; i++) ring.push({ msg: 'x'.repeat(300) });
        assert.ok(ring.stats().bytes <= 2000);
        ring.push({ msg: 'y'.repeat(5000) });
        assert.equal(ring.stats().items, 1);
    });
    it('truncates one oversized message', () => {
        const ring = new Ring({ maxItems: 10, maxBytes: 1e6, maxItemChars: 100 });
        ring.push({ msg: 'z'.repeat(1000) });
        const [e] = ring.read({ limit: 1 }).items;
        assert.equal(e.msg.length, 100);
        assert.equal(e.msgTruncated, true);
    });
    it('reads only what arrived after a cursor', () => {
        const ring = new Ring({ maxItems: 100, maxBytes: 1e6 });
        ring.push({ msg: 'a' });
        const { cursor } = ring.read({ limit: 10 });
        ring.push({ msg: 'b' });
        ring.push({ msg: 'c' });
        const page = ring.read({ cursor, limit: 10 });
        assert.deepEqual(page.items.map((e) => e.msg), ['b', 'c']);
        assert.deepEqual(ring.read({ cursor: page.cursor, limit: 10 }).items, []);
    });
    it('returns the newest page and counts what it skipped', () => {
        const ring = new Ring({ maxItems: 100, maxBytes: 1e6 });
        for (let i = 0; i < 10; i++) ring.push({ msg: `m${i}` });
        const page = ring.read({ limit: 3 });
        assert.deepEqual(page.items.map((e) => e.msg), ['m7', 'm8', 'm9']);
        assert.equal(page.skipped, 7);
    });
    it('reports evicted entries and a cursor from another boot', () => {
        const ring = new Ring({ maxItems: 2, maxBytes: 1e6 });
        ring.push({ msg: 'a' });
        const { cursor } = ring.read({ limit: 1 });
        for (let i = 0; i < 5; i++) ring.push({ msg: `m${i}` });
        assert.equal(ring.read({ cursor, limit: 10 }).missed, 3);
        assert.equal(ring.read({ cursor: 'otherboot:1', limit: 10 }).reset, true);
    });
    it('filters', () => {
        const ring = new Ring({ maxItems: 100, maxBytes: 1e6 });
        ring.push({ kind: 'debug' });
        ring.push({ kind: 'warn' });
        assert.deepEqual(ring.read({ limit: 10, filter: (e) => e.kind === 'warn' }).items.map((e) => e.kind), ['warn']);
    });
});
