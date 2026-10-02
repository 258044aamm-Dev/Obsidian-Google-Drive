import { net, notices, netLog } from './obsidian-mock';
import { FakeDrive } from './fake-drive';
import { FakeVault, enc, dec } from './fake-vault';

export { notices, netLog, enc, dec };
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** This device's key storage (a real device uses IndexedDB); it survives plugin restarts of the same device. */
const memoryKeyStore = () => {
	const map = new Map<string, unknown>();
	return {
		get: async (id: string) => map.get(id),
		put: async (id: string, key: unknown) => void map.set(id, key),
		delete: async (id: string) => void map.delete(id),
	};
};

export class Device {
	vault: FakeVault;
	plugin: any;
	label: string;
	keyStore = memoryKeyStore();
	constructor(label: string, public world: World, vault?: FakeVault, public root?: string) {
		this.label = label;
		this.vault = vault ?? new FakeVault(world.vaultName);
		// a real install always has the plugin folder with main.js/manifest.json on disk
		const dir = `${this.vault.configDir}/plugins/google-drive-sync`;
		if (!this.vault.disk.has(dir)) {
			for (const d of [this.vault.configDir, `${this.vault.configDir}/plugins`, dir]) this.vault.disk.set(d, { type: 'folder', mtime: 1 });
			this.vault.disk.set(`${dir}/main.js`, { type: 'file', data: new Uint8Array(enc('//plugin')), mtime: 1 } as any);
			this.vault.disk.set(`${dir}/manifest.json`, { type: 'file', data: new Uint8Array(enc('{}')), mtime: 1 } as any);
		}
	}
	/** (Re)start Obsidian on this device: fresh plugin instance, state loaded from data.json on disk, then layout-ready → startup pull. */
	async start(opts: { startupPull?: boolean; settings?: Record<string, unknown> } = {}) {
		const { default: Plugin } = await import(this.root ? this.root + '/main.ts' : this.world.mainPath);
		const app = {
			vault: this.vault,
			fileManager: this.vault.fileManager,
			workspace: { on: () => ({}), onLayoutReady: (cb: () => void) => (layoutCb = cb) },
		};
		let layoutCb: () => void = () => {};
		this.vault.handlers = {};
		const p = new Plugin(app, { id: 'google-drive-sync', version: this.world.version });
		p.app = app;
		p.keyStore = this.keyStore;
		await this.withRefreshToken(p, { ...this.world.defaultSettings, ...opts.settings });
		await p.onload();
		p.accessToken = { token: 'tok', expiresAt: Date.now() + 3_600_000 };
		this.plugin = p;
		if (opts.startupPull !== false) {
			layoutCb();
			await this.quiet();
		} else {
			// register vault listeners (done inside onLayoutReady) but skip the startup pull: pretend we're offline for that instant
			this.world.drive.offline = true;
			layoutCb();
			await sleep(15);
			this.world.drive.offline = false;
		}
		return p;
	}
	private async withRefreshToken(p: any, extra: Record<string, unknown> = {}) {
		const orig = p.loadData.bind(p);
		p.loadData = async () => ({ operations: {}, driveIdToPath: {}, ...((await orig()) ?? {}), refreshToken: 'r', ...extra });
	}
	async quiet() {
		let last = -1;
		for (let i = 0; i < 400; i++) {
			await sleep(8);
			if (netLog.length === last && !this.plugin?.syncing) return;
			last = netLog.length;
		}
		throw new Error('never went quiet');
	}
	async pull(silent = false) {
		const { pull } = await import(this.root ? this.root + '/helpers/pull.ts' : this.world.pullPath);
		notices.length = 0;
		const r = await pull(this.plugin, silent);
		await sleep(5);
		return r;
	}
	async push() {
		const { push } = await import(this.root ? this.root + '/helpers/push.ts' : this.world.pushPath);
		notices.length = 0;
		await push(this.plugin, true);
		await sleep(5);
	}
	/** The "Push without pulling" button of the Push window (fork only). */
	async pushWithoutPull() {
		const { push } = await import(this.root ? this.root + '/helpers/push.ts' : this.world.pushPath);
		notices.length = 0;
		await push(this.plugin, true, true);
		await sleep(5);
	}
	async save() {
		await this.plugin.saveSettings();
	}
	tree() {
		return this.vault.tree();
	}
	ops() {
		return { ...this.plugin.settings.operations };
	}
}

export class World {
	drive: FakeDrive;
	/** settings every device in this world starts with (tests override per scenario) */
	defaultSettings: Record<string, unknown> = {};
	vaultName = 'V';
	version: string;
	mainPath: string;
	pullPath: string;
	pushPath: string;
	constructor(root: string, version: string) {
		this.drive = new FakeDrive(this.vaultName);
		this.version = version;
		this.mainPath = root + '/main.ts';
		this.pullPath = root + '/helpers/pull.ts';
		this.pushPath = root + '/helpers/push.ts';
		net.handler = this.drive.handler;
	}
	/** `root` lets one device run a different plugin checkout (e.g. upstream) against the same Drive. */
	device(label: string, vault?: FakeVault, root?: string) {
		return new Device(label, this, vault, root);
	}
}

export const diff = (a: string[], b: string[]) => ({
	onlyA: a.filter((x) => !b.includes(x)),
	onlyB: b.filter((x) => !a.includes(x)),
});
