import type ObsidianGoogleDrive from '../main';
import { forgetSynced } from './sync-state';

/** `2026-09-30`, in the device's local time. */
export const formatLocalDate = (date: Date) =>
	`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/**
 * `Folder/Note.md` -> `Folder/Note (Drive 2026-09-30).md`; further copies the same day get
 * `Note (Drive 2026-09-30-2).md`, `-3`, ...
 */
export const conflictCopyPath = (
	path: string,
	date: string,
	attempt = 1,
	label = 'Drive',
) => {
	const slash = path.lastIndexOf('/');
	const folder = slash >= 0 ? path.slice(0, slash + 1) : '';
	const name = path.slice(slash + 1);
	const dot = name.lastIndexOf('.');
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const extension = dot > 0 ? name.slice(dot) : '';
	const suffix = attempt <= 1 ? date : `${date}-${attempt}`;
	return `${folder}${stem} (${label} ${suffix})${extension}`;
};

export const sameBytes = (a: ArrayBuffer, b: ArrayBuffer) => {
	if (a.byteLength !== b.byteLength) return false;
	const x = new Uint8Array(a);
	const y = new Uint8Array(b);
	for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
	return true;
};

const MAX_NUMBERED_COPIES = 50;

/**
 * Keeps the Drive version of a note that was changed both on Drive and on this device.
 * The local note stays where it is; the Drive version is saved next to it as a copy.
 *
 * It is safe to call again for the same Drive version: if an earlier copy already holds
 * exactly this content, nothing new is written. The copy is queued as a new file so the
 * next Push uploads it and the other devices receive it too.
 */
export const saveConflictCopy = async (
	t: ObsidianGoogleDrive,
	path: string,
	driveContent: ArrayBuffer,
	now = new Date(),
	/** `Drive` for the Drive version of a note; `this device` for this device's own version (see repair.ts). */
	label = 'Drive',
): Promise<{ path: string; created: boolean }> => {
	const { adapter } = t.app.vault;
	const date = formatLocalDate(now);

	for (let attempt = 1; attempt <= MAX_NUMBERED_COPIES; attempt++) {
		const candidate = conflictCopyPath(path, date, attempt, label);
		if (!(await adapter.exists(candidate))) {
			await t.createFile(candidate, driveContent);
			// the copy is not on Drive: it must not count as "identical to Drive"
			forgetSynced(t, candidate);
			t.settings.operations[candidate] = 'create';
			return { path: candidate, created: true };
		}
		if (sameBytes(await adapter.readBinary(candidate), driveContent)) {
			return { path: candidate, created: false };
		}
	}

	// Absurdly many different copies the same day: fall back to a unique name.
	const unique = conflictCopyPath(path, `${date}-${now.getTime()}`, 1, label);
	await t.createFile(unique, driveContent);
	forgetSynced(t, unique);
	t.settings.operations[unique] = 'create';
	return { path: unique, created: true };
};
