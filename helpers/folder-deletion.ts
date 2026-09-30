import { TFile, TFolder } from 'obsidian';

/**
 * Decides which local folders may be removed because they were removed on Drive.
 *
 * A folder may only be removed when EVERYTHING inside it is also going away:
 * every child file is one of `deletedFilePaths` (files this pull is actually deleting)
 * and every child folder is itself removable. Anything else (a local-only note, a file
 * kept because it has a pending local edit, a folder that still exists on Drive) means
 * the folder must stay, so no local content is ever thrown away by a folder removal.
 *
 * @param candidates folders that Drive reported as removed and that are not re-created on Drive
 * @param deletedFilePaths paths of the files this pull is really deleting
 * @returns `remove` (safe to delete) and `keep` (must stay and be treated as a local create)
 */
export const partitionFolderDeletions = (
	candidates: TFolder[],
	deletedFilePaths: Set<string>,
) => {
	const candidatePaths = new Set(candidates.map(({ path }) => path));
	const memo = new Map<string, boolean>();

	const removable = (folder: TFolder): boolean => {
		const known = memo.get(folder.path);
		if (known !== undefined) return known;
		// Guard against cycles while computing (should not happen in a tree).
		memo.set(folder.path, false);
		const result = folder.children.every((child) => {
			if (child instanceof TFolder) {
				return candidatePaths.has(child.path) && removable(child);
			}
			return child instanceof TFile && deletedFilePaths.has(child.path);
		});
		memo.set(folder.path, result);
		return result;
	};

	const remove: TFolder[] = [];
	const keep: TFolder[] = [];
	candidates.forEach((folder) =>
		(removable(folder) ? remove : keep).push(folder),
	);
	return { remove, keep };
};
