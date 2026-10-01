/**
 * A stand-in for the `obsidian` module in a real browser page. It is NOT Obsidian: it only offers what
 * helpers/header-button.ts and helpers/badge.ts touch, so their real code can run in Chromium.
 * The menu is drawn the way Obsidian draws one (a `.menu` with `.menu-item` rows) so a tap can be tried.
 */

declare global {
	interface HTMLElement {
		addClass(...c: string[]): void;
		removeClass(...c: string[]): void;
		setText(t: string): void;
		createSpan(o?: { cls?: string | string[]; text?: string }): HTMLSpanElement;
	}
}

// The helpers Obsidian adds to every element.
const proto = HTMLElement.prototype as any;
proto.addClass = function (...c: string[]) {
	this.classList.add(...c);
};
proto.removeClass = function (...c: string[]) {
	this.classList.remove(...c);
};
proto.setText = function (t: string) {
	this.textContent = t;
};
proto.createSpan = function (o: { cls?: string | string[]; text?: string } = {}) {
	const el = document.createElement('span');
	[o.cls ?? []].flat().forEach((c) => c && el.classList.add(...c.split(' ')));
	if (o.text) el.textContent = o.text;
	this.appendChild(el);
	return el;
};

interface Entry {
	title?: string;
	icon?: string;
	disabled?: boolean;
	click?: () => void;
	separator?: boolean;
}

export class Menu {
	entries: Entry[] = [];
	addItem(cb: (item: any) => void) {
		const entry: Entry = {};
		const item: any = {
			setTitle: (t: string) => ((entry.title = t), item),
			setIcon: (i: string) => ((entry.icon = i), item),
			setDisabled: (d: boolean) => ((entry.disabled = d), item),
			onClick: (fn: () => void) => ((entry.click = fn), item),
		};
		cb(item);
		this.entries.push(entry);
		return this;
	}
	addSeparator() {
		this.entries.push({ separator: true });
		return this;
	}
	showAtMouseEvent(evt: MouseEvent) {
		document.querySelector('.menu')?.remove();
		const menu = document.createElement('div');
		menu.className = 'menu';
		for (const e of this.entries) {
			if (e.separator) {
				menu.appendChild(Object.assign(document.createElement('div'), { className: 'menu-separator' }));
				continue;
			}
			const row = document.createElement('div');
			row.className = 'menu-item' + (e.disabled ? ' is-disabled' : '');
			row.textContent = e.title ?? '';
			row.addEventListener('click', () => {
				if (e.disabled) return;
				menu.remove();
				e.click?.();
			});
			menu.appendChild(row);
		}
		document.body.appendChild(menu);
		// like a popover under the pointer, kept inside the window
		const r = menu.getBoundingClientRect();
		const x = Math.max(4, Math.min(evt.clientX, window.innerWidth - r.width - 4));
		const y = Math.max(4, Math.min(evt.clientY, window.innerHeight - r.height - 4));
		menu.style.left = x + 'px';
		menu.style.top = y + 'px';
		return this;
	}
}

// Everything else the helpers import is not used by what the page runs.
export const Notice = class {};
export const Modal = class {};
export const Platform = { isMobile: false };
export const TFile = class {};
export const TFolder = class {};
export const normalizePath = (p: string) => p;
export const requestUrl = async () => ({ status: 0, json: {}, text: '', arrayBuffer: new ArrayBuffer(0) });
export const setIcon = () => {};
export const Setting = class {};
export const PluginSettingTab = class {};
export const Plugin = class {};
export const debounce = (fn: unknown) => fn;
