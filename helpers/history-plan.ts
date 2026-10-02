/**
 * Works out what restoring a restore point would change. Pure (no I/O) so it can be unit tested:
 * `history-restore.ts` supplies the inputs and carries out the plan.
 */
import type { DriveEntry, HistoryEntry } from './history';

export interface PlanItem {
	path: string;
	/** Drive file id the old version belongs to */
	id: string;
	/** revision to bring back */
	rev: string;
	size?: number;
	config: boolean;
}

export interface SkippedItem {
	path: string;
	reason: string;
}

export interface RestorePlan {
	/** files that exist now with different content: go back to the old content */
	revert: PlanItem[];
	/** files that were deleted since: come back */
	recreate: PlanItem[];
	/** files that did not exist yet: are removed (through Obsidian's own deleted-files setting) */
	remove: { path: string; isFolder: boolean }[];
	/** folders that existed then and are missing now; only matter when empty */
	folders: string[];
	skipped: SkippedItem[];
	unchanged: number;
	/** settings / plugin files are part of the plan only when asked for */
	includeConfig: boolean;
}

const sameContent = (entry: HistoryEntry, current: DriveEntry) => {
	if (entry.m && current.md5) return entry.m === current.md5;
	if (entry.r && current.rev) return entry.r === current.rev;
	return false;
};

const ancestorsOf = (path: string) => {
	const parts = path.split('/');
	return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
};

const byPath = <T extends { path: string }>(a: T, b: T) =>
	a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

export const planRestore = (
	point: HistoryEntry[],
	current: DriveEntry[],
	includeConfig: boolean,
): RestorePlan => {
	const plan: RestorePlan = {
		revert: [],
		recreate: [],
		remove: [],
		folders: [],
		skipped: [],
		unchanged: 0,
		includeConfig,
	};

	const group = <T extends { p?: string; path?: string }>(list: T[]) => {
		const map = new Map<string, T[]>();
		for (const item of list) {
			const key = (item.p ?? item.path) as string;
			map.set(key, [...(map.get(key) ?? []), item]);
		}
		return map;
	};
	const thenMap = group(point);
	const nowMap = group(current);

	for (const [path, entries] of thenMap) {
		const then = entries[0] as HistoryEntry;
		if (then.c && !includeConfig) continue;
		if (entries.length > 1) {
			plan.skipped.push({ path, reason: 'appeared more than once in the restore point' });
			continue;
		}
		const now = nowMap.get(path);
		if (now && now.length > 1) {
			plan.skipped.push({ path, reason: 'exists more than once on Drive' });
			continue;
		}
		const here = now?.[0];

		// A file that stands where a folder of the restore point used to be blocks everything below it.
		const blocker = ancestorsOf(path).find((a) => {
			const x = nowMap.get(a);
			return x?.length === 1 && !(x[0] as DriveEntry).isFolder;
		});
		if (blocker) {
			plan.skipped.push({ path, reason: `a file is in the way at ${blocker}` });
			continue;
		}

		if (then.f) {
			if (!here) plan.folders.push(path);
			else if (!here.isFolder) plan.skipped.push({ path, reason: 'a file is there now, but it was a folder' });
			continue;
		}

		if (!then.r) {
			plan.skipped.push({ path, reason: 'the restore point has no old version of it' });
			continue;
		}
		if (here?.isFolder) {
			plan.skipped.push({ path, reason: 'a folder is there now, but it was a file' });
			continue;
		}
		const item: PlanItem = {
			path,
			id: then.i,
			rev: then.r,
			size: then.s,
			config: !!then.c,
		};
		if (!here) plan.recreate.push(item);
		else if (sameContent(then, here)) plan.unchanged++;
		else plan.revert.push(item);
	}

	// Things that did not exist at that time. Settings files that are not in the restore
	// point are left alone: they may belong to a plugin installed later.
	for (const [path, entries] of nowMap) {
		if (thenMap.has(path)) continue;
		const here = entries[0] as DriveEntry;
		if (here.config) continue;
		plan.remove.push({ path, isFolder: here.isFolder });
	}

	plan.revert.sort(byPath);
	plan.recreate.sort(byPath);
	plan.remove.sort(byPath);
	plan.folders.sort();
	plan.skipped.sort(byPath);
	return plan;
};

export const planIsEmpty = (plan: RestorePlan) =>
	!plan.revert.length &&
	!plan.recreate.length &&
	!plan.remove.length &&
	!plan.folders.length;

export const planSummary = (plan: RestorePlan) => ({
	revert: plan.revert.length,
	recreate: plan.recreate.length,
	remove: plan.remove.filter((r) => !r.isFolder).length,
	removeFolders: plan.remove.filter((r) => r.isFolder).length,
	unchanged: plan.unchanged,
	skipped: plan.skipped.length,
});
