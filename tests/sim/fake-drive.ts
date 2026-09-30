// In-memory Google Drive v3 speaking just enough HTTP for the plugin's real drive client.
type DFile = {
	id: string;
	name: string;
	mimeType: string;
	parents: string[];
	properties: Record<string, string>;
	modifiedTime: string;
	description?: string;
	starred: boolean;
	trashed: boolean;
	content: Uint8Array | null;
};
type Change = { seq: number; fileId: string; removed: boolean };

const FOLDER = 'application/vnd.google-apps.folder';
const unesc = (s: string) => s.replace(/\\(['\\])/g, '$1');

export class FakeDrive {
	files = new Map<string, DFile>();
	changes: Change[] = [];
	seq = 1;
	vaultName: string;
	rootId: string;
	failNext: { match: RegExp; status: number }[] = [];
	offline = false;
	/** real Drive may answer 404 for a child whose parent folder was deleted earlier in the same batch; unknown, so default lenient */
	strictBatch = false;
	gone = new Set<string>();
	constructor(vaultName: string) {
		this.vaultName = vaultName;
		this.rootId = this.add({
			name: vaultName,
			mimeType: FOLDER,
			parents: [],
			properties: { obsidian: 'vault', vault: vaultName },
		});
	}
	private nid() {
		return 'id' + this.seq++;
	}
	add(p: Partial<DFile>) {
		const id = this.nid();
		this.files.set(id, {
			id,
			name: p.name ?? '',
			mimeType: p.mimeType ?? 'application/octet-stream',
			parents: p.parents ?? [],
			properties: p.properties ?? {},
			modifiedTime: p.modifiedTime ?? new Date().toISOString(),
			description: p.description,
			starred: false,
			trashed: false,
			content: p.content ?? null,
		});
		this.changes.push({ seq: this.changes.length + 1, fileId: id, removed: false });
		return id;
	}
	remove(id: string) {
		const f = this.files.get(id);
		if (!f) return false;
		if (f.mimeType === FOLDER) for (const c of [...this.files.values()]) if (c.parents.includes(id)) this.remove(c.id);
		this.files.delete(id);
		this.gone.add(id);
		this.changes.push({ seq: this.changes.length + 1, fileId: id, removed: true });
		return true;
	}
	/** what the user sees in Drive: path -> (folder | size) */
	snapshot() {
		return [...this.files.values()]
			.filter((f) => f.properties.obsidian !== 'vault' && !f.trashed)
			.map((f) => (f.mimeType === FOLDER ? f.properties.path + '/' : f.properties.path))
			.map((p) => p ?? '?')
			.sort();
	}
	snapshotNonConfig() {
		return [...this.files.values()]
			.filter((f) => f.properties.obsidian !== 'vault' && f.properties.config !== 'true')
			.map((f) => String(f.mimeType === FOLDER ? f.properties.path + '/' : f.properties.path))
			.sort();
	}

	private evalQ(q: string, f: DFile): boolean {
		if (f.trashed) return false;
		const tail = q.match(/properties has \{ key='vault' and value='((?:[^'\\]|\\.)*)' ?\}$/);
		if (tail && f.properties.vault !== unesc(tail[1] as string)) return false;
		const headEnd = q.indexOf(' and trashed=false');
		if (headEnd < 0) return true; // no extra matches
		const head = q.slice(1, headEnd - 1); // strip outer ( )
		const groups = head.split(/\) or \(/).map((g) => g.replace(/^\(/, '').replace(/\)$/, ''));
		return groups.some((g) => {
			let any = false;
			let ok = true;
			for (const m of g.matchAll(/properties has \{ key='((?:[^'\\]|\\.)*)' and value='((?:[^'\\]|\\.)*)' \}/g)) {
				any = true;
				if (f.properties[unesc(m[1] as string)] !== unesc(m[2] as string)) ok = false;
			}
			for (const m of g.matchAll(/modifiedTime([<>=])'([^']*)'/g)) {
				any = true;
				const a = Date.parse(f.modifiedTime);
				const b = Date.parse(m[2] as string);
				if (m[1] === '>' ? !(a > b) : m[1] === '<' ? !(a < b) : a !== b) ok = false;
			}
			return any && ok;
		});
	}

	private parseForm(body: ArrayBuffer, contentType: string) {
		const boundary = /boundary=(.+)$/.exec(contentType)![1]!;
		const raw = Buffer.from(body).toString('latin1');
		const out: Record<string, Uint8Array> = {};
		for (const part of raw.split('--' + boundary)) {
			const i = part.indexOf('\r\n\r\n');
			if (i < 0) continue;
			const name = /name="([^"]+)"/.exec(part.slice(0, i))?.[1];
			if (!name) continue;
			const content = part.slice(i + 4).replace(/\r\n$/, '');
			out[name] = Uint8Array.from(Buffer.from(content, 'latin1'));
		}
		return out;
	}

	handler = async (req: any) => {
		const url = new URL(req.url);
		const method = req.method ?? 'GET';
		const path = url.pathname;
		const ok = (json: any) => ({ status: 200, json, text: JSON.stringify(json), arrayBuffer: new ArrayBuffer(0) });
		for (const f of this.failNext) {
			if (f.match.test(method + ' ' + path)) {
				this.failNext.splice(this.failNext.indexOf(f), 1);
				return { status: f.status, text: 'injected failure', json: {} };
			}
		}
		if (url.hostname === 'www.google.com') return { status: this.offline ? 503 : 204, text: '', json: {} };

		if (method === 'GET' && path === '/drive/v3/changes/startPageToken') {
			return ok({ startPageToken: String(this.changes.length + 1) });
		}
		if (method === 'GET' && path === '/drive/v3/changes') {
			const from = Number(url.searchParams.get('pageToken'));
			if (!Number.isFinite(from) || from < 1) return { status: 400, text: 'Invalid Value', json: {} };
			const changes = this.changes
				.filter((c) => c.seq >= from)
				.map((c) => ({ kind: 'drive#change', removed: c.removed, fileId: c.fileId, file: this.files.get(c.fileId) }));
			return ok({ changes, newStartPageToken: String(this.changes.length + 1) });
		}
		if (method === 'GET' && path === '/drive/v3/files') {
			const q = url.searchParams.get('q') ?? '';
			return ok({ files: [...this.files.values()].filter((f) => this.evalQ(q, f)) });
		}
		let m = /^\/drive\/v3\/files\/([^/]+)$/.exec(path);
		if (m && method === 'GET') {
			const f = this.files.get(m[1]!);
			if (!f) return { status: 404, text: 'notFound', json: {} };
			if (url.searchParams.get('alt') === 'media') {
				const b = (f.content ?? new Uint8Array()).slice().buffer;
				return { status: 200, arrayBuffer: b, text: '', json: {} };
			}
			return ok(f);
		}
		if (m && method === 'DELETE') {
			return this.remove(m[1]!) ? { status: 204, text: '', json: {} } : { status: 404, text: 'notFound', json: {} };
		}
		if (m && method === 'PATCH') {
			const f = this.files.get(m[1]!);
			if (!f) return { status: 404, text: 'notFound', json: {} };
			Object.assign(f, JSON.parse(req.body));
			this.changes.push({ seq: this.changes.length + 1, fileId: f.id, removed: false });
			return ok({ id: f.id });
		}
		if (method === 'POST' && path === '/drive/v3/files') {
			const meta = JSON.parse(req.body);
			return ok({ id: this.add({ ...meta }) });
		}
		if (method === 'POST' && path === '/upload/drive/v3/files') {
			const form = this.parseForm(req.body, req.contentType);
			const meta = JSON.parse(Buffer.from(form.metadata!).toString());
			return ok({ id: this.add({ ...meta, content: form.file }) });
		}
		m = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(path);
		if (m && method === 'PATCH') {
			const f = this.files.get(m[1]!);
			if (!f) return { status: 404, text: 'notFound', json: {} };
			const form = this.parseForm(req.body, req.contentType);
			Object.assign(f, JSON.parse(Buffer.from(form.metadata!).toString()));
			f.content = form.file!;
			this.changes.push({ seq: this.changes.length + 1, fileId: f.id, removed: false });
			return ok({ id: f.id });
		}
		if (method === 'POST' && path === '/batch/drive/v3') {
			const ids = [...String(req.body).matchAll(/DELETE \/drive\/v3\/files\/(\S+) HTTP/g)].map((x) => x[1]!);
			const text = ids.map((id) => `HTTP/1.1 ${this.remove(id) || (!this.strictBatch && this.gone.has(id)) ? 204 : 404} x`).join('\n');
			return { status: 200, text, json: {} };
		}
		return { status: 501, text: `fake drive: unhandled ${method} ${path}`, json: {} };
	};
}
