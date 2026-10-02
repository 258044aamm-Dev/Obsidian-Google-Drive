import { describe, expect, it, vi } from 'vitest';
vi.mock('obsidian', async () => await import('./obsidian-mock'));
import {
	clearSyncState,
	isOwnUpload,
	matchesBaseline,
	pruneSyncState,
	recordOwnUpload,
	recordSynced,
	stampOf,
} from '../../helpers/sync-state';
import { verifySummary, verifyUploads } from '../../helpers/push-verify';
import { renderCompare } from '../../helpers/compare-note';
import { editedSinceLastSync } from '../../helpers/missed-edits';
import { blockedMessage } from '../../helpers/push-guard';

const plugin = (extra: Record<string, unknown> = {}): any => ({
	settings: { operations: {}, driveIdToPath: {}, ...extra },
	diagnostics: { record: vi.fn() },
});

describe('own uploads', () => {
	it('recognises the exact time of its own upload, and only that', () => {
		const t = plugin();
		recordOwnUpload(t, 'f1', '2026-09-30T10:00:00.123Z');
		expect(isOwnUpload(t, 'f1', '2026-09-30T10:00:00.123Z')).toBe(true);
		expect(isOwnUpload(t, 'f1', '2026-09-30T10:00:00.124Z')).toBe(false);
		expect(isOwnUpload(t, 'f2', '2026-09-30T10:00:00.123Z')).toBe(false);
		expect(isOwnUpload(plugin(), 'f1', undefined)).toBe(false);
	});
	it('ignores a missing time and settings saved by an older version', () => {
		const t = plugin();
		recordOwnUpload(t, 'f1', undefined);
		expect(t.settings.ownUploads).toBeUndefined();
		expect(isOwnUpload(t, 'f1', '2026-09-30T10:00:00.000Z')).toBe(false);
	});
	it('forgets uploads older than the last sync and everything on clear', () => {
		const t = plugin();
		recordOwnUpload(t, 'old', '2026-09-30T10:00:00.000Z');
		recordOwnUpload(t, 'new', '2026-09-30T12:00:00.000Z');
		recordSynced(t, 'gone.md', { m: 1, s: 1 });
		recordSynced(t, 'kept.md', { m: 1, s: 1 });
		pruneSyncState(t, new Set(['kept.md']), Date.parse('2026-09-30T11:00:00.000Z'));
		expect(Object.keys(t.settings.ownUploads)).toEqual(['new']);
		expect(Object.keys(t.settings.syncedFiles)).toEqual(['kept.md']);
		clearSyncState(t);
		expect(t.settings.ownUploads).toEqual({});
		expect(t.settings.syncedFiles).toEqual({});
	});
});

describe('remembered state of a note', () => {
	it('matches only when time and size are both unchanged', () => {
		const t = plugin();
		recordSynced(t, 'a.md', { m: 100, s: 5 });
		expect(matchesBaseline(t, 'a.md', 100, 5)).toBe(true);
		expect(matchesBaseline(t, 'a.md', 101, 5)).toBe(false);
		expect(matchesBaseline(t, 'a.md', 100, 6)).toBe(false);
		expect(matchesBaseline(t, 'b.md', 100, 5)).toBe(false);
	});
	it('stampOf tolerates a file without stat', () => {
		expect(stampOf({})).toBeUndefined();
		expect(stampOf({ stat: { mtime: 3, size: 4 } })).toEqual({ m: 3, s: 4 });
		recordSynced(plugin(), 'a.md', undefined);
	});
	it('editedSinceLastSync: a remembered, unchanged note is skipped; an unremembered one uses the old rule', () => {
		const files = [
			{ path: 'same.md', mtime: 500, size: 3 },
			{ path: 'edited.md', mtime: 500, size: 4 },
			{ path: 'old-edit.md', mtime: 50, size: 9 },
			{ path: 'untracked-new.md', mtime: 500, size: 1 },
			{ path: 'untracked-old.md', mtime: 50, size: 1 },
			{ path: 'pending.md', mtime: 500, size: 1 },
		];
		const ids = Object.fromEntries(files.map((f) => [f.path, 'id-' + f.path]));
		const baselines = {
			'same.md': { m: 500, s: 3 },
			'edited.md': { m: 400, s: 4 },
			'old-edit.md': { m: 40, s: 9 },
			'pending.md': { m: 1, s: 1 },
		};
		expect(editedSinceLastSync(files, ids, { 'pending.md': 'modify' }, 100, baselines)).toEqual([
			'edited.md',
			'old-edit.md',
			'untracked-new.md',
		]);
		// without any remembered state the result is what 3.6.1 gave
		expect(editedSinceLastSync(files, ids, { 'pending.md': 'modify' }, 100)).toEqual([
			'edited.md',
			'same.md',
			'untracked-new.md',
		]);
	});
});

describe('checking uploads on Drive', () => {
	const driveWith = (answers: Record<string, unknown>) => ({
		getFileStatus: vi.fn(async (id: string) => {
			const a = answers[id];
			if (a instanceof Error) throw a;
			return a;
		}),
	});
	it('reports matching sizes, a trashed file, a wrong size and an unreadable answer', async () => {
		const t = plugin();
		t.drive = driveWith({
			ok: { id: 'ok', size: '10' },
			trashed: { id: 'trashed', size: '10', trashed: true },
			short: { id: 'short', size: '4' },
			boom: new Error('network'),
			none: undefined,
		});
		const result = await verifyUploads(t, [
			{ id: 'ok', path: 'ok.md', size: 10 },
			{ id: 'trashed', path: 'trashed.md', size: 10 },
			{ id: 'short', path: 'short.md', size: 10 },
			{ id: 'boom', path: 'boom.md', size: 10 },
			{ id: 'none', path: 'none.md', size: 10 },
		]);
		expect(result.checked).toBe(3);
		expect(result.unknown).toBe(2);
		expect(result.problems.join('|')).toContain('trashed.md (is in the Drive Trash)');
		expect(result.problems.join('|')).toContain('short.md (Drive holds 4 bytes, expected 10)');
		const text = verifySummary(result, false);
		expect(text).toContain('Warning: 2 of 3');
		expect(text).toContain('2 file(s) could not be checked');
	});
	it('with encryption on, the expected size is 33 bytes larger', async () => {
		const t = plugin({ e2eeEnabled: true });
		t.drive = driveWith({ a: { id: 'a', size: '43' } });
		const result = await verifyUploads(t, [{ id: 'a', path: 'a.md', size: 10 }]);
		expect(result.problems).toEqual([]);
		expect(verifySummary(result, true)).toContain('random names');
	});
	it('checks at most 20 files and never throws when the client lacks the call', async () => {
		const t = plugin();
		t.drive = { getFileStatus: vi.fn(async (id: string) => ({ id, size: '1' })) };
		const many = Array.from({ length: 35 }, (_, i) => ({ id: 'i' + i, path: `n${i}.md`, size: 1 }));
		expect((await verifyUploads(t, many)).checked).toBe(20);
		t.drive = {};
		expect((await verifyUploads(t, many)).unknown).toBe(20);
	});
});

describe('compare report', () => {
	const base = {
		path: 'Inbox/a.md',
		encrypted: false,
		localMtime: Date.parse('2026-09-30T10:00:00Z'),
		localSize: 5,
		knownOnDrive: true,
		ownUpload: false,
	};
	it('says SAME, DIFFERENT with the newer side, and what Push will do', () => {
		const drive = { size: '5', modifiedTime: '2026-09-30T09:00:00.000Z' };
		expect(renderCompare({ ...base, drive, same: true })).toContain('Result: SAME');
		const diff = renderCompare({ ...base, drive, same: false, pending: 'modify' });
		expect(diff).toContain('DIFFERENT');
		expect(diff).toContain('newer copy is: this device');
		expect(diff).toContain('Push will upload');
		const newer = renderCompare({ ...base, drive: { ...drive, modifiedTime: '2026-09-30T11:00:00.000Z' }, same: false });
		expect(newer).toContain('newer copy is: Google Drive');
		expect(newer).toContain('not in the pending list');
	});
	it('handles a note Drive does not know, an unreadable Drive, encryption and own upload', () => {
		expect(renderCompare({ ...base, knownOnDrive: false })).toContain('no copy of this note is known');
		expect(renderCompare({ ...base, error: 'HTTP 500' })).toContain('could not be read (HTTP 500)');
		const enc = renderCompare({ ...base, encrypted: true, drive: { size: '38' }, same: true, ownUpload: true });
		expect(enc).toContain('random names');
		expect(enc).toContain("this device's own last upload: yes");
		expect(renderCompare({ ...base, drive: { size: '5' }, same: true })).toContain('Nothing was changed.');
	});
});

describe('stop message', () => {
	it('names the side that changed and how to continue', () => {
		const text = blockedMessage({ mode: 'overlap', conflicts: ['a.md'], remoteCount: 1 }, true);
		expect(text).toContain('changed both on this device and on Google Drive (a.md)');
		expect(text).toContain('another device');
		expect(text).toContain('Press Pull first');
		expect(text).toContain('Nothing was changed.');
	});
});
