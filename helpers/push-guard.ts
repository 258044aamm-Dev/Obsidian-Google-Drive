/**
 * Push never pulls. Before uploading it only LOOKS at what changed on Google Drive since this
 * device last synced, and stops (changing nothing) when there is something the user has not
 * pulled yet. "Push without pulling" lets the push go ahead anyway, but only when none of the
 * remote changes touches a path that this device is about to upload or delete.
 */

export interface RemoteChange {
	path: string;
	/** Where this device currently has the same Drive file, if the path differs (a move). */
	previousPath?: string;
	isFolder: boolean;
}

/** Filled in by `pull` when it runs in guard mode (it then never writes to the vault). */
export interface PullGuard {
	/** `any`: stop for any remote change. `overlap`: stop only when a remote change collides with a local one. */
	mode: 'any' | 'overlap';
	blocked?: boolean;
	remoteCount?: number;
	conflicts?: string[];
}

const ancestorsOf = (path: string) => {
	const out: string[] = [];
	let index = path.lastIndexOf('/');
	while (index > 0) {
		out.push(path.slice(0, index));
		index = path.lastIndexOf('/', index - 1);
	}
	return out;
};

/**
 * Which remote changes collide with the local pending operations?
 *  - a changed Drive file or folder collides with a local operation on the same path, or on one
 *    of its parent folders (e.g. this device deleted the folder that Drive just added a file to);
 *  - a file or folder that is gone from Drive (removed, trashed or moved away) collides with a
 *    local operation on that path or on anything below it.
 * A folder whose content changed is NOT a collision for local operations inside it.
 */
export const findCollisions = (
	changed: RemoteChange[],
	gone: string[],
	localPaths: string[],
): string[] => {
	const local = new Set(localPaths);
	const localParents = new Set(localPaths.flatMap(ancestorsOf));
	const hits = new Set<string>();

	const check = (path: string, includeBelow: boolean) => {
		if (local.has(path)) return true;
		if (ancestorsOf(path).some((ancestor) => local.has(ancestor))) return true;
		return includeBelow && localParents.has(path);
	};

	for (const { path, previousPath } of changed) {
		if (check(path, false)) hits.add(path);
		if (previousPath && previousPath !== path && check(previousPath, true)) {
			hits.add(previousPath);
		}
	}
	for (const path of gone) {
		if (check(path, true)) hits.add(path);
	}
	return [...hits].sort();
};

export const countRemoteChanges = (changed: RemoteChange[], gone: string[]) =>
	new Set([
		...changed.map(({ path }) => path),
		...changed.flatMap(({ previousPath }) => (previousPath ? [previousPath] : [])),
		...gone,
	]).size;

export const blockedMessage = (
	guard: PullGuard,
	withoutPull: boolean,
): string => {
	const conflicts = guard.conflicts ?? [];
	if (withoutPull && conflicts.length) {
		const sample = conflicts.slice(0, 3).join(', ');
		const more = conflicts.length > 3 ? ` and ${conflicts.length - 3} more` : '';
		return `Push stopped: ${conflicts.length} item(s) changed both on this device and on Google Drive (${sample}${more}). Press Pull first so nothing is overwritten. Nothing was changed.`;
	}
	const n = guard.remoteCount ?? 0;
	return `Push stopped: Google Drive has ${n} newer change${n === 1 ? '' : 's'} that this device has not pulled. Press Pull first, then Push. (Or choose "Push without pulling" in the Push window.) Nothing was changed.`;
};
