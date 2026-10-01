/**
 * Every command of this plugin, in one list.
 *
 * Two things read it, so they cannot drift apart:
 *  - `registerCommands` adds the commands to Obsidian's command palette (same ids, names and
 *    actions as before 3.8.2);
 *  - `commandsSettingGroup` draws the "Commands" section of the settings page: a searchable list
 *    with a Run button for each command (handy on a phone, where the palette is awkward).
 */
import { Modal, Notice, Setting } from 'obsidian';
import type { SettingDefinition, SettingDefinitionGroup } from 'obsidian';
import type ObsidianGoogleDrive from '../main';
import { runCompareActiveNote } from './compare-note-command';
import { runSyncDoctor } from './doctor-command';
import { fixDrivePath } from './fix_drive_path';
import { createRestorePointNow, startVaultRestore } from './history-ui';
import { pull } from './pull';
import { push } from './push';
import { renderRow } from './settings-row';
import { reset } from './reset';
import { runRepairSyncMemory } from './repair';
import { openTour } from './tour';

/** safe: only reads or copies; changes: changes data on this device or Drive; destructive: replaces or clears data. */
export type CommandRisk = 'safe' | 'changes' | 'destructive';

export type CommandGroup = 'Sync' | 'Checks' | 'History' | 'Repair' | 'Help';

export interface PluginCommand {
	/** Obsidian command id (without the plugin id prefix). Never change it: hotkeys depend on it. */
	id: string;
	/** Name in Obsidian's command palette. Never change it lightly: people search for it. */
	name: string;
	/** One line for the settings list. */
	desc: string;
	group: CommandGroup;
	risk: CommandRisk;
	/** Registered (and runnable) only once a refresh token has been added. */
	needsToken: boolean;
	/** Settings page only: ask first, for a command whose own flow does not ask. */
	confirm?: string;
	run: (t: ObsidianGoogleDrive) => unknown;
}

export const PLUGIN_COMMANDS: PluginCommand[] = [
	{
		id: 'open-tour',
		name: 'Open the getting-started tour',
		desc: 'A short step-by-step introduction: connect Google Drive, the first sync, optional encryption, daily use and the safety tools.',
		group: 'Help',
		risk: 'safe',
		needsToken: false,
		run: (t) => openTour(t),
	},
	{
		id: 'push',
		name: 'Push to Google Drive',
		desc: "Send this device's changes to Google Drive. A window shows what will be sent first.",
		group: 'Sync',
		risk: 'changes',
		needsToken: true,
		run: (t) => push(t),
	},
	{
		id: 'pull',
		name: 'Pull from Google Drive',
		desc: 'Bring the changes from Google Drive to this device. A note you changed here is kept; the Drive version is saved next to it as a copy.',
		group: 'Sync',
		risk: 'changes',
		needsToken: true,
		run: (t) => pull(t),
	},
	{
		id: 'reset',
		name: 'Reset local vault to Google Drive',
		desc: "Make this device's notes exactly what is on Google Drive. Local changes are lost. It asks you to confirm.",
		group: 'Repair',
		risk: 'destructive',
		needsToken: true,
		run: (t) => reset(t),
	},
	{
		id: 'fix-drive-path',
		name: 'Fix Google Drive paths',
		desc: 'Advanced repair: rebuilds the saved list of Drive files from Google Drive and clears the list of pending changes. Run the Sync doctor first.',
		group: 'Repair',
		risk: 'destructive',
		needsToken: true,
		confirm:
			'This rebuilds the saved Drive file list and clears the list of pending changes on this device. Changes that were not pushed yet are no longer remembered. Run the Sync doctor first if you are not sure. Continue?',
		run: (t) => fixDrivePath(t),
	},
	{
		id: 'repair-sync-memory',
		name: 'Repair sync memory (keeps your notes)',
		desc: 'For notes marked as changed that this device cannot judge (this is what makes "(Drive date)" copies appear every time). It checks each one against Drive, shows what it would do, and asks first. Nothing is deleted: a replaced note is kept as a copy.',
		group: 'Repair',
		risk: 'changes',
		needsToken: true,
		run: (t) => runRepairSyncMemory(t),
	},
	{
		id: 'sync-doctor',
		name: 'Sync doctor (read-only check of this device vs Google Drive)',
		desc: 'Compares this device with Google Drive and shows what a Pull or Push would do. It changes nothing.',
		group: 'Checks',
		risk: 'safe',
		needsToken: true,
		run: (t) => runSyncDoctor(t),
	},
	{
		id: 'compare-note-with-drive',
		name: 'Compare the open note with Google Drive (read-only)',
		desc: 'Shows whether the note that is open differs from its Google Drive copy and which one is newer. Open a note first.',
		group: 'Checks',
		risk: 'safe',
		needsToken: true,
		run: (t) => runCompareActiveNote(t),
	},
	{
		id: 'export-diagnostics',
		name: 'Copy sync diagnostics to clipboard',
		desc: 'Copies the recent sync diagnostics (what the plugin did and why) so you can send them for help.',
		group: 'Checks',
		risk: 'safe',
		needsToken: true,
		run: (t) => {
			void t.copyDiagnosticsToClipboard();
		},
	},
	{
		id: 'restore-vault-history',
		name: 'Restore the whole vault to an earlier restore point (version history)',
		desc: 'Go back to an earlier restore point. It changes this device first; you review the result and then push.',
		group: 'History',
		risk: 'changes',
		needsToken: true,
		run: (t) => startVaultRestore(t),
	},
	{
		id: 'create-restore-point',
		name: 'Create a restore point now (version history)',
		desc: 'Saves a restore point of the whole vault right now, without pushing anything else.',
		group: 'History',
		risk: 'changes',
		needsToken: true,
		run: (t) => createRestorePointNow(t),
	},
];

/**
 * Adds either the commands that are always available (`withToken` false) or the ones that need a
 * refresh token (`withToken` true) to Obsidian's command palette.
 */
export const registerCommands = (t: ObsidianGoogleDrive, withToken: boolean) => {
	for (const command of PLUGIN_COMMANDS) {
		if (command.needsToken !== withToken) continue;
		t.addCommand({
			id: command.id,
			name: command.name,
			callback: () => command.run(t),
		});
	}
};

const GROUP_ORDER: CommandGroup[] = ['Sync', 'Checks', 'History', 'Repair', 'Help'];

/** The commands in the order of the settings list: by group, then as listed above. */
export const commandsInDisplayOrder = (): PluginCommand[] =>
	GROUP_ORDER.flatMap((group) => PLUGIN_COMMANDS.filter((c) => c.group === group));

const RISK_LABEL: Record<CommandRisk, string> = {
	safe: 'Read-only.',
	changes: 'Changes data.',
	destructive: 'Destructive.',
};

export const describeCommand = (command: PluginCommand) =>
	`${command.group} · ${RISK_LABEL[command.risk]} ${command.desc}`;

/** True when every word of `query` appears in the text (case-insensitive). An empty query matches. */
export const matchesQuery = (text: string, query: string) => {
	const haystack = text.toLowerCase();
	return query
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean)
		.every((word) => haystack.includes(word));
};

class ConfirmRunModal extends Modal {
	constructor(
		t: ObsidianGoogleDrive,
		private readonly title: string,
		private readonly message: string,
		private readonly done: (ok: boolean) => void,
	) {
		super(t.app);
	}

	private answered = false;

	onOpen() {
		this.setTitle(this.title);
		this.contentEl.createEl('p', { text: this.message });
		new Setting(this.contentEl)
			.addButton((button) =>
				button.setButtonText('Cancel').onClick(() => this.close()),
			)
			.addButton((button) =>
				button
					.setButtonText('Run')
					.setDestructive()
					.setCta()
					.onClick(() => {
						this.answered = true;
						this.done(true);
						this.close();
					}),
			);
	}

	onClose() {
		this.contentEl.empty();
		if (!this.answered) this.done(false);
	}
}

const askToConfirm = (t: ObsidianGoogleDrive, command: PluginCommand) =>
	new Promise<boolean>((resolve) => {
		new ConfirmRunModal(t, command.name, command.confirm ?? '', resolve).open();
	});

/**
 * What the Run button of the settings list does: the same action as the palette command, after a
 * token check and, for a command whose own flow does not ask, a confirmation.
 */
export const runFromSettings = async (
	t: ObsidianGoogleDrive,
	command: PluginCommand,
	confirm: (t: ObsidianGoogleDrive, command: PluginCommand) => Promise<boolean> = askToConfirm,
) => {
	if (command.needsToken && !t.settings.refreshToken) {
		new Notice('Add your refresh token first. The first settings on this page explain how.');
		return;
	}
	if (command.confirm && !(await confirm(t, command))) return;
	await command.run(t);
};

/** The "Commands" section of the settings page: a searchable list, one row per command. */
export const commandsSettingGroup = (t: ObsidianGoogleDrive): SettingDefinitionGroup => ({
	type: 'group',
	heading: 'Commands',
	cls: 'ogd-commands',
	search: {
		placeholder: 'Search the commands of this plugin',
		match: (def: SettingDefinition, query: string) =>
			matchesQuery(
				`${def.name} ${typeof def.desc === 'string' ? def.desc : ''} ${(def.aliases ?? []).join(' ')}`,
				query,
			),
	},
	items: [
		{
			name: 'Hotkeys',
			searchable: false,
			render: (setting) => {
				renderRow(
					setting,
					'Hotkeys',
					'Every command below is also in the command palette. To give one a key, open Settings → Hotkeys and search for "Google Drive".',
				);
			},
		},
		...commandsInDisplayOrder().map(
			(command): SettingDefinition => ({
				name: command.name,
				desc: describeCommand(command),
				aliases: [command.id, command.group, command.risk],
				render: (setting) => {
					const needsToken = command.needsToken && !t.settings.refreshToken;
					const controls = renderRow(
						setting,
						command.name,
						needsToken
							? `${describeCommand(command)} Needs your refresh token first.`
							: describeCommand(command),
					);
					const button = controls.createEl('button', { text: 'Run' });
					if (command.risk === 'destructive') button.addClass('mod-warning');
					if (needsToken) button.disabled = true;
					button.addEventListener('click', () => {
						void runFromSettings(t, command);
					});
				},
			}),
		),
	],
});
