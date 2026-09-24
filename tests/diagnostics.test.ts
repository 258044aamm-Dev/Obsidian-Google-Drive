import { describe, expect, it } from 'vitest';
import {
	sanitizeMessage,
	maskPath,
	suggestAction,
	DiagnosticsManager,
} from '../helpers/diagnostics';

describe('sanitizeMessage', () => {
	it('extracts error.message from Google API JSON responses', () => {
		const input = JSON.stringify({
			error: { code: 401, message: 'Invalid Credentials' },
		});
		expect(sanitizeMessage(input)).toBe('Invalid Credentials');
	});

	it('strips Bearer tokens', () => {
		const result = sanitizeMessage(
			'Bearer ya29.a0ARrdaM-this_is_fake_token_data_abc123',
		);
		expect(result).toContain('Bearer [REDACTED]');
		expect(result).not.toContain('ya29');
	});

	it('strips refresh_token values', () => {
		const result = sanitizeMessage('{"refresh_token":"1//0ABC123XYZ"}');
		expect(result).toContain('refresh_token=[REDACTED]');
		expect(result).not.toContain('ABC123XYZ');
	});

	it('strips client_secret values', () => {
		const result = sanitizeMessage('client_secret=GOCSPX-abcdefghij');
		expect(result).toContain('client_secret=[REDACTED]');
		expect(result).not.toContain('GOCSPX');
	});

	it('strips long base64-like blobs', () => {
		const blob = 'A'.repeat(60);
		const result = sanitizeMessage(`token=${blob}`);
		expect(result).toContain('[REDACTED]');
		expect(result).not.toContain(blob);
	});

	it('handles non-string inputs', () => {
		expect(sanitizeMessage(new Error('test error'))).toContain('test error');
		expect(sanitizeMessage(null)).toBe('');
		expect(sanitizeMessage(42)).toBe('42');
		expect(sanitizeMessage(undefined)).toBe('');
	});

	it('preserves non-sensitive error text', () => {
		expect(sanitizeMessage('File not found')).toBe('File not found');
		expect(sanitizeMessage('Network timeout')).toBe('Network timeout');
	});

	it('handles invalid JSON gracefully', () => {
		expect(sanitizeMessage('{invalid json')).toBe('{invalid json');
	});
});

describe('maskPath', () => {
	it('masks folder/file.ext preserving extension', () => {
		const result = maskPath('folder/note.md');
		expect(result).toContain('.md');
		expect(result).not.toContain('folder');
		expect(result).not.toContain('note');
		expect(result).toContain('/');
	});

	it('masks deeply nested paths', () => {
		const result = maskPath('a/b/c/d.txt');
		expect(result).toContain('.txt');
		expect(result).not.toContain('/b/');
		expect(result).not.toContain('/c/');
	});

	it('preserves non-path text', () => {
		expect(maskPath('This is not a path')).toBe('This is not a path');
	});

	it('handles empty string', () => {
		expect(maskPath('')).toBe('');
	});

	it('masks paths embedded in error messages', () => {
		const input = 'Error reading my-notes/daily/2024.md from Drive';
		const result = maskPath(input);
		expect(result).toContain('***.md');
		expect(result).not.toContain('my-notes');
		expect(result).toContain('Error reading');
	});
});

describe('suggestAction', () => {
	it('returns phase-specific cause for 401 + token-refresh', () => {
		const result = suggestAction(401, 'token-refresh');
		expect(result.likelyCause).toContain('Refresh token');
		expect(result.suggestedAction).toContain('refresh token');
	});

	it('returns generic cause for 401 without phase override', () => {
		const result = suggestAction(401, 'upload');
		expect(result.likelyCause).toContain('Authentication');
		expect(result.suggestedAction).toContain('Re-authenticate');
	});

	it('returns rate limit cause for 429', () => {
		const result = suggestAction(429, 'download');
		expect(result.likelyCause).toContain('rate limit');
	});

	it('returns connection cause for non-HTTP errors during connection-check', () => {
		const result = suggestAction(undefined, 'connection-check');
		expect(result.likelyCause).toContain('Cannot reach');
	});

	it('returns local-write cause for non-HTTP errors during local-write', () => {
		const result = suggestAction(undefined, 'local-write');
		expect(result.likelyCause).toContain('Local file write');
	});

	it('returns generic fallback for unknown status', () => {
		const result = suggestAction(418, 'upload');
		expect(result.likelyCause).toContain('unexpected');
	});

	it('returns generic fallback for non-HTTP errors without phase', () => {
		const result = suggestAction(undefined, null);
		expect(result.likelyCause).toContain('unexpected');
	});

	it('returns 403 cause for upload phase', () => {
		const result = suggestAction(403, 'upload');
		expect(result.likelyCause).toContain('permissions');
	});
});

describe('DiagnosticsManager', () => {
	it('records entries when enabled', () => {
		const mgr = new DiagnosticsManager();
		mgr.enabled = true;
		mgr.record({ message: 'test' });
		expect(mgr.getEntries()).toHaveLength(1);
	});

	it('does not record entries when disabled', () => {
		const mgr = new DiagnosticsManager();
		mgr.record({ message: 'test' });
		expect(mgr.getEntries()).toHaveLength(0);
	});

	it('withContext sets and restores phase', async () => {
		const mgr = new DiagnosticsManager();
		mgr.enabled = true;
		await mgr.withContext('download', 'test-op', async () => {
			expect(mgr.currentPhase).toBe('download');
			expect(mgr.currentOperation).toBe('test-op');
			mgr.record({ message: 'inner' });
		});
		expect(mgr.currentPhase).toBeNull();
		expect(mgr.currentOperation).toBeNull();
		expect(mgr.getEntries()[0]?.phase).toBe('download');
		expect(mgr.getEntries()[0]?.operation).toBe('test-op');
	});

	it('withContext restores phase even on exception', async () => {
		const mgr = new DiagnosticsManager();
		try {
			await mgr.withContext('upload', 'fail', async () => {
				throw new Error('boom');
			});
		} catch {
			/* expected */
		}
		expect(mgr.currentPhase).toBeNull();
		expect(mgr.currentOperation).toBeNull();
	});

	it('withContext restores previous phase on nesting', async () => {
		const mgr = new DiagnosticsManager();
		await mgr.withContext('upload', 'outer', async () => {
			expect(mgr.currentPhase).toBe('upload');
			await mgr.withContext('download', 'inner', async () => {
				expect(mgr.currentPhase).toBe('download');
			});
			expect(mgr.currentPhase).toBe('upload');
		});
		expect(mgr.currentPhase).toBeNull();
	});

	it('export() returns valid JSON with metadata', () => {
		const mgr = new DiagnosticsManager();
		mgr.enabled = true;
		mgr.record({ message: 'test' });
		const exported = JSON.parse(mgr.export()) as {
			format: number;
			plugin: string;
			entryCount: number;
			entries: unknown[];
		};
		expect(exported.format).toBe(1);
		expect(exported.plugin).toBe('google-drive-sync');
		expect(exported.entryCount).toBe(1);
		expect(exported.entries).toHaveLength(1);
	});

	it('clear() removes all entries', () => {
		const mgr = new DiagnosticsManager();
		mgr.enabled = true;
		mgr.record({ message: 'a' });
		mgr.record({ message: 'b' });
		expect(mgr.getEntries()).toHaveLength(2);
		mgr.clear();
		expect(mgr.getEntries()).toHaveLength(0);
	});

	it('record() applies maskPath when maskPaths is true', () => {
		const mgr = new DiagnosticsManager();
		mgr.enabled = true;
		mgr.maskPaths = true;
		mgr.record({ message: 'Error in folder/note.md' });
		expect(mgr.getEntries()[0]?.message).toContain('***.md');
		expect(mgr.getEntries()[0]?.message).not.toContain('folder/note.md');
	});

	it('record() does not mask when maskPaths is false', () => {
		const mgr = new DiagnosticsManager();
		mgr.enabled = true;
		mgr.maskPaths = false;
		mgr.record({ message: 'Error in folder/note.md' });
		expect(mgr.getEntries()[0]?.message).toContain('folder/note.md');
	});

	it('record() auto-fills likelyCause and suggestedAction', () => {
		const mgr = new DiagnosticsManager();
		mgr.enabled = true;
		mgr.record({ message: 'test', httpStatus: 429 });
		expect(mgr.getEntries()[0]?.likelyCause).toContain('rate limit');
		expect(mgr.getEntries()[0]?.suggestedAction).toContain('Wait');
	});

	it('record() uses explicit likelyCause when provided', () => {
		const mgr = new DiagnosticsManager();
		mgr.enabled = true;
		mgr.record({
			message: 'test',
			likelyCause: 'Custom cause',
			suggestedAction: 'Custom action',
		});
		expect(mgr.getEntries()[0]?.likelyCause).toBe('Custom cause');
		expect(mgr.getEntries()[0]?.suggestedAction).toBe('Custom action');
	});

	it('record() includes timestamp', () => {
		const mgr = new DiagnosticsManager();
		mgr.enabled = true;
		const before = Date.now();
		mgr.record({ message: 'test' });
		const after = Date.now();
		const ts = mgr.getEntries()[0]?.timestamp ?? 0;
		expect(ts).toBeGreaterThanOrEqual(before);
		expect(ts).toBeLessThanOrEqual(after);
	});

	it('record() preserves stack when provided', () => {
		const mgr = new DiagnosticsManager();
		mgr.enabled = true;
		mgr.record({ message: 'test', stack: 'Error: test\n  at line 1' });
		expect(mgr.getEntries()[0]?.stack).toBe('Error: test\n  at line 1');
	});
});
