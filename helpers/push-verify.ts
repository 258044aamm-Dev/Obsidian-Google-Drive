/**
 * After a Push, look at a sample of the files that were just uploaded and ask Drive what it
 * holds for them (size, trashed). Read-only. A failure here never fails the Push: it only
 * changes what the final message says.
 */
import type ObsidianGoogleDrive from '../main';
import { OVERHEAD_BYTES } from './crypto';
import { sanitizeMessage } from './diagnostics';

export interface UploadedItem {
	id: string;
	path: string;
	/** size in bytes of the plain content that was uploaded */
	size: number;
}

/** At most this many uploaded files are checked after a Push (one small request each). */
export const MAX_VERIFIED_UPLOADS = 20;

export interface VerifyResult {
	checked: number;
	problems: string[];
	/** Drive could not be asked (network or permission): nothing is known */
	unknown: number;
}

export const verifyUploads = async (
	t: ObsidianGoogleDrive,
	uploaded: UploadedItem[],
): Promise<VerifyResult> => {
	const sample = [...uploaded]
		.sort((a, b) => a.path.localeCompare(b.path))
		.slice(0, MAX_VERIFIED_UPLOADS);
	const result: VerifyResult = { checked: 0, problems: [], unknown: 0 };
	const extra = t.settings.e2eeEnabled === true ? OVERHEAD_BYTES : 0;
	for (const item of sample) {
		try {
			const status = await t.drive.getFileStatus(item.id);
			if (!status) {
				result.unknown++;
				continue;
			}
			result.checked++;
			if (status.trashed) {
				result.problems.push(`${item.path} (is in the Drive Trash)`);
			} else if (
				status.size !== undefined &&
				Number(status.size) !== item.size + extra
			) {
				result.problems.push(
					`${item.path} (Drive holds ${status.size} bytes, expected ${item.size + extra})`,
				);
			}
		} catch (error) {
			result.unknown++;
			t.diagnostics.record({
				phase: 'upload',
				operation: 'verify-upload',
				message: sanitizeMessage(error),
			});
		}
	}
	if (result.problems.length) {
		t.diagnostics.record({
			phase: 'upload',
			operation: 'verify-upload',
			message: `${result.problems.length} uploaded file(s) do not match on Drive`,
		});
	}
	return result;
};

export const verifySummary = (result: VerifyResult, encrypted: boolean) => {
	const parts: string[] = [];
	if (result.problems.length) {
		const sample = result.problems.slice(0, 3).join('; ');
		parts.push(
			`Warning: ${result.problems.length} of ${result.checked} checked file(s) do not look right on Google Drive: ${sample}. Run "Compare the open note with Google Drive" on one of them.`,
		);
	} else if (result.checked) {
		parts.push(`Checked ${result.checked} uploaded file(s) on Google Drive: all present.`);
	}
	if (result.unknown) {
		parts.push(`${result.unknown} file(s) could not be checked.`);
	}
	if (encrypted && result.checked) {
		parts.push('Encryption is on: the Google Drive website shows only random names and unreadable data.');
	}
	return parts.length ? ' ' + parts.join(' ') : '';
};
