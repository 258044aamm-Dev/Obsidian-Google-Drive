import { describe, expect, it } from 'vitest';
import { planIsEmpty, planRestore, planSummary } from '../../helpers/history-plan';
import type { DriveEntry, HistoryEntry } from '../../helpers/history';

const then = (p: string, over: Partial<HistoryEntry> = {}): HistoryEntry => ({ p, i: 'old-' + p, r: 'r-' + p, m: 'm-' + p, ...over });
const folderThen = (p: string, over: Partial<HistoryEntry> = {}): HistoryEntry => ({ p, i: 'f-' + p, f: 1, ...over });
const now = (path: string, over: Partial<DriveEntry> = {}): DriveEntry => ({ id: 'id-' + path, path, isFolder: false, config: false, md5: 'm-' + path, rev: 'r-' + path, ...over });
const folderNow = (path: string, over: Partial<DriveEntry> = {}): DriveEntry => ({ id: 'f-' + path, path, isFolder: true, config: false, ...over });

describe('planRestore', () => {
	it('an identical vault needs nothing', () => {
		const plan = planRestore([then('a.md'), folderThen('F'), then('F/b.md')], [now('a.md'), folderNow('F'), now('F/b.md')], true);
		expect(planIsEmpty(plan)).toBe(true);
		expect(plan.unchanged).toBe(2);
		expect(plan.skipped).toEqual([]);
	});

	it('sorts files into revert, recreate and remove', () => {
		const plan = planRestore(
			[then('same.md'), then('edited.md'), then('deleted.md')],
			[now('same.md'), now('edited.md', { md5: 'other', rev: 'r2' }), now('created-later.md')],
			true,
		);
		expect(plan.revert.map((i) => [i.path, i.id, i.rev])).toEqual([['edited.md', 'old-edited.md', 'r-edited.md']]);
		expect(plan.recreate.map((i) => i.path)).toEqual(['deleted.md']);
		expect(plan.remove).toEqual([{ path: 'created-later.md', isFolder: false }]);
		expect(planSummary(plan)).toMatchObject({ revert: 1, recreate: 1, remove: 1, unchanged: 1 });
	});

	it('content that is the same counts as unchanged even if Drive made a new revision', () => {
		const plan = planRestore([then('a.md')], [now('a.md', { rev: 'newer-revision' })], true);
		expect(plan.unchanged).toBe(1);
		expect(planIsEmpty(plan)).toBe(true);
	});

	it('without md5 on either side it compares revisions', () => {
		const a = then('a.md', { m: undefined });
		expect(planRestore([a], [now('a.md', { md5: undefined })], true).unchanged).toBe(1);
		expect(planRestore([a], [now('a.md', { md5: undefined, rev: 'x' })], true).revert).toHaveLength(1);
		// nothing to compare: treated as changed (restoring is harmless)
		expect(planRestore([a], [now('a.md', { md5: undefined, rev: undefined })], true).revert).toHaveLength(1);
	});

	it('folders: missing ones are listed, folders that did not exist are removed', () => {
		const plan = planRestore([folderThen('Gone'), folderThen('Kept')], [folderNow('Kept'), folderNow('Later'), now('Later/x.md')], true);
		expect(plan.folders).toEqual(['Gone']);
		expect(plan.remove).toEqual([
			{ path: 'Later', isFolder: true },
			{ path: 'Later/x.md', isFolder: false },
		]);
	});

	it('settings files follow the checkbox; ones not in the point are always left alone', () => {
		const point = [then('.obsidian/app.json', { c: 1 }), then('n.md')];
		const current = [now('.obsidian/app.json', { config: true, md5: 'changed' }), now('.obsidian/later.json', { config: true }), now('n.md')];
		const on = planRestore(point, current, true);
		expect(on.revert.map((i) => [i.path, i.config])).toEqual([['.obsidian/app.json', true]]);
		expect(on.remove).toEqual([]);
		const off = planRestore(point, current, false);
		expect(planIsEmpty(off)).toBe(true);
		expect(off.includeConfig).toBe(false);
	});

	it('skips what it cannot do safely and says why', () => {
		const plan = planRestore(
			[then('dup.md'), then('dup.md'), then('x.md'), then('nover.md', { r: undefined }), folderThen('WasFolder'), then('WasFile'), then('Dir/deep.md')],
			[now('dup.md'), now('x.md'), now('x.md', { id: 'second' }), now('WasFolder'), folderNow('WasFile'), now('Dir', { md5: 'z' })],
			true,
		);
		const reasons = Object.fromEntries(plan.skipped.map((s) => [s.path, s.reason]));
		expect(reasons['dup.md']).toMatch(/more than once in the restore point/);
		expect(reasons['x.md']).toMatch(/more than once on Drive/);
		expect(reasons['nover.md']).toMatch(/no old version/);
		expect(reasons['WasFolder']).toMatch(/was a folder/);
		expect(reasons['WasFile']).toMatch(/was a file/);
		expect(reasons['Dir/deep.md']).toMatch(/file is in the way at Dir/);
		expect(plan.revert).toEqual([]);
		expect(plan.recreate).toEqual([]);
	});

	it('gives the same plan whatever the input order', () => {
		const point = [then('b.md'), then('a.md'), then('c/d.md')];
		const current = [now('z.md'), now('a.md', { md5: 'x' })];
		const one = planRestore(point, current, true);
		const two = planRestore([...point].reverse(), [...current].reverse(), true);
		expect(two).toEqual(one);
		expect(one.recreate.map((i) => i.path)).toEqual(['b.md', 'c/d.md']);
	});
});
