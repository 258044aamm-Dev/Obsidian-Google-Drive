/**
 * Status bar button (bottom right of Obsidian on desktop): "Drive" plus the number of pending
 * changes on this device. Clicking it opens a menu with the plugin's actions. The phone app
 * has no status bar, so nothing is added there.
 */
import { Menu, Platform, setIcon } from 'obsidian';
import type ObsidianGoogleDrive from '../main';
import { pull } from './pull';
import { push } from './push';
import { runSyncDoctor } from './doctor-command';
import { createRestorePointNow, startVaultRestore } from './history-ui';

export const statusBarText = (pending: number, syncing: boolean) =>
	syncing ? 'Drive …' : pending > 0 ? `Drive ${pending}` : 'Drive';

export const statusBarTooltip = (pending: number, syncing: boolean) =>
	syncing
		? 'Google Drive sync is running.'
		: pending > 0
			? `Google Drive: ${pending} pending change${pending === 1 ? '' : 's'} on this device. Click for actions.`
			: 'Google Drive: no pending changes on this device. Click for actions.';

export interface StatusBar {
	/** `spinning` is given when a sync starts or ends; left out, the last state is kept. */
	update: (spinning?: boolean) => void;
	remove: () => void;
}

/** Builds the menu shown when the button is clicked. Exported for tests. */
export const buildStatusBarMenu = (t: ObsidianGoogleDrive, menu: Menu) => {
	const pending = Object.keys(t.settings.operations).length;
	menu.addItem((item) =>
		item
			.setTitle(
				`${pending} pending change${pending === 1 ? '' : 's'} on this device`,
			)
			.setIcon('info')
			.setDisabled(true),
	);
	menu.addSeparator();
	menu.addItem((item) =>
		item
			.setTitle('Pull from Google Drive')
			.setIcon('cloud-download')
			.onClick(() => void pull(t)),
	);
	menu.addItem((item) =>
		item
			.setTitle('Push to Google Drive')
			.setIcon('refresh-cw')
			.onClick(() => void push(t)),
	);
	menu.addSeparator();
	menu.addItem((item) =>
		item
			.setTitle('Sync doctor (read-only check)')
			.setIcon('stethoscope')
			.onClick(() => void runSyncDoctor(t)),
	);
	menu.addItem((item) =>
		item
			.setTitle('Restore the whole vault from history')
			.setIcon('history')
			.onClick(() => void startVaultRestore(t)),
	);
	menu.addItem((item) =>
		item
			.setTitle('Create a restore point now')
			.setIcon('save')
			.onClick(() => void createRestorePointNow(t)),
	);
	return menu;
};

export const installStatusBar = (t: ObsidianGoogleDrive): StatusBar | undefined => {
	// The phone app has no status bar.
	// The phone app has no status bar.
	if (Platform.isMobile) return undefined;

	const el = t.addStatusBarItem();
	el.addClass('mod-clickable');
	el.addClass('ogd-status-bar');
	const icon = el.createSpan({ cls: 'ogd-status-icon' });
	setIcon(icon, 'refresh-cw');
	const label = el.createSpan({ cls: 'ogd-status-text' });

	let syncing = false;
	const update = (spinning?: boolean) => {
		if (spinning !== undefined) syncing = spinning;
		const pending = Object.keys(t.settings.operations).length;
		label.setText(statusBarText(pending, syncing));
		el.setAttribute('aria-label', statusBarTooltip(pending, syncing));
		if (syncing) icon.addClass('spin');
		else icon.removeClass('spin');
	};

	el.addEventListener('click', (event: MouseEvent) => {
		buildStatusBarMenu(t, new Menu()).showAtMouseEvent(event);
	});

	update();
	return { update, remove: () => el.remove() };
};
