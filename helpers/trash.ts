import type ObsidianGoogleDrive from '../main';
import { sanitizeMessage } from './diagnostics';

/**
 * A file moved to the Drive Trash is not guaranteed to show up as "removed" in the
 * changes feed. So, besides the feed, Pull also asks Drive which of this vault's files
 * are in the Trash and treats every such file it still tracks exactly like a removed one.
 *
 * Best effort: if the listing fails, the pull carries on with the feed alone (the next
 * pull simply asks again) and the problem is written to the diagnostics.
 * Returns how many removals were added.
 */
export const addTrashedAsRemoved = async <
	C extends { fileId: string; removed: boolean },
>(
	t: ObsidianGoogleDrive,
	changes: C[],
): Promise<number> => {
	try {
		const trashedIds = await t.drive.listTrashedFileIds();
		if (!trashedIds) return 0;

		const alreadyRemoved = new Set(
			changes.filter(({ removed }) => removed).map(({ fileId }) => fileId),
		);
		let added = 0;
		for (const id of trashedIds) {
			if (!t.settings.driveIdToPath[id] || alreadyRemoved.has(id)) continue;
			changes.push({
				kind: 'drive#change',
				removed: true,
				fileId: id,
				time: '',
			} as unknown as C);
			alreadyRemoved.add(id);
			added++;
		}
		return added;
	} catch (error) {
		t.diagnostics.record({
			phase: 'fetch-changes',
			operation: 'list-trashed-files',
			message: `Could not list trashed files (continuing without): ${sanitizeMessage(error)}`,
		});
		return 0;
	}
};
