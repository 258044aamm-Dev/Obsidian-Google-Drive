// In-memory Google Drive v3 speaking just enough HTTP for the plugin's real drive client.
import { createHash } from 'node:crypto';

type Revision = { id: string; content: Uint8Array };
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
	createdTime: string;
	/** every uploaded version of the content, oldest first; the last one is the head revision */
	revisions: Revision[];
};
type Change = { seq: number; fileId: string; removed: boolean };

const FOLDER = 'application/vnd.google-apps.folder';
const unesc = (s: string) => s.replace(/\\(['\\])/g, '$1');

export class FakeDrive {
	/** the drive of the world created last (lets small test helpers read files without being handed the world) */
	static current?: FakeDrive;
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
	/** if true, deleting a folder reports only the folder itself in the changes feed (descendants vanish silently) */
	omitDescendantRemovals = false;
	/** real Drive's feed may or may not report a trashed file as `removed`; default: it does NOT (only a non-removed change) */
	trashEmitsRemoved = false;
	/** make the "which files are in the Trash" listing fail (Pull must carry on without it) */
	failTrashedList = false;
	/** what Google's tokeninfo endpoint answers: the scopes of the access token, and whether it answers at all */
	grantedScope = 'https://www.googleapis.com/auth/drive.file';
	tokenInfoStatus = 200;
	/** how far the server clock runs ahead of the test clock; sent as the HTTP Date header of startPageToken */
	serverClockOffsetMs = 0;
	private revSeq = 1;
	constructor(vaultName: string) {
		this.vaultName = vaultName;
		FakeDrive.current = this;
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
	private newRevision(content: Uint8Array): Revision {
		return { id: 'rev' + this.revSeq++, content: content.slice() };
	}
	/** What a listing or metadata request returns: the file plus headRevisionId / md5Checksum / size (no revision bodies). */
	view(f: DFile) {
		const { revisions, ...rest } = f;
		const head = revisions[revisions.length - 1];
		return {
			...rest,
			...(head
				? {
						headRevisionId: head.id,
						md5Checksum: createHash('md5').update(head.content).digest('hex'),
						size: String(head.content.length),
					}
				: {}),
		};
	}
	/** Drive forgets an old (non-head) revision, e.g. after its retention period. Returns false if nothing was removed. */
	expireRevision(id: string, revisionId: string) {
		const f = this.files.get(id);
		if (!f || f.revisions.length < 2 || f.revisions[f.revisions.length - 1]!.id === revisionId) return false;
		const before = f.revisions.length;
		f.revisions = f.revisions.filter((r) => r.id !== revisionId);
		return f.revisions.length < before;
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
			createdTime: new Date().toISOString(),
			revisions: p.content ? [this.newRevision(p.content)] : [],
		});
		this.changes.push({ seq: this.changes.length + 1, fileId: id, removed: false });
		return id;
	}
	remove(id: string, report = true) {
		const f = this.files.get(id);
		if (!f) return false;
		if (f.mimeType === FOLDER) for (const c of [...this.files.values()]) if (c.parents.includes(id)) this.remove(c.id, report && !this.omitDescendantRemovals);
		this.files.delete(id);
		this.gone.add(id);
		if (report) this.changes.push({ seq: this.changes.length + 1, fileId: id, removed: true });
		return true;
	}
	/** Moves a file/folder to the Trash; a folder's descendants are trashed with it. */
	trash(id: string, report = true) {
		const f = this.files.get(id);
		if (!f) return false;
		if (!f.trashed) {
			f.trashed = true;
			if (report) this.changes.push({ seq: this.changes.length + 1, fileId: id, removed: this.trashEmitsRemoved });
		}
		if (f.mimeType === FOLDER) for (const c of [...this.files.values()]) if (c.parents.includes(id)) this.trash(c.id, report && !this.omitDescendantRemovals);
		return true;
	}
	/** Restores a file from the Trash (a folder's descendants come back with it). */
	untrash(id: string) {
		const f = this.files.get(id);
		if (!f) return false;
		f.trashed = false;
		this.changes.push({ seq: this.changes.length + 1, fileId: id, removed: false });
		if (f.mimeType === FOLDER) for (const c of [...this.files.values()]) if (c.parents.includes(id)) this.untrash(c.id);
		return true;
	}
	/** Encrypted vaults only: path id -> real path, recorded by the test harness, so snapshots stay readable. */
	plainPaths = new Map<string, string>();
	/** Encrypted vaults only: opens a file's stored bytes (set by the harness). */
	decryptContent?: (content: Uint8Array, f: DFile) => Promise<Uint8Array>;
	async contentOf(f: DFile) {
		if (!this.decryptContent || !f.content) return f.content;
		return this.decryptContent(f.content, f);
	}
	shown(f: DFile) {
		const path = f.properties.path;
		return path === undefined ? path : (this.plainPaths.get(path) ?? path);
	}
	/** what the user sees in Drive: path -> (folder | size) */
	snapshot() {
		return [...this.files.values()]
			.filter((f) => f.properties.obsidian !== 'vault' && !f.properties.history && !f.trashed)
			.map((f) => (f.mimeType === FOLDER ? this.shown(f) + '/' : this.shown(f)))
			.map((p) => p ?? '?')
			.sort();
	}
	snapshotNonConfig() {
		return [...this.files.values()]
			.filter((f) => f.properties.obsidian !== 'vault' && !f.properties.history && f.properties.config !== 'true' && !f.trashed)
			.map((f) => String(f.mimeType === FOLDER ? this.shown(f) + '/' : this.shown(f)))
			.sort();
	}

	private evalQ(q: string, f: DFile): boolean {
		const inTrash = q.match(/^trashed=true and properties has \{ key='vault' and value='((?:[^'\\]|\\.)*)' ?\}$/);
		if (inTrash) return f.trashed && f.properties.vault === unesc(inTrash[1] as string);
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

	/** Queries without the vault/modifiedTime conventions (the history folder and restore points): properties, parents, mimeType, trashed. */
	private evalPlainQ(q: string, f: DFile): boolean {
		if (/(^|\band )trashed=true/.test(q) !== f.trashed) return false;
		for (const m of q.matchAll(/properties has \{ key='((?:[^'\\]|\\.)*)' and value='((?:[^'\\]|\\.)*)' ?\}/g)) {
			if (f.properties[unesc(m[1] as string)] !== unesc(m[2] as string)) return false;
		}
		for (const m of q.matchAll(/'((?:[^'\\]|\\.)*)' in parents/g)) if (!f.parents.includes(unesc(m[1] as string))) return false;
		const mime = /mimeType='([^']*)'/.exec(q);
		if (mime && f.mimeType !== mime[1]) return false;
		return true;
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
		if (url.hostname === 'oauth2.googleapis.com' && path === '/tokeninfo') {
			if (this.tokenInfoStatus !== 200) return { status: this.tokenInfoStatus, text: '', json: {} };
			return ok({ scope: this.grantedScope, expires_in: '3599' });
		}
		if (url.hostname === 'www.google.com') return { status: this.offline ? 503 : 204, text: '', json: {} };

		if (method === 'GET' && path === '/drive/v3/changes/startPageToken') {
			return {
				...ok({ startPageToken: String(this.changes.length + 1) }),
				headers: { date: new Date(Date.now() + this.serverClockOffsetMs).toUTCString() },
			};
		}
		if (method === 'GET' && path === '/drive/v3/changes') {
			const from = Number(url.searchParams.get('pageToken'));
			if (!Number.isFinite(from) || from < 1) return { status: 400, text: 'Invalid Value', json: {} };
			const changes = this.changes
				.filter((c) => c.seq >= from)
				.map((c) => {
					const file = this.files.get(c.fileId);
					return { kind: 'drive#change', removed: c.removed, fileId: c.fileId, file: file ? this.view(file) : undefined };
				});
			return ok({ changes, newStartPageToken: String(this.changes.length + 1) });
		}
		if (method === 'GET' && path === '/drive/v3/files') {
			const q = url.searchParams.get('q') ?? '';
			if (this.failTrashedList && q.startsWith('trashed=true')) return { status: 500, text: 'injected trash listing failure', json: {} };
			if (q.includes("key='history'")) return ok({ files: [...this.files.values()].filter((f) => this.evalPlainQ(q, f)).map((f) => this.view(f)) });
			return ok({ files: [...this.files.values()].filter((f) => this.evalQ(q, f)).map((f) => this.view(f)) });
		}
		let m = /^\/drive\/v3\/files\/([^/]+)\/revisions\/([^/]+)$/.exec(path);
		if (m && method === 'GET') {
			const f = this.files.get(m[1]!);
			const r = f?.revisions.find((x) => x.id === m![2]);
			if (!f || !r) return { status: 404, text: 'Revision not found', json: {} };
			if (url.searchParams.get('alt') === 'media') return { status: 200, arrayBuffer: r.content.slice().buffer, text: '', json: {} };
			return ok({ id: r.id, size: String(r.content.length) });
		}
		m = /^\/drive\/v3\/files\/([^/]+)$/.exec(path);
		if (m && method === 'GET') {
			const f = this.files.get(m[1]!);
			if (!f) return { status: 404, text: 'notFound', json: {} };
			if (url.searchParams.get('alt') === 'media') {
				const b = (f.content ?? new Uint8Array()).slice().buffer;
				return { status: 200, arrayBuffer: b, text: '', json: {} };
			}
			return ok(this.view(f));
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
			{ const id = this.add({ ...meta }); return ok({ id, modifiedTime: this.files.get(id)!.modifiedTime }); }
		}
		if (method === 'POST' && path === '/upload/drive/v3/files') {
			const form = this.parseForm(req.body, req.contentType);
			const meta = JSON.parse(Buffer.from(form.metadata!).toString());
			{ const id = this.add({ ...meta, content: form.file }); return ok({ id, modifiedTime: this.files.get(id)!.modifiedTime }); }
		}
		m = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(path);
		if (m && method === 'PATCH') {
			const f = this.files.get(m[1]!);
			if (!f) return { status: 404, text: 'notFound', json: {} };
			const form = this.parseForm(req.body, req.contentType);
			Object.assign(f, JSON.parse(Buffer.from(form.metadata!).toString()));
			f.content = form.file!;
			f.revisions.push(this.newRevision(form.file!));
			this.changes.push({ seq: this.changes.length + 1, fileId: f.id, removed: false });
			return ok({ id: f.id, modifiedTime: f.modifiedTime });
		}
		if (method === 'POST' && path === '/batch/drive/v3') {
			const parts = String(req.body).split(/--batch_[0-9a-f-]+/).filter((x) => /(DELETE|PATCH) \/drive\/v3\/files\//.test(x));
			const text = parts
				.map((part) => {
					const [, verb, id] = /(DELETE|PATCH) \/drive\/v3\/files\/([^\s?]+)/.exec(part)!;
					let done: boolean;
					if (verb === 'DELETE') done = this.remove(id!);
					else {
						const body = JSON.parse(/\{.*\}/s.exec(part)![0]);
						done = body.trashed === true ? this.trash(id!) : false;
					}
					return `HTTP/1.1 ${done || (!this.strictBatch && this.gone.has(id!)) ? (verb === 'DELETE' ? 204 : 200) : 404} x`;
				})
				.join('\n');
			return { status: 200, text, json: {} };
		}
		return { status: 501, text: `fake drive: unhandled ${method} ${path}`, json: {} };
	};
}
