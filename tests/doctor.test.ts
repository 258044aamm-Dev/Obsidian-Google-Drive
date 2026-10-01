import { describe, expect, it } from 'vitest';
import { buildDoctorReport, clockSkewMs, renderReport } from '../helpers/doctor';
import type { DoctorInput } from '../helpers/doctor';

const base = (over: Partial<DoctorInput> = {}): DoctorInput => ({
	pluginVersion: '3.2.0',
	settings: {
		operations: {},
		driveIdToPath: {},
		lastSyncedAt: 0,
		hasRefreshToken: true,
		hasChangesToken: true,
		startupPull: false,
		autoPush: false,
	},
	localPaths: [],
	drive: [],
	...over,
});

describe('buildDoctorReport', () => {
	it('says everything matches when paths are equal', () => {
		const report = buildDoctorReport(
			base({
				localPaths: ['a.md', 'F'],
				drive: [
					{ id: '1', path: 'a.md', isFolder: false },
					{ id: '2', path: 'F', isFolder: true },
				],
			}),
		);
		expect(report.verdict).toEqual(['This device and Drive have the same paths.']);
	});

	it('separates "deleted on Drive" from "new on this device"', () => {
		const input = base({
			localPaths: ['synced-then-deleted.md', 'brand-new.md'],
		});
		input.settings.driveIdToPath = { old: 'synced-then-deleted.md' };
		const report = buildDoctorReport(input);
		expect(report.deletedOnDrive).toEqual(['synced-then-deleted.md']);
		expect(report.newLocal).toEqual(['brand-new.md']);
		expect(report.staleMapIds).toEqual([
			{ id: 'old', path: 'synced-then-deleted.md' },
		]);
		expect(report.verdict.join(' ')).toContain('Do NOT Push first');
	});

	it('lists drive-only paths and duplicates', () => {
		const report = buildDoctorReport(
			base({
				drive: [
					{ id: '1', path: 'x.md', isFolder: false },
					{ id: '2', path: 'x.md', isFolder: false },
				],
			}),
		);
		expect(report.onlyOnDrive).toEqual(['x.md']);
		expect(report.duplicateDrivePaths).toEqual([{ path: 'x.md', ids: ['1', '2'] }]);
	});

	it('counts pending operations and flags non-manual settings', () => {
		const input = base();
		input.settings.operations = { 'a.md': 'create', 'b.md': 'delete', 'c.md': 'create' };
		input.settings.startupPull = true;
		input.settings.autoPush = true;
		input.settings.lastSyncedAt = Date.UTC(2026, 8, 30);
		const report = buildDoctorReport(input);
		expect(report.operationCounts).toEqual({ create: 2, modify: 0, delete: 1 });
		expect(report.lastSyncedAt).toBe('2026-09-30T00:00:00.000Z');
		const text = renderReport(report);
		expect(text).toContain('Startup pull is ON');
		expect(text).toContain('Auto-push is ON');
	});

	it('never prints secrets and caps long lists', () => {
		const paths = Array.from({ length: 100 }, (_, i) => `n${i}.md`);
		const text = renderReport(buildDoctorReport(base({ localPaths: paths })));
		expect(text).toContain('... and 40 more');
		expect(text).toContain('Refresh token: present');
	});
});

describe('doctor environment checks', () => {
	const warn = (env: NonNullable<DoctorInput['environment']>) =>
		buildDoctorReport(base({ environment: env })).verdict.join('\n');

	it('adds nothing when no environment facts are given', () => {
		const report = buildDoctorReport(base());
		expect(report.environmentLines).toEqual([]);
		expect(renderReport(report)).not.toContain('Clock check');
	});

	it('warns when Obsidian deletes files permanently, not for the trash options', () => {
		expect(warn({ obsidianTrashOption: 'none' })).toContain('Permanently delete');
		expect(warn({ obsidianTrashOption: 'local' })).not.toContain('Permanently');
		expect(warn({ obsidianTrashOption: 'system' })).not.toContain('Permanently');
		expect(warn({})).not.toContain('Permanently');
	});

	it('reports the Drive deletion mode', () => {
		const text = (deleteToTrash: boolean) =>
			renderReport(buildDoctorReport(base({ environment: { deleteToTrash } })));
		expect(text(true)).toContain('moved to the Drive Trash');
		expect(text(false)).toContain('Drive deletions: permanent');
	});

	it('flags a clock more than a minute off, in both directions', () => {
		expect(warn({ clockSkewMs: 5 * 60_000 })).toContain('5 minutes ahead of');
		expect(warn({ clockSkewMs: -90_000 })).toContain('90 seconds behind');
		expect(warn({ clockSkewMs: 61_000 })).toContain("clock is about");
	});

	it('accepts a clock within a minute and a failed measurement', () => {
		const ok = buildDoctorReport(base({ environment: { clockSkewMs: 60_000 } }));
		expect(ok.verdict).not.toContain('clock');
		expect(ok.environmentLines.join()).toContain('agrees with Google');
		const unknown = buildDoctorReport(base({ environment: { clockSkewMs: null } }));
		expect(unknown.environmentLines.join()).toContain('could not be measured');
	});
});

describe('clockSkewMs', () => {
	const date = 'Wed, 30 Sep 2026 12:00:00 GMT';
	const server = Date.parse(date);
	it('uses the middle of the request as the device time', () => {
		expect(clockSkewMs(server - 500, server + 500, date)).toBe(0);
		expect(clockSkewMs(server + 299_000, server + 301_000, date)).toBe(300_000);
		expect(clockSkewMs(server - 301_000, server - 299_000, date)).toBe(-300_000);
	});
	it('returns null without a usable Date header', () => {
		expect(clockSkewMs(1, 2, undefined)).toBeNull();
		expect(clockSkewMs(1, 2, '')).toBeNull();
		expect(clockSkewMs(1, 2, 'not a date')).toBeNull();
	});
});


describe('false pending marks line (3.8.1)', () => {
	const text = (env: Record<string, unknown>) =>
		renderReport(buildDoctorReport(base({ environment: env })));

	it('lists notes marked as changed that are identical to the last sync', () => {
		const out = text({ falseMarks: ['a.md', 'b.md'] });
		expect(out).toMatch(/2 notes are marked as changed here but identical to the last sync \(a\.md, b\.md\)/);
		expect(out).toMatch(/false alarm/);
	});

	it('says nothing when there are none, or when the check was not made', () => {
		expect(text({ falseMarks: [] })).not.toMatch(/false alarm/);
		expect(text({})).not.toMatch(/false alarm/);
		expect(renderReport(buildDoctorReport(base()))).not.toMatch(/Pending list/);
	});

	it('shortens a long list', () => {
		const out = text({ falseMarks: ['1', '2', '3', '4', '5', '6', '7'] });
		expect(out).toMatch(/7 notes are marked/);
		expect(out).toMatch(/\(1, 2, 3, 4, 5, \.\.\.\)/);
	});
});
