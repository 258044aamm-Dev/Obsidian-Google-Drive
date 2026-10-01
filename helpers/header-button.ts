/**
 * A Drive icon in the header of every note (3.12.0 on phones and tablets, 3.13.0 also on a desktop).
 *
 * On a phone the ribbon is hidden in a menu, so the counts on the Push and Pull icons (3.9.0) are never
 * in sight. This icon sits in the header, next to the three-dots button, so it is visible without
 * opening any menu. A desktop gets the same icon, so both work the same way. Tapping it opens a small menu with Push and Pull, and the user picks either one. Both
 * are always offered. A small number on the icon says how many changes are waiting (on this device, plus
 * on Google Drive when the Drive check is on). While a sync runs the icon turns and the menu is greyed out.
 *
 * Everything it does is also done by the ribbon icons; it only makes them reachable on a phone.
 */
import { Menu } from 'obsidian';
import type ObsidianGoogleDrive from '../main';
import { badgeText, setBadge } from './badge';

export const HEADER_ICON = 'arrow-up-down';
export const HEADER_TITLE = 'Google Drive: Push or Pull';

export const pushMenuLabel = (pending: number) =>
	pending > 0 ? `Push to Google Drive (${pending} waiting on this device)` : 'Push to Google Drive';

/** `waiting` is undefined when Drive was not asked (the check is off, or it could not tell). */
export const pullMenuLabel = (waiting: number | undefined) =>
	waiting && waiting > 0 ? `Pull from Google Drive (${waiting} waiting on Google Drive)` : 'Pull from Google Drive';

/** The number on the icon: what waits on this device plus what is known to wait on Drive. */
export const headerCount = (pending: number, waiting: number | undefined) => pending + (waiting && waiting > 0 ? waiting : 0);

export const headerLabel = (pending: number, waiting: number | undefined) => {
	const n = headerCount(pending, waiting);
	return n > 0 ? `${HEADER_TITLE} (${n} change${n === 1 ? '' : 's'} waiting)` : HEADER_TITLE;
};

export interface HeaderHandlers {
	onPush: () => void;
	onPull: () => void;
}

interface ActionView {
	addAction?: (icon: string, title: string, cb: (evt: MouseEvent) => unknown) => HTMLElement;
}

export class HeaderButton {
	/** The icon added to each view, so a view never gets two. */
	private actions = new Map<object, HTMLElement>();
	private busy = false;

	constructor(
		private t: ObsidianGoogleDrive,
		private handlers: HeaderHandlers,
	) {}

	private enabled() {
		return this.t.settings.headerButton !== false;
	}

	/** Starts following the open views. */
	start() {
		const ws = this.t.app.workspace;
		this.t.registerEvent(ws.on('layout-change', () => this.refresh()));
		this.t.registerEvent(ws.on('active-leaf-change', () => this.refresh()));
		this.refresh();
	}

	/** Adds the icon to views that lack it, and takes it away from all views when switched off. Never throws. */
	refresh() {
		try {
			if (!this.enabled()) {
				this.removeAll();
				return;
			}
			const ws = this.t.app.workspace;
			if (typeof ws?.iterateAllLeaves !== 'function') return;
			const open = new Set<object>();
			ws.iterateAllLeaves((leaf) => {
				const view = leaf.view as unknown as ActionView | undefined;
				if (!view || typeof view.addAction !== 'function') return;
				open.add(view);
				if (this.actions.has(view)) return;
				const el = view.addAction(HEADER_ICON, HEADER_TITLE, (evt) => this.open(evt));
				el.addClass('ogd-header-action');
				this.actions.set(view, el);
			});
			// forget views that are closed
			for (const view of [...this.actions.keys()]) if (!open.has(view)) this.actions.delete(view);
			this.update();
		} catch {
			// an icon that cannot be added must never get in the way of a sync
		}
	}

	/** The number and the turning arrow. `busy` is given when a sync starts or ends; left out, the last state is kept. */
	update(busy?: boolean) {
		try {
			if (busy !== undefined) this.busy = busy;
			if (!this.enabled()) {
				this.removeAll();
				return;
			}
			const show = this.t.settings.ribbonBadges !== false;
			const pending = show ? Object.keys(this.t.settings.operations).length : 0;
			const waiting = show ? this.t.waitingOnDrive : undefined;
			for (const el of this.actions.values()) {
				setBadge(el, badgeText(headerCount(pending, waiting)), headerLabel(pending, waiting));
				if (this.busy) el.addClass('spin');
				else el.removeClass('spin');
			}
		} catch {
			// see refresh()
		}
	}

	/** The menu of the icon: Push and Pull, both always offered. */
	open(evt: MouseEvent) {
		const show = this.t.settings.ribbonBadges !== false;
		const pending = show ? Object.keys(this.t.settings.operations).length : 0;
		const waiting = show ? this.t.waitingOnDrive : undefined;
		const running = this.busy || this.t.syncing;
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle(pushMenuLabel(pending))
				.setIcon('refresh-cw')
				.setDisabled(running)
				.onClick(() => this.handlers.onPush()),
		);
		menu.addItem((item) =>
			item
				.setTitle(pullMenuLabel(waiting))
				.setIcon('cloud-download')
				.setDisabled(running)
				.onClick(() => this.handlers.onPull()),
		);
		menu.showAtMouseEvent(evt);
	}

	removeAll() {
		for (const el of this.actions.values()) el.remove();
		this.actions.clear();
	}

	destroy() {
		try {
			this.removeAll();
		} catch {
			// nothing left to clean up
		}
	}
}
