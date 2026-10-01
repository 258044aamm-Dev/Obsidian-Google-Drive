/**
 * Counts on the ribbon icons.
 *  - Push icon: the number of changes waiting on this device (the pending list). Costs nothing.
 *  - Pull icon (opt-in): the number of changes waiting on Google Drive. This needs a request to
 *    Drive, so it is only made at startup and then on a slow timer, never while a sync runs.
 *
 * The number is a hint. Pull and Push still decide for themselves what to do.
 */
import type ObsidianGoogleDrive from '../main';
import { folderMimeType, unSplitPath } from './drive';
import { isSyncedPath } from './ignore';
import { isOwnPluginPath } from './own-plugin';
import { countRemoteChanges, type RemoteChange } from './push-guard';
import { isOwnUpload } from './sync-state';
import { addTrashedAsRemoved } from './trash';

/** How often Drive is asked, once the opt-in check is on. */
export const WAITING_CHECK_MS = 15 * 60 * 1000;

/** `''` for nothing, the number up to 99, `99+` above. */
export const badgeText = (count: number | undefined) =>
	!count || count < 1 ? '' : count > 99 ? '99+' : String(count);

export const pushIconLabel = (count: number | undefined) =>
	count && count > 0
		? `Push to Google Drive (${count} change${count === 1 ? '' : 's'} waiting on this device)`
		: 'Push to Google Drive';

export const pullIconLabel = (count: number | undefined) =>
	count && count > 0
		? `Pull from Google Drive (${count} change${count === 1 ? '' : 's'} waiting on Google Drive)`
		: 'Pull from Google Drive';

/** What an icon needs from the DOM (Obsidian's element helpers). */
export interface BadgeHost {
	querySelector(selector: string): { setText(text: string): void; addClass(c: string): void; removeClass(c: string): void } | null;
	createSpan(options: { cls: string }): { setText(text: string): void; addClass(c: string): void; removeClass(c: string): void };
	setAttribute(name: string, value: string): void;
	addClass(c: string): void;
}

/** Shows `text` as a small badge on an icon (or hides it when empty) and sets the icon's tooltip. */
export const setBadge = (icon: BadgeHost | undefined, text: string, label: string) => {
	if (!icon || typeof icon.querySelector !== 'function') return;
	icon.addClass('ogd-badge-host');
	let badge = icon.querySelector('.ogd-badge');
	if (!badge) badge = icon.createSpan({ cls: 'ogd-badge' });
	badge.setText(text);
	if (text) badge.removeClass('ogd-badge-hidden');
	else badge.addClass('ogd-badge-hidden');
	icon.setAttribute('aria-label', label);
};

/**
 * How many changes are waiting on Google Drive that this device has not pulled: the files Drive
 * changed since the last sync (not this device's own uploads) and the files removed there that
 * still exist here. Folders are not counted. Reads only. `undefined` when it cannot tell (never
 * synced, encryption locked, offline, an error).
 */
export const countWaitingOnDrive = async (
	t: ObsidianGoogleDrive,
): Promise<number | undefined> => {
	try {
		if (!t.settings.refreshToken || !t.settings.lastSyncedAt || !t.settings.changesToken) {
			return undefined;
		}
		if (t.settings.e2eeEnabled === true && !t.e2ee) return undefined;
		const listed = await t.drive.searchFiles({
			include: ['id', 'modifiedTime', 'properties', 'mimeType'],
			matches: [
				{ modifiedTime: { gt: new Date(t.settings.lastSyncedAt).toISOString() } },
			],
		});
		if (!listed) return undefined;
		const changes = await t.drive.getChanges(t.settings.changesToken);
		if (!changes) return undefined;
		// Files moved to the Drive Trash count as removed, whether or not the feed says so (as in Pull).
		await addTrashedAsRemoved(t, changes);

		const synced = (path: string) =>
			!!path && !isOwnPluginPath(t, path) && isSyncedPath(t, path);
		const changed: RemoteChange[] = listed
			.filter(({ id, modifiedTime, mimeType }) => mimeType !== folderMimeType && !isOwnUpload(t, id, modifiedTime))
			.map(({ id, properties }) => ({
				path: unSplitPath(properties),
				previousPath: t.settings.driveIdToPath[id],
				isFolder: false,
			}))
			.filter(({ path }) => synced(path));
		const gone = changes
			.filter(({ removed }) => removed)
			.map(({ fileId }) => t.settings.driveIdToPath[fileId])
			.filter((path): path is string => !!path && synced(path) && !!t.app.vault.getFileByPath(path));
		return countRemoteChanges(changed, gone);
	} catch {
		return undefined;
	}
};

/**
 * Asks Drive how many changes are waiting and shows it on the Pull icon. Does nothing unless the
 * user turned the check on, and never while a sync runs or the app is in the background.
 */
export const refreshWaitingBadge = async (t: ObsidianGoogleDrive) => {
	if (t.settings.pullBadge !== true || t.settings.ribbonBadges === false) return;
	if (t.syncing) return;
	if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
	const count = await countWaitingOnDrive(t);
	if (count === undefined || t.syncing) return; // keep what was shown
	t.waitingOnDrive = count;
	t.updateStatusBar();
};
