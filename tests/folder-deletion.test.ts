import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => {
	class TAbstractFile {
		path = '';
	}
	class TFile extends TAbstractFile {}
	class TFolder extends TAbstractFile {
		children: TAbstractFile[] = [];
	}
	return { TAbstractFile, TFile, TFolder };
});

import { TFile, TFolder } from 'obsidian';
import {
	findImpliedDescendants,
	partitionFolderDeletions,
} from '../helpers/folder-deletion';

const file = (path: string) => Object.assign(new TFile(), { path });
const folder = (path: string, children: (TFile | TFolder)[] = []) =>
	Object.assign(new TFolder(), { path, children });

describe('partitionFolderDeletions', () => {
	it('removes a folder whose files are all being deleted', () => {
		const a = file('F/a.md');
		const f = folder('F', [a]);
		const { remove, keep } = partitionFolderDeletions([f], new Set(['F/a.md']));
		expect(remove).toEqual([f]);
		expect(keep).toEqual([]);
	});

	it('removes an empty folder', () => {
		const f = folder('Empty');
		expect(partitionFolderDeletions([f], new Set()).remove).toEqual([f]);
	});

	it('keeps a folder that contains a local-only / preserved file', () => {
		const f = folder('F', [file('F/a.md'), file('F/mine.md')]);
		const { remove, keep } = partitionFolderDeletions([f], new Set(['F/a.md']));
		expect(remove).toEqual([]);
		expect(keep).toEqual([f]);
	});

	it('removes nested folders only when the whole subtree goes', () => {
		const inner = folder('F/G', [file('F/G/x.md')]);
		const outer = folder('F', [inner]);
		const r = partitionFolderDeletions([outer, inner], new Set(['F/G/x.md']));
		expect(r.remove).toEqual([outer, inner]);
		expect(r.keep).toEqual([]);
	});

	it('keeps the parent (but removes the child) when only the child subtree is going', () => {
		const inner = folder('F/G', [file('F/G/x.md')]);
		const outer = folder('F', [inner, file('F/keep.md')]);
		const r = partitionFolderDeletions([outer, inner], new Set(['F/G/x.md']));
		expect(r.remove).toEqual([inner]);
		expect(r.keep).toEqual([outer]);
	});

	it('keeps a parent whose child folder still exists on Drive (not a candidate)', () => {
		const inner = folder('F/G');
		const outer = folder('F', [inner]);
		const r = partitionFolderDeletions([outer], new Set());
		expect(r.keep).toEqual([outer]);
	});
});

describe('findImpliedDescendants', () => {
	it('classifies synced-unchanged descendants as gone and edited files as edited, recursively', () => {
		const inner = folder('F/G', [file('F/G/x.md'), file('F/G/edited.md')]);
		const outer = folder('F', [inner, file('F/a.md'), file('F/local-only.md')]);
		const state: Record<string, 'gone' | 'edited'> = {
			'F/G': 'gone',
			'F/G/x.md': 'gone',
			'F/G/edited.md': 'edited',
			'F/a.md': 'gone',
		};
		const r = findImpliedDescendants([outer], (p) => state[p] ?? 'unknown');
		expect(r.files.map((f) => f.path).sort()).toEqual(['F/G/x.md', 'F/a.md']);
		expect(r.folders.map((f) => f.path)).toEqual(['F/G']);
		expect(r.edited.map((f) => f.path)).toEqual(['F/G/edited.md']);
	});

	it('does not descend into a subfolder that is not known to be synced', () => {
		const inner = folder('F/G', [file('F/G/x.md')]);
		const outer = folder('F', [inner]);
		const r = findImpliedDescendants([outer], (p) => (p === 'F/G/x.md' ? 'gone' : 'unknown'));
		expect(r.files).toEqual([]);
		expect(r.folders).toEqual([]);
	});
});
