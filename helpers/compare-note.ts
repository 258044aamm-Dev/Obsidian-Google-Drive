/**
 * "Compare the open note with Google Drive": read-only. Pure report builder; the command that
 * gathers the facts is in compare-note-command.ts.
 */
export interface CompareFacts {
	path: string;
	encrypted: boolean;
	/** The pending operation for this note, if any. */
	pending?: 'create' | 'modify' | 'delete';
	localMtime: number;
	localSize: number;
	/** Remembered state from the last time this note matched Drive. */
	baseline?: { m: number; s: number };
	/** False when Drive has no file for this note yet. */
	knownOnDrive: boolean;
	drive?: { modifiedTime?: string; size?: string; trashed?: boolean };
	/** Drive's modified time is exactly what this device's own last upload produced. */
	ownUpload: boolean;
	/** After decrypting (if needed): identical bytes? undefined when it could not be read. */
	same?: boolean;
	error?: string;
}

const iso = (ms: number) => new Date(ms).toISOString();

export const renderCompare = (f: CompareFacts): string => {
	const lines: string[] = [`Note: ${f.path}`];
	lines.push(`This device: ${f.localSize} bytes, modified ${iso(f.localMtime)}`);
	if (!f.knownOnDrive) {
		lines.push('Google Drive: no copy of this note is known yet.');
		lines.push(
			f.pending === 'create'
				? 'Result: it is in the pending list as NEW; Push will upload it.'
				: 'Result: Push will find it as a new note and offer to upload it.',
		);
		return lines.join('\n');
	}
	if (f.error || !f.drive) {
		lines.push(`Google Drive: could not be read (${f.error ?? 'no answer'}).`);
		lines.push('Result: unknown. Nothing was changed.');
		return lines.join('\n');
	}
	const { drive } = f;
	lines.push(
		`Google Drive: ${drive.size ?? '?'} bytes${f.encrypted ? ' (encrypted, 33 bytes more than the note)' : ''}, modified ${drive.modifiedTime ?? 'unknown'}${drive.trashed ? ', IN THE DRIVE TRASH' : ''}`,
	);
	lines.push(`Waiting to be pushed: ${f.pending ?? 'no'}`);
	lines.push(
		`Drive's copy is this device's own last upload: ${f.ownUpload ? 'yes' : 'no'}`,
	);
	if (f.baseline) {
		const unchanged = f.baseline.m === f.localMtime && f.baseline.s === f.localSize;
		lines.push(
			`Changed on this device since it last matched Drive: ${unchanged ? 'no' : 'yes'}`,
		);
	} else {
		lines.push('Changed on this device since it last matched Drive: not recorded yet');
	}
	if (f.encrypted) {
		lines.push('Encryption is on: the Google Drive website shows only random names and unreadable data, so use this result instead.');
	}
	if (f.same === undefined) {
		lines.push('Result: the content could not be compared. Nothing was changed.');
	} else if (f.same) {
		lines.push('Result: SAME. The Drive copy is identical to this note.');
	} else {
		const driveTime = drive.modifiedTime ? Date.parse(drive.modifiedTime) : NaN;
		const newer = Number.isFinite(driveTime)
			? driveTime > f.localMtime
				? 'Google Drive'
				: 'this device'
			: 'unknown';
		lines.push(`Result: DIFFERENT. By time, the newer copy is: ${newer}.`);
		lines.push(
			f.pending
				? 'Push will upload this device\'s version.'
				: 'It is not in the pending list: Push checks for this and adds it; Pull would keep Drive\'s version as a conflict copy if this device\'s one differs.',
		);
	}
	lines.push('Nothing was changed.');
	return lines.join('\n');
};
