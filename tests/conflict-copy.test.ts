import { describe, expect, it, vi } from 'vitest';
import { conflictCopyPath, formatLocalDate, sameBytes, saveConflictCopy } from '../helpers/conflict-copy';

const bytes = (...n: number[]) => new Uint8Array(n).buffer;

describe('conflictCopyPath', () => {
	it('puts the date before the extension and keeps the folder', () => {
		expect(conflictCopyPath('Inbox/Note.md', '2026-09-30')).toBe('Inbox/Note (Drive 2026-09-30).md');
		expect(conflictCopyPath('Note.md', '2026-09-30')).toBe('Note (Drive 2026-09-30).md');
	});
	it('numbers further copies of the same day', () => {
		expect(conflictCopyPath('a/b.md', '2026-09-30', 2)).toBe('a/b (Drive 2026-09-30-2).md');
		expect(conflictCopyPath('a/b.md', '2026-09-30', 7)).toBe('a/b (Drive 2026-09-30-7).md');
	});
	it('handles dots in names, hidden files and no extension', () => {
		expect(conflictCopyPath('a/v1.2.notes.md', 'D')).toBe('a/v1.2.notes (Drive D).md');
		expect(conflictCopyPath('a/.hidden', 'D')).toBe('a/.hidden (Drive D)');
		expect(conflictCopyPath('README', 'D')).toBe('README (Drive D)');
		expect(conflictCopyPath('dir.with.dots/file', 'D')).toBe('dir.with.dots/file (Drive D)');
	});
});

describe('formatLocalDate', () => {
	it('zero-pads month and day', () => {
		expect(formatLocalDate(new Date(2026, 0, 5))).toBe('2026-01-05');
		expect(formatLocalDate(new Date(2026, 11, 31))).toBe('2026-12-31');
	});
});

describe('sameBytes', () => {
	it('compares content, not identity', () => {
		expect(sameBytes(bytes(1, 2, 3), bytes(1, 2, 3))).toBe(true);
		expect(sameBytes(bytes(1, 2, 3), bytes(1, 2, 4))).toBe(false);
		expect(sameBytes(bytes(1, 2), bytes(1, 2, 3))).toBe(false);
		expect(sameBytes(bytes(), bytes())).toBe(true);
	});
});

describe('saveConflictCopy', () => {
	const fakePlugin = (existing: Map<string, ArrayBuffer>) => {
		const t = {
			app: {
				vault: {
					adapter: {
						exists: vi.fn(async (p: string) => existing.has(p)),
						readBinary: vi.fn(async (p: string) => existing.get(p) as ArrayBuffer),
					},
				},
			},
			settings: { operations: {} as Record<string, string> },
			createFile: vi.fn(async (p: string, c: ArrayBuffer) => void existing.set(p, c)),
		};
		return t;
	};
	const noon = new Date(2026, 8, 30, 12);

	it('creates the copy and queues it for upload', async () => {
		const files = new Map<string, ArrayBuffer>();
		const t = fakePlugin(files);
		const result = await saveConflictCopy(t as never, 'a/b.md', bytes(1), noon);
		expect(result).toEqual({ path: 'a/b (Drive 2026-09-30).md', created: true });
		expect(t.settings.operations['a/b (Drive 2026-09-30).md']).toBe('create');
	});

	it('is idempotent for the same Drive content', async () => {
		const files = new Map<string, ArrayBuffer>();
		const t = fakePlugin(files);
		await saveConflictCopy(t as never, 'a/b.md', bytes(1), noon);
		const again = await saveConflictCopy(t as never, 'a/b.md', bytes(1), noon);
		expect(again).toEqual({ path: 'a/b (Drive 2026-09-30).md', created: false });
		expect(t.createFile).toHaveBeenCalledTimes(1);
	});

	it('never overwrites an existing different file: uses the next number', async () => {
		const files = new Map<string, ArrayBuffer>([['a/b (Drive 2026-09-30).md', bytes(9)]]);
		const t = fakePlugin(files);
		const result = await saveConflictCopy(t as never, 'a/b.md', bytes(1), noon);
		expect(result.path).toBe('a/b (Drive 2026-09-30-2).md');
		expect([...new Uint8Array(files.get('a/b (Drive 2026-09-30).md') as ArrayBuffer)]).toEqual([9]);
	});

	it('falls back to a unique name after 50 different copies', async () => {
		const files = new Map<string, ArrayBuffer>();
		files.set('a/b (Drive 2026-09-30).md', bytes(100));
		for (let n = 2; n <= 50; n++) files.set(`a/b (Drive 2026-09-30-${n}).md`, bytes(100 + n));
		const t = fakePlugin(files);
		const result = await saveConflictCopy(t as never, 'a/b.md', bytes(1), noon);
		expect(result.created).toBe(true);
		expect(result.path).toBe(`a/b (Drive 2026-09-30-${noon.getTime()}).md`);
	});
});

describe('copy labels (3.8.3)', () => {
	it('keeps "Drive" by default and can name this device\'s own version', () => {
		expect(conflictCopyPath('F/Note.md', '2026-10-01')).toBe('F/Note (Drive 2026-10-01).md');
		expect(conflictCopyPath('F/Note.md', '2026-10-01', 2, 'this device')).toBe('F/Note (this device 2026-10-01-2).md');
	});
});
