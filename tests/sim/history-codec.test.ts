import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => {
	class Plain {}
	return { Notice: Plain, TFile: Plain, TFolder: Plain, TAbstractFile: Plain, requestUrl: async () => ({}) };
});
import { decodePoint, encodePoint, signatureOf, toHistoryEntries, type HistoryEntry, type RestorePointData } from '../../helpers/history';

const entries = (n: number): HistoryEntry[] =>
	Array.from({ length: n }, (_, i) => ({
		p: `Projects/Area ${i % 40}/Note number ${i}.md`,
		i: '1' + Math.random().toString(36).slice(2).padEnd(32, 'x'),
		r: '0B' + Math.random().toString(36).slice(2).padEnd(40, 'y'),
		m: Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join(''),
		s: 1000 + i,
	}));
const data = (e: HistoryEntry[]): RestorePointData => ({ v: 1, t: 1, vault: 'V', app: '3.4.0', e });

describe('restore point file', () => {
	it('round-trips through gzip', async () => {
		const original = data(entries(50));
		const { bytes, gzip } = await encodePoint(original);
		expect(gzip).toBe(true);
		expect(bytes[0]).toBe(0x1f);
		expect(await decodePoint(bytes.slice().buffer)).toEqual(original);
	});

	it('also reads plain JSON (written by a device without compression)', async () => {
		const original = data(entries(3));
		const raw = new TextEncoder().encode(JSON.stringify(original));
		expect(await decodePoint(raw.slice().buffer)).toEqual(original);
	});

	it('rejects damaged or unknown files instead of guessing', async () => {
		await expect(decodePoint(new TextEncoder().encode('not json').buffer)).rejects.toThrow();
		await expect(decodePoint(new TextEncoder().encode(JSON.stringify({ v: 2, e: [] })).buffer)).rejects.toThrow(/Unsupported/);
		const { bytes } = await encodePoint(data(entries(5)));
		await expect(decodePoint(bytes.slice(0, 20).buffer)).rejects.toThrow();
	});

	it('stays small for a 5,000 file vault', async () => {
		const { bytes } = await encodePoint(data(entries(5000)));
		expect(bytes.length).toBeLessThan(450_000);
	});
});

describe('signatureOf', () => {
	const base = entries(20);
	it('is the same for the same state in any order', async () => {
		expect(await signatureOf(base)).toBe(await signatureOf([...base].reverse()));
		expect(await signatureOf(base)).toMatch(/^[0-9a-f]{32}$/);
	});
	it('changes when a path, an id, the content, a folder or the config flag changes', async () => {
		const sig = await signatureOf(base);
		const changed = (mut: (e: HistoryEntry) => HistoryEntry) => signatureOf(base.map((e, i) => (i === 3 ? mut(e) : e)));
		expect(await changed((e) => ({ ...e, p: e.p + 'x' }))).not.toBe(sig);
		expect(await changed((e) => ({ ...e, i: e.i + 'x' }))).not.toBe(sig);
		expect(await changed((e) => ({ ...e, m: 'f'.repeat(32) }))).not.toBe(sig);
		expect(await changed((e) => ({ ...e, c: 1 }))).not.toBe(sig);
		expect(await signatureOf(base.slice(1))).not.toBe(sig);
	});
	it('ignores the head revision id when the content is the same', async () => {
		const sig = await signatureOf(base);
		expect(await signatureOf(base.map((e) => ({ ...e, r: 'other' })))).toBe(sig);
	});
});

describe('toHistoryEntries', () => {
	it('keeps folders without revision fields and marks settings files', () => {
		expect(
			toHistoryEntries([
				{ id: '1', path: 'F', isFolder: true, config: false },
				{ id: '2', path: '.obsidian/a.json', isFolder: false, config: true, md5: 'm', rev: 'r', size: 5 },
				{ id: '3', path: 'n.md', isFolder: false, config: false },
			]),
		).toEqual([
			{ p: 'F', i: '1', f: 1 },
			{ p: '.obsidian/a.json', i: '2', r: 'r', m: 'm', s: 5, c: 1 },
			{ p: 'n.md', i: '3' },
		]);
	});
});
