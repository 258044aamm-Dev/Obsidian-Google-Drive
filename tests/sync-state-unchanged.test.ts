import { describe, expect, it, vi } from 'vitest';
vi.stubGlobal('window', globalThis);
vi.mock('obsidian', () => ({ Notice: class {}, TFile: class {}, Platform: { isMobile: false } }));
import type ObsidianGoogleDrive from '../main';
import { hashOf, knownToDrive, unchangedSinceSync } from '../helpers/sync-state';

type Baselines = Record<string, { m: number; s: number; h?: string }>;

const bytes = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer;
const plugin = (syncedFiles: Baselines, driveIdToPath: Record<string, string> = {}) =>
	({ settings: { syncedFiles, driveIdToPath } }) as unknown as ObsidianGoogleDrive;

describe('unchangedSinceSync', () => {
	it('same content as at the last sync (even with a new time): unchanged', async () => {
		const h = await hashOf(bytes('hello'));
		const t = plugin({ 'a.md': { m: 1, s: 5, h } });
		expect(await unchangedSinceSync(t, { path: 'a.md', stat: { mtime: 99, size: 5 } }, async () => bytes('hello'))).toBe(true);
	});
	it('different content: changed, even when the size is the same', async () => {
		const h = await hashOf(bytes('hello'));
		const t = plugin({ 'a.md': { m: 1, s: 5, h } });
		expect(await unchangedSinceSync(t, { path: 'a.md', stat: { mtime: 1, size: 5 } }, async () => bytes('HELLO'))).toBe(false);
	});
	it('nothing remembered: not unchanged (unknown)', async () => {
		expect(await unchangedSinceSync(plugin({}), { path: 'a.md', stat: { mtime: 1, size: 5 } }, async () => bytes('hello'))).toBe(false);
	});
	it('no fingerprint: only identical time AND size count', async () => {
		const t = plugin({ 'a.md': { m: 1, s: 5 } });
		expect(await unchangedSinceSync(t, { path: 'a.md', stat: { mtime: 1, size: 5 } }, async () => bytes('x'))).toBe(true);
		expect(await unchangedSinceSync(t, { path: 'a.md', stat: { mtime: 2, size: 5 } }, async () => bytes('x'))).toBe(false);
		expect(await unchangedSinceSync(t, { path: 'a.md', stat: { mtime: 1, size: 6 } }, async () => bytes('x'))).toBe(false);
	});
	it('an unreadable file is never "unchanged"', async () => {
		const h = await hashOf(bytes('hello'));
		const t = plugin({ 'a.md': { m: 1, s: 5, h } });
		expect(
			await unchangedSinceSync(t, { path: 'a.md', stat: { mtime: 9, size: 5 } }, async () => {
				throw new Error('ENOENT');
			}),
		).toBe(false);
	});
});

describe('knownToDrive', () => {
	it('follows the saved id map', () => {
		const t = plugin({}, { id1: 'a.md' });
		expect(knownToDrive(t, 'a.md')).toBe(true);
		expect(knownToDrive(t, 'b.md')).toBe(false);
		t.settings.driveIdToPath = { id1: 'a.md', id2: 'b.md' };
		expect(knownToDrive(t, 'b.md')).toBe(true);
	});
});
