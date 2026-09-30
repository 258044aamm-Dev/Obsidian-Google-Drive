import { TAbstractFile, TFile, TFolder } from './obsidian-mock';

type Entry = { type: 'file' | 'folder'; data?: Uint8Array; mtime: number };
type Handler = (...a: any[]) => void;

export const enc = (s: string) => new TextEncoder().encode(s).buffer;
export const dec = (b: ArrayBuffer | Uint8Array) => new TextDecoder().decode(b);

/** In-memory vault + adapter that mimics Obsidian semantics closely enough for sync logic. */
export class FakeVault {
	disk = new Map<string, Entry>();
	idx = new Map<string, TAbstractFile>();
	handlers: Record<string, Handler[]> = {};
	configDir = '.obsidian';
	/** Obsidian fires 'rename' / 'delete' for every descendant of a folder (believed; toggle to test sensitivity). */
	eventsForChildren = true;
	name: string;
	adapter: any;
	fileManager: any;

	constructor(name: string) {
		this.name = name;
		this.idx.set('/', new TFolder('/'));
		this.adapter = {
			exists: async (p: string) => this.disk.has(p),
			stat: async (p: string) => {
				const e = this.disk.get(p);
				return e ? { type: e.type, mtime: e.mtime, size: e.data?.length ?? 0 } : null;
			},
			list: async (p: string) => {
				const files: string[] = [];
				const folders: string[] = [];
				for (const [k, e] of this.disk) {
					if (k.startsWith(p + '/') && !k.slice(p.length + 1).includes('/')) (e.type === 'file' ? files : folders).push(k);
				}
				return { files, folders };
			},
			readBinary: async (p: string) => {
				const e = this.disk.get(p);
				if (!e?.data) throw new Error('ENOENT ' + p);
				return e.data.slice().buffer;
			},
			writeBinary: async (p: string, data: ArrayBuffer, o?: { mtime?: number }) => {
				this.requireParent(p);
				const existed = this.disk.has(p);
				this.disk.set(p, { type: 'file', data: new Uint8Array(data.slice(0)), mtime: o?.mtime ?? Date.now() });
				if (!this.isConfig(p)) {
					this.refresh();
					this.emit(existed ? 'modify' : 'create', this.idx.get(p));
				}
			},
			mkdir: async (p: string) => {
				const parts = p.split('/');
				for (let i = 1; i <= parts.length; i++) {
					const q = parts.slice(0, i).join('/');
					if (!this.disk.has(q)) this.disk.set(q, { type: 'folder', mtime: Date.now() });
				}
				this.refresh();
			},
			remove: async (p: string) => {
				this.disk.delete(p);
				this.refresh();
			},
			rmdir: async (p: string) => {
				this.disk.delete(p);
				this.refresh();
			},
			trashLocal: async (p: string) => this.adapter.remove(p),
			trashSystem: async (p: string) => this.adapter.remove(p),
		};
		this.fileManager = { trashFile: async (f: TAbstractFile) => this.delete(f) };
	}

	getName() {
		return this.name;
	}
	getConfig(_k: string) {
		return 'local';
	}
	isConfig(p: string) {
		return p === this.configDir || p.startsWith(this.configDir + '/');
	}
	requireParent(p: string) {
		const parent = p.split('/').slice(0, -1).join('/');
		if (parent && !this.disk.has(parent)) throw new Error(`ENOENT: parent folder missing for ${p}`);
	}
	on(evt: string, h: Handler) {
		(this.handlers[evt] ||= []).push(h);
		return {};
	}
	emit(evt: string, ...a: any[]) {
		(this.handlers[evt] || []).forEach((h) => h(...a));
	}

	/** Rebuild Obsidian's file index (config dir is NOT indexed, like the real vault). */
	refresh() {
		const next = new Map<string, TAbstractFile>();
		const root = (this.idx.get('/') as TFolder) ?? new TFolder('/');
		root.children = [];
		next.set('/', root);
		const paths = [...this.disk.keys()].filter((p) => !this.isConfig(p)).sort();
		for (const p of paths) {
			const e = this.disk.get(p)!;
			let obj = this.idx.get(p);
			if (!obj || (e.type === 'file') !== obj instanceof TFile) obj = e.type === 'file' ? new TFile(p) : new TFolder(p);
			if (obj instanceof TFolder) obj.children = [];
			next.set(p, obj);
		}
		for (const p of paths) {
			const obj = next.get(p)!;
			const parentPath = p.split('/').slice(0, -1).join('/') || '/';
			const parent = next.get(parentPath) as TFolder;
			obj.parent = parent;
			parent.children.push(obj);
		}
		this.idx = next;
	}

	getAbstractFileByPath(p: string) {
		return p === '/' ? this.idx.get('/') : (this.idx.get(p) ?? null);
	}
	getFileByPath(p: string) {
		const f = this.idx.get(p);
		return f instanceof TFile ? f : null;
	}
	getFolderByPath(p: string) {
		const f = this.idx.get(p);
		return f instanceof TFolder ? f : null;
	}
	getAllLoadedFiles() {
		return [...this.idx.values()];
	}
	descendants(p: string) {
		return [...this.disk.keys()].filter((k) => k.startsWith(p + '/')).sort((a, b) => b.length - a.length);
	}

	async createFolder(p: string) {
		if (this.disk.has(p)) throw new Error('Folder already exists.');
		await this.adapter.mkdir(p);
		this.emit('create', this.idx.get(p));
		return this.idx.get(p);
	}
	async create(p: string, text: string) {
		return this.createBinary(p, enc(text));
	}
	async createBinary(p: string, data: ArrayBuffer, o?: { mtime?: number }) {
		if (this.disk.has(p)) throw new Error('File already exists.');
		this.requireParent(p);
		this.disk.set(p, { type: 'file', data: new Uint8Array(data.slice(0)), mtime: o?.mtime ?? Date.now() });
		this.refresh();
		this.emit('create', this.idx.get(p));
		return this.idx.get(p);
	}
	async modifyBinary(f: TFile, data: ArrayBuffer, o?: { mtime?: number }) {
		this.disk.set(f.path, { type: 'file', data: new Uint8Array(data.slice(0)), mtime: o?.mtime ?? Date.now() });
		this.emit('modify', f);
	}
	async modify(f: TFile, text: string) {
		return this.modifyBinary(f, enc(text));
	}
	async readBinary(f: TFile) {
		return this.adapter.readBinary(f.path);
	}
	async read(f: TFile) {
		return dec(await this.readBinary(f));
	}
	async delete(f: TAbstractFile) {
		const p = f.path;
		const kids = this.descendants(p).map((k) => this.idx.get(k));
		const self = this.idx.get(p);
		for (const k of [...this.descendants(p), p]) this.disk.delete(k);
		this.refresh();
		if (this.eventsForChildren) kids.forEach((k) => k && this.emit('delete', k));
		this.emit('delete', self);
	}
	/** user-level rename/move, like dragging a folder in the file explorer */
	async rename(f: TAbstractFile, newPath: string) {
		const oldPath = f.path;
		const moved = [oldPath, ...this.descendants(oldPath).reverse()];
		const entries = moved.map((k) => [k, this.disk.get(k)!] as const);
		for (const [k] of entries) this.disk.delete(k);
		this.requireParent(newPath);
		const newPaths: string[] = [];
		for (const [k, e] of entries) {
			const np = newPath + k.slice(oldPath.length);
			this.disk.set(np, e);
			newPaths.push(np);
		}
		this.refresh();
		const list = this.eventsForChildren ? entries.map(([k]) => k) : [oldPath];
		for (const k of list) {
			const np = newPath + k.slice(oldPath.length);
			const obj = this.idx.get(np);
			// Real Obsidian keeps object identity; plugin only reads .path
			this.emit('rename', obj, k);
		}
	}
	/** Snapshot of the user-visible vault (excludes config dir) */
	tree() {
		return [...this.disk.entries()]
			.filter(([p]) => !this.isConfig(p))
			.map(([p, e]) => (e.type === 'folder' ? p + '/' : p))
			.sort();
	}
}
