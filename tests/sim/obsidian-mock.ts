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
export class Menu {}
export class App {}
export class PluginSettingTab {}
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
	addSettingTab() {}
	addRibbonIcon() {
		const cls = new Set<string>();
		return { addClass: (c: string) => cls.add(c), removeClass: (c: string) => cls.delete(c) };
	}
	addCommand(c: any) {
		this.commands.set(c.id, c);
	}
	registerEvent() {}
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
