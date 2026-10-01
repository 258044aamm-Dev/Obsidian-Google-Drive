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

	/** Adds the icon to views that lack it, takes it away from all views when switched off, and updates the number. Never throws. */
	refresh() {
		this.update();
	}

	/** Every open view; a view that cannot take a header icon is left out. */
	private views(): (ActionView & { containerEl?: HTMLElement })[] {
		const ws = this.t.app.workspace;
		const found: (ActionView & { containerEl?: HTMLElement })[] = [];
		if (typeof ws?.iterateAllLeaves !== 'function') return found;
		ws.iterateAllLeaves((leaf) => {
			const view = leaf.view as unknown as (ActionView & { containerEl?: HTMLElement }) | undefined;
			if (view && typeof view.addAction === 'function') found.push(view);
		});
		return found;
	}

	/** Our icons that sit in a view's page, whether or not this object added them (a leftover cannot stay behind). */
	private iconsIn(view: { containerEl?: HTMLElement }): Element[] {
		const list = view.containerEl?.querySelectorAll?.('.ogd-header-action');
		return list ? Array.from(list) : [];
	}

	private attach() {
		const open = new Set<object>();
		for (const view of this.views()) {
			open.add(view);
			if (this.actions.has(view)) continue;
			// take away what an earlier round left in this view, then add the one icon
			this.iconsIn(view).forEach((el) => el.remove());
			const el = view.addAction!(HEADER_ICON, HEADER_TITLE, (evt) => this.open(evt));
			el.addClass('ogd-header-action');
			this.actions.set(view, el);
		}
		// forget views that are closed
		for (const view of [...this.actions.keys()]) if (!open.has(view)) this.actions.delete(view);
	}

	/**
	 * The icon, its number and the turning arrow. `busy` is given when a sync starts or ends; left out, the
	 * last state is kept. Also adds the icon to a view that has none (so switching the setting on works at
	 * once) and removes every icon when it is switched off.
	 */
	update(busy?: boolean) {
		try {
			if (busy !== undefined) this.busy = busy;
			if (!this.enabled()) {
				this.removeAll();
				return;
			}
			this.attach();
			const show = this.t.settings.ribbonBadges !== false;
			const pending = show ? Object.keys(this.t.settings.operations).length : 0;
			const waiting = show ? this.t.waitingOnDrive : undefined;
			for (const el of this.actions.values()) {
				setBadge(el, badgeText(headerCount(pending, waiting)), headerLabel(pending, waiting));
				if (this.busy) el.addClass('spin');
				else el.removeClass('spin');
			}
		} catch {
			// an icon that cannot be added must never get in the way of a sync
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
		// also any icon of ours that is not on the list (for example one a closed-and-reopened view kept)
		for (const view of this.views()) this.iconsIn(view).forEach((el) => el.remove());
	}

	destroy() {
		try {
			this.removeAll();
		} catch {
			// nothing left to clean up
		}
	}
}
