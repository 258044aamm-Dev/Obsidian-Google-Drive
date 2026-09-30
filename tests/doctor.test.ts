import { describe, expect, it } from 'vitest';
import { buildDoctorReport, renderReport } from '../helpers/doctor';
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
