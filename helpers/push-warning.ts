/**
 * Extra warning for the Push confirmation when a Push would delete unusually many items.
 * Pure (no I/O). It only adds a line of text to the modal; it never blocks or changes a Push.
 */

/** More than this many deletions triggers the warning. */
export const MASS_DELETE_COUNT = 20;
/** More than this share of the tracked Drive items triggers the warning. */
export const MASS_DELETE_SHARE = 0.25;

export const massDeleteWarning = (
	operations: readonly (readonly [string, 'create' | 'delete' | 'modify'])[],
	trackedCount: number,
	toTrash: boolean,
): string | undefined => {
	const deletes = operations.filter(([, op]) => op === 'delete').length;
	if (!deletes) return undefined;
	const share = trackedCount > 0 ? deletes / trackedCount : 0;
	if (deletes <= MASS_DELETE_COUNT && share <= MASS_DELETE_SHARE) return undefined;

	const percent = trackedCount > 0 ? ` (${Math.round(share * 100)}% of ${trackedCount} items on Drive)` : '';
	const outcome = toTrash
		? 'They will be moved to the Google Drive Trash, where you can restore them for about 30 days.'
		: 'They will be deleted from Google Drive permanently.';
	return `WARNING: this Push deletes ${deletes} items${percent}. ${outcome} If you did not intend this, press Cancel, then run Pull, and check the list below. To keep an item, use the trash button next to it to undo that deletion.`;
};
