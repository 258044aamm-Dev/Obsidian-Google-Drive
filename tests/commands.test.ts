import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingDefinition } from 'obsidian';
import type ObsidianGoogleDrive from '../main';

/** Vite's build-time file glob (the vitest runner provides it; the plugin's own build does not use it). */
declare global {
	interface ImportMeta {
		glob(pattern: string[], options: object): Record<string, string>;
	}
}

const notices: string[] = [];
vi.mock('obsidian', () => ({
	Modal: class {},
	Notice: class {
		constructor(message: string) {
			notices.push(message);
		}
	},
	Setting: class {},
}));

const actions = vi.hoisted(() => ({
	openTour: vi.fn(),
	push: vi.fn(),
	pull: vi.fn(),
	reset: vi.fn(),
	fixDrivePath: vi.fn(),
	runSyncDoctor: vi.fn(),
	runCompareActiveNote: vi.fn(),
	createRestorePointNow: vi.fn(),
	startVaultRestore: vi.fn(),
	runRepairSyncMemory: vi.fn(),
}));
vi.mock('../helpers/tour', () => ({ openTour: actions.openTour }));
vi.mock('../helpers/push', () => ({ push: actions.push }));
vi.mock('../helpers/pull', () => ({ pull: actions.pull }));
vi.mock('../helpers/reset', () => ({ reset: actions.reset }));
vi.mock('../helpers/repair', () => ({ runRepairSyncMemory: actions.runRepairSyncMemory }));
vi.mock('../helpers/fix_drive_path', () => ({ fixDrivePath: actions.fixDrivePath }));
vi.mock('../helpers/doctor-command', () => ({ runSyncDoctor: actions.runSyncDoctor }));
vi.mock('../helpers/compare-note-command', () => ({ runCompareActiveNote: actions.runCompareActiveNote }));
vi.mock('../helpers/history-ui', () => ({
	createRestorePointNow: actions.createRestorePointNow,
	startVaultRestore: actions.startVaultRestore,
}));

import {
	PLUGIN_COMMANDS,
	commandsInDisplayOrder,
	commandsSettingGroup,
	describeCommand,
	matchesQuery,
	registerCommands,
	runFromSettings,
} from '../helpers/commands';

/** The commands registered since 3.8.2 (3.8.3 added `repair-sync-memory`). They must not change: hotkeys depend on the ids. */
const BEFORE_3_8_2: [string, string][] = [
	['open-tour', 'Open the getting-started tour'],
	['push', 'Push to Google Drive'],
	['pull', 'Pull from Google Drive'],
	['reset', 'Reset local vault to Google Drive'],
	['fix-drive-path', 'Fix Google Drive paths'],
	['sync-doctor', 'Sync doctor (read-only check of this device vs Google Drive)'],
	['compare-note-with-drive', 'Compare the open note with Google Drive (read-only)'],
	['restore-vault-history', 'Restore the whole vault to an earlier restore point (version history)'],
	['create-restore-point', 'Create a restore point now (version history)'],
	['export-diagnostics', 'Copy sync diagnostics to clipboard'],
];
const ADDED_3_8_3: [string, string][] = [['repair-sync-memory', 'Repair sync memory (keeps your notes)']];
const ALL: [string, string][] = [...BEFORE_3_8_2, ...ADDED_3_8_3];

class El {
	children: El[] = [];
	classes = new Set<string>();
	text = '';
	disabled = false;
	listeners: Record<string, (() => void)[]> = {};
	constructor(public tag = 'div') {}
	empty() {
		this.children = [];
	}
	createDiv(o: { cls?: string; text?: string } = {}) {
		const el = new El('div');
		if (o.cls) el.classes.add(o.cls);
		el.text = o.text ?? '';
		this.children.push(el);
		return el;
	}
	createEl(tag: string, o: { cls?: string; text?: string } = {}) {
		const el = new El(tag);
		if (o.cls) el.classes.add(o.cls);
		el.text = o.text ?? '';
		this.children.push(el);
		return el;
	}
	addClass(c: string) {
		this.classes.add(c);
	}
	addEventListener(type: string, fn: () => void) {
		(this.listeners[type] ??= []).push(fn);
	}
	click() {
		(this.listeners.click ?? []).forEach((fn) => fn());
	}
	find(pred: (e: El) => boolean): El | undefined {
		for (const c of this.children) {
			if (pred(c)) return c;
			const deeper = c.find(pred);
			if (deeper) return deeper;
		}
		return undefined;
	}
}

interface Added {
	id: string;
	name: string;
	callback: () => unknown;
}
type FakePlugin = ObsidianGoogleDrive & { added: Added[] };
type Row = SettingDefinition & { aliases: string[]; render: (setting: { settingEl: El }) => void };

const plugin = (refreshToken = 'token'): FakePlugin => {
	const added: Added[] = [];
	return {
		added,
		settings: { refreshToken },
		addCommand: (c: Added) => added.push(c),
		copyDiagnosticsToClipboard: vi.fn(async () => undefined),
	} as unknown as FakePlugin;
};

beforeEach(() => {
	notices.length = 0;
	Object.values(actions).forEach((fn) => fn.mockReset());
});

describe('the command list', () => {
	it('keeps every command id and name that existed before (hotkeys depend on them)', () => {
		expect(PLUGIN_COMMANDS.map((c) => [c.id, c.name]).sort()).toEqual([...ALL].sort());
	});

	it('has unique ids, a description for each, and marks the data-changing ones', () => {
		expect(new Set(PLUGIN_COMMANDS.map((c) => c.id)).size).toBe(PLUGIN_COMMANDS.length);
		for (const c of PLUGIN_COMMANDS) expect(c.desc.length).toBeGreaterThan(20);
		const risk = Object.fromEntries(PLUGIN_COMMANDS.map((c) => [c.id, c.risk]));
		expect(risk['reset']).toBe('destructive');
		expect(risk['fix-drive-path']).toBe('destructive');
		expect(risk['sync-doctor']).toBe('safe');
		expect(risk['compare-note-with-drive']).toBe('safe');
		expect(risk['export-diagnostics']).toBe('safe');
		expect(risk['push']).toBe('changes');
		expect(risk['repair-sync-memory']).toBe('changes');
	});

	it('is the only place that registers commands', () => {
		const sources = import.meta.glob(['../main.ts', '../helpers/*.ts'], {
			query: '?raw',
			import: 'default',
			eager: true,
		});
		const names = Object.keys(sources);
		expect(names.length).toBeGreaterThan(20); // the scan really found the files
		for (const [file, text] of Object.entries(sources)) {
			if (file.endsWith('helpers/commands.ts')) continue;
			expect(text, file).not.toMatch(/addCommand\(/);
		}
	});
});

describe('registering with Obsidian', () => {
	it('registers only the tour before a token exists, and the rest after', () => {
		const t = plugin();
		registerCommands(t, false);
		expect(t.added.map((c) => c.id)).toEqual(['open-tour']);
		registerCommands(t, true);
		expect(t.added.map((c) => [c.id, c.name]).sort()).toEqual([...ALL].sort());
	});

	it('runs the same action as before when a command is used from the palette', async () => {
		const t = plugin();
		registerCommands(t, false);
		registerCommands(t, true);
		for (const c of t.added) c.callback();
		for (const fn of Object.values(actions)) expect(fn).toHaveBeenCalledTimes(1);
		expect(actions.push).toHaveBeenCalledWith(t);
		expect(t.copyDiagnosticsToClipboard).toHaveBeenCalledTimes(1);
	});
});

describe('search and display', () => {
	it('matches every word, in any order, ignoring case', () => {
		expect(matchesQuery('Push to Google Drive', 'push drive')).toBe(true);
		expect(matchesQuery('Push to Google Drive', 'DRIVE push')).toBe(true);
		expect(matchesQuery('Push to Google Drive', 'pull')).toBe(false);
		expect(matchesQuery('anything', '')).toBe(true);
		expect(matchesQuery('anything', '   ')).toBe(true);
	});

	it('lists every command once, grouped', () => {
		const ordered = commandsInDisplayOrder();
		expect(ordered.map((c) => c.id).sort()).toEqual(PLUGIN_COMMANDS.map((c) => c.id).sort());
		const groups = ordered.map((c) => c.group);
		expect(groups.join(',')).toBe([...groups].sort((a, b) => ['Sync', 'Checks', 'History', 'Repair', 'Help'].indexOf(a) - ['Sync', 'Checks', 'History', 'Repair', 'Help'].indexOf(b)).join(','));
	});

	it('says what each command does to your data', () => {
		const reset = PLUGIN_COMMANDS.find((c) => c.id === 'reset')!;
		const doctor = PLUGIN_COMMANDS.find((c) => c.id === 'sync-doctor')!;
		expect(describeCommand(reset)).toContain('Destructive.');
		expect(describeCommand(doctor)).toContain('Read-only.');
	});
});

describe('the Commands section of the settings page', () => {
	it('is a searchable group with a hotkeys hint and one row per command', () => {
		const group = commandsSettingGroup(plugin());
		expect(group.type).toBe('group');
		expect(group.heading).toBe('Commands');
		expect(group.search).toBeTruthy();
		expect(group.items).toHaveLength(PLUGIN_COMMANDS.length + 1);
		expect((group.items![0] as { searchable?: boolean }).searchable).toBe(false);
		expect((group.items!.slice(1) as SettingDefinition[]).map((i) => i.name).sort()).toEqual(PLUGIN_COMMANDS.map((c) => c.name).sort());
	});

	it('filters rows by name, description, id or group', () => {
		const group = commandsSettingGroup(plugin());
		const rows = group.items!.slice(1) as unknown as Row[];
		const shown = (q: string) => rows.filter((r) => group.search!.match(r, q)).map((r) => r.aliases[0]);
		expect(shown('')).toHaveLength(PLUGIN_COMMANDS.length);
		expect(shown('doctor')).toContain('sync-doctor');
		expect(shown('sync-doctor')).toEqual(['sync-doctor']);
		expect(shown('restore')).toEqual(expect.arrayContaining(['restore-vault-history', 'create-restore-point']));
		expect(shown('fix-drive-path')).toEqual(['fix-drive-path']);
		expect(shown('repair').sort()).toEqual(['fix-drive-path', 'repair-sync-memory', 'reset']);
		expect(shown('destructive').sort()).toEqual(['fix-drive-path', 'reset']);
		expect(shown('no such command')).toEqual([]);
	});

	const renderRowFor = (t: ObsidianGoogleDrive, id: string) => {
		const group = commandsSettingGroup(t);
		const row = (group.items as unknown as Row[]).find((i) => i.aliases?.[0] === id)!;
		const settingEl = new El();
		row.render({ settingEl });
		const button = settingEl.find((e) => e.tag === 'button')!;
		return { settingEl, button };
	};

	it('draws title, description and a Run button that runs the command', async () => {
		const t = plugin();
		const { settingEl, button } = renderRowFor(t, 'sync-doctor');
		expect(settingEl.find((e) => e.classes.has('setting-item-name'))?.text).toBe(
			'Sync doctor (read-only check of this device vs Google Drive)',
		);
		expect(settingEl.find((e) => e.classes.has('setting-item-description'))?.text).toContain('Read-only.');
		expect(button.text).toBe('Run');
		expect(button.disabled).toBe(false);
		button.click();
		await Promise.resolve();
		expect(actions.runSyncDoctor).toHaveBeenCalledWith(t);
	});

	it('disables the button of a command that needs a token when there is none', () => {
		const { settingEl, button } = renderRowFor(plugin(''), 'push');
		expect(button.disabled).toBe(true);
		expect(settingEl.find((e) => e.classes.has('setting-item-description'))?.text).toContain('Needs your refresh token');
		const tour = renderRowFor(plugin(''), 'open-tour');
		expect(tour.button.disabled).toBe(false);
	});

	it('warns on the button of a destructive command', () => {
		expect(renderRowFor(plugin(), 'reset').button.classes.has('mod-warning')).toBe(true);
		expect(renderRowFor(plugin(), 'pull').button.classes.has('mod-warning')).toBe(false);
	});
});

describe('Run from the settings page', () => {
	const find = (id: string) => PLUGIN_COMMANDS.find((c) => c.id === id)!;

	it('does nothing but explain when the token is missing', async () => {
		await runFromSettings(plugin(''), find('pull'));
		expect(actions.pull).not.toHaveBeenCalled();
		expect(notices.join('\n')).toMatch(/refresh token/);
	});

	it('runs the tour without a token', async () => {
		await runFromSettings(plugin(''), find('open-tour'));
		expect(actions.openTour).toHaveBeenCalledTimes(1);
	});

	it('asks first for the command whose own flow does not ask, and respects a No', async () => {
		const t = plugin();
		const no = vi.fn(async () => false);
		await runFromSettings(t, find('fix-drive-path'), no);
		expect(no).toHaveBeenCalledTimes(1);
		expect(actions.fixDrivePath).not.toHaveBeenCalled();
		const yes = vi.fn(async () => true);
		await runFromSettings(t, find('fix-drive-path'), yes);
		expect(actions.fixDrivePath).toHaveBeenCalledWith(t);
	});

	it('does not add a second confirmation to a command that already asks (Reset)', async () => {
		const ask = vi.fn(async () => true);
		await runFromSettings(plugin(), find('reset'), ask);
		expect(ask).not.toHaveBeenCalled();
		expect(actions.reset).toHaveBeenCalledTimes(1);
	});
});
