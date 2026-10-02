// Minimal in-memory stand-in for the parts of the Obsidian API the plugin touches.
// Shared by all simulated devices. Purpose: run the REAL plugin code end-to-end.
export const notices: string[] = [];
export const net: { handler: (req: any) => Promise<any> } = {
	handler: async () => ({ status: 500, text: 'no handler' }),
};
export const netLog: string[] = [];

export class TAbstractFile {
	path: string;
	name: string;
	parent: TFolder | null = null;
	constructor(path: string) {
		this.path = path;
		this.name = path.split('/').pop() as string;
	}
}
export class TFile extends TAbstractFile {}
export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];
}
export class Notice {
	constructor(message: string) {
		notices.push(message);
	}
	setMessage(_m: string) {}
	hide() {}
}
/** Text of every element a Modal created in onOpen (lets tests read the sync doctor report). */
export const modalTexts: string[] = [];
export class Modal {
	app: unknown;
	contentEl = {
		createEl: (_tag: string, o?: { text?: string }) => {
			if (o?.text) modalTexts.push(o.text);
			return { addEventListener: () => {} };
		},
		empty: () => {},
	};
	constructor(app?: unknown) {
		this.app = app;
	}
	setTitle(_t: string) {}
	open() {
		(this as unknown as { onOpen?: () => void }).onOpen?.();
	}
	close() {}
}
export class Setting {}
export const Platform = { isMobile: false };
export class Menu {
	items: { title?: string; icon?: string; disabled?: boolean; click?: () => void; separator?: boolean }[] = [];
	addItem(cb: (item: any) => void) {
		const entry: Menu['items'][number] = {};
		const item: any = {
			setTitle: (t: string) => ((entry.title = t), item),
			setIcon: (i: string) => ((entry.icon = i), item),
			setDisabled: (d: boolean) => ((entry.disabled = d), item),
			onClick: (fn: () => void) => ((entry.click = fn), item),
		};
		cb(item);
		this.items.push(entry);
		return this;
	}
	addSeparator() {
		this.items.push({ separator: true });
		return this;
	}
	showAtMouseEvent(_e: unknown) {
		lastMenu.current = this;
		return this;
	}
}
export const lastMenu: { current?: Menu } = {};
export class App {}
export class PluginSettingTab {
	plugin: any;
	update() {}
	/** What the real settings page does first: store the value in the plugin's settings. */
	async setControlValue(key: string, value: unknown) {
		if (this.plugin?.settings) this.plugin.settings[key] = value;
	}
}
export const setIcon = () => {};
export const debounce = (fn: any) => fn; // immediate
export const requestUrl = async (req: any) => {
	netLog.push(`${req.method ?? 'GET'} ${req.url}`);
	return net.handler(req);
};

export class Plugin {
	app: any;
	manifest: any;
	commands = new Map<string, any>();
	constructor(app: any, manifest: any) {
		this.app = app;
		this.manifest = manifest;
	}
	/** the settings tab the plugin added (tests read its definitions) */
	settingTab: any;
	addSettingTab(tab: any) {
		this.settingTab = tab;
	}
	/** Stand-in for the status bar element: records what the plugin put in it. */
	statusBarEls: any[] = [];
	addStatusBarItem() {
		const make = (): any => {
			const cls = new Set<string>();
			const el: any = {
				cls,
				text: '',
				attrs: {} as Record<string, string>,
				listeners: {} as Record<string, (e: any) => void>,
				children: [] as any[],
				removed: false,
				addClass: (c: string) => cls.add(c),
				removeClass: (c: string) => cls.delete(c),
				setText: (t: string) => (el.text = t),
				setAttribute: (k: string, v: string) => (el.attrs[k] = v),
				addEventListener: (type: string, fn: (e: any) => void) => (el.listeners[type] = fn),
				createSpan: (o?: { cls?: string }) => {
					const child = make();
					if (o?.cls) child.cls.add(o.cls);
					el.children.push(child);
					return child;
				},
				remove: () => (el.removed = true),
			};
			return el;
		};
		const el = make();
		this.statusBarEls.push(el);
		return el;
	}
	addRibbonIcon() {
		const cls = new Set<string>();
		return { addClass: (c: string) => cls.add(c), removeClass: (c: string) => cls.delete(c) };
	}
	addCommand(c: any) {
		this.commands.set(c.id, c);
	}
	registerEvent() {}
	/** Timers must not keep the test process alive. */
	registerInterval(id: any) {
		id?.unref?.();
		return id;
	}
	async loadData() {
		const p = `${this.app.vault.configDir}/plugins/google-drive-sync/data.json`;
		if (!(await this.app.vault.adapter.exists(p))) return null;
		return JSON.parse(new TextDecoder().decode(await this.app.vault.adapter.readBinary(p)));
	}
	async saveData(d: any) {
		const p = `${this.app.vault.configDir}/plugins/google-drive-sync/data.json`;
		await this.app.vault.adapter.mkdir(`${this.app.vault.configDir}/plugins/google-drive-sync`);
		await this.app.vault.adapter.writeBinary(p, new TextEncoder().encode(JSON.stringify(d)).buffer);
	}
}
