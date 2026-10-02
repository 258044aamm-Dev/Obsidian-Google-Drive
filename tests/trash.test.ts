import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestUrl = vi.hoisted(() => vi.fn());

vi.mock('obsidian', () => ({
	Notice: class {},
	requestUrl,
	TAbstractFile: class {},
	TFolder: class {},
}));

import { getDriveClient } from '../helpers/drive';
import { addTrashedAsRemoved } from '../helpers/trash';

const createPlugin = (settings: Record<string, unknown> = {}) =>
	({
		accessToken: { token: 'access-token', expiresAt: Date.now() + 3_600_000 },
		app: { vault: { getName: () => "Test 'vault'" } },
		settings: { refreshToken: 'r', rootFolderId: '', driveIdToPath: {}, ...settings },
		saveSettings: vi.fn(async () => undefined),
		diagnostics: {
			enabled: true,
			currentPhase: null,
			withContext: vi.fn(async (_p: string, _o: string, fn: () => Promise<unknown>) => fn()),
			record: vi.fn(),
		},
	}) as never;

const batchReply = (status: number) => async ({ body }: { body?: string | ArrayBuffer }) => {
	const text = typeof body === 'string' ? body : '';
	const count = text.match(/^(DELETE|PATCH) /gm)?.length ?? 0;
	return {
		status: 200,
		headers: {},
		arrayBuffer: new ArrayBuffer(0),
		json: {},
		text: Array.from({ length: count }, () => `HTTP/1.1 ${status} x`).join('\r\n'),
	};
};

describe('Drive batch deletion: Trash mode', () => {
	beforeEach(() => {
		requestUrl.mockReset();
		requestUrl.mockImplementation(batchReply(200));
	});

	it('moves files to the Trash with PATCH {trashed:true} when deleteToTrash is on', async () => {
		const drive = getDriveClient(createPlugin({ deleteToTrash: true }));
		await expect(drive.batchDelete(['file-1', 'file-2'])).resolves.toBe(true);

		const request = requestUrl.mock.calls[0]?.[0] as { body: string; headers: Record<string, string> };
		const boundary = request.headers['Content-Type']?.split('boundary=')[1];
		expect(request.body).toContain('PATCH /drive/v3/files/file-1?fields=id HTTP/1.1');
		expect(request.body).toContain('PATCH /drive/v3/files/file-2?fields=id HTTP/1.1');
		expect(request.body.match(/\{"trashed":true\}/g)).toHaveLength(2);
		expect(request.body).not.toMatch(/^DELETE /m);
		// the JSON body is followed directly by the multipart delimiter (no stray body bytes)
		expect(request.body).toContain(`{"trashed":true}\r\n--${boundary}`);
		expect(request.body).toMatch(new RegExp(`--${boundary}--\\r\\n$`));
	});

	it.each([[false], [undefined]])('still deletes permanently when deleteToTrash is %s', async (value) => {
		const drive = getDriveClient(createPlugin({ deleteToTrash: value }));
		await expect(drive.batchDelete(['file-1'])).resolves.toBe(true);
		const request = requestUrl.mock.calls[0]?.[0] as { body: string };
		expect(request.body).toContain('DELETE /drive/v3/files/file-1 HTTP/1.1');
		expect(request.body).not.toContain('PATCH');
	});

	it('treats a 404 (already gone) as success but any other failure as a failed push', async () => {
		const plugin = createPlugin({ deleteToTrash: true });
		const drive = getDriveClient(plugin);
		requestUrl.mockImplementation(batchReply(404));
		await expect(drive.batchDelete(['gone'])).resolves.toBe(true);

		requestUrl.mockImplementation(batchReply(403));
		await expect(drive.batchDelete(['forbidden'])).resolves.toBeUndefined();
	});

	it('splits more than 100 trashings into several requests', async () => {
		const drive = getDriveClient(createPlugin({ deleteToTrash: true }));
		const ids = Array.from({ length: 101 }, (_, i) => `f${i}`);
		await expect(drive.batchDelete(ids)).resolves.toBe(true);
		expect(requestUrl).toHaveBeenCalledTimes(2);
	});
});

describe('listTrashedFileIds', () => {
	beforeEach(() => requestUrl.mockReset());

	it('asks for trashed files of this vault only, follows pages and escapes the vault name', async () => {
		requestUrl
			.mockResolvedValueOnce({ status: 200, json: { files: [{ id: 'a' }], nextPageToken: 'next' }, text: '' })
			.mockResolvedValueOnce({ status: 200, json: { files: [{ id: 'b' }] }, text: '' });
		const drive = getDriveClient(createPlugin());

		await expect(drive.listTrashedFileIds()).resolves.toEqual(['a', 'b']);

		const first = new URL((requestUrl.mock.calls[0]?.[0] as { url: string }).url);
		expect(first.searchParams.get('q')).toBe("trashed=true and properties has { key='vault' and value='Test \\'vault\\'' }");
		expect(first.searchParams.get('fields')).toBe('nextPageToken,files(id)');
		const second = new URL((requestUrl.mock.calls[1]?.[0] as { url: string }).url);
		expect(second.searchParams.get('pageToken')).toBe('next');
	});
});

describe('addTrashedAsRemoved', () => {
	const change = (fileId: string, removed = false) => ({ kind: 'drive#change', fileId, removed, time: '' });

	interface Fake {
		drive: { listTrashedFileIds: () => Promise<string[] | undefined> };
		diagnostics: { record: ReturnType<typeof vi.fn> };
		settings: { driveIdToPath: Record<string, string> };
	}
	const fakePlugin = (driveIdToPath: Record<string, string>, list: () => Promise<string[] | undefined>): Fake => ({
		drive: { listTrashedFileIds: vi.fn(list) },
		diagnostics: { record: vi.fn() },
		settings: { driveIdToPath },
	});

	it('adds a removal only for trashed ids this device tracks and that are not already removed', async () => {
		const t = fakePlugin({ tracked: 'a.md', alsoRemoved: 'b.md' }, async () => ['tracked', 'alsoRemoved', 'unknownToUs']);
		const changes = [change('alsoRemoved', true), change('other')];

		await expect(addTrashedAsRemoved(t as never, changes)).resolves.toBe(1);

		expect(changes.filter((c) => c.removed).map((c) => c.fileId)).toEqual(['alsoRemoved', 'tracked']);
		expect(changes.map((c) => c.fileId)).toEqual(['alsoRemoved', 'other', 'tracked']);
	});

	it('carries on without the trashed list when it fails, and records why', async () => {
		const t = fakePlugin({ tracked: 'a.md' }, () => Promise.reject(new Error('HTTP 500')));
		const changes = [change('x')];

		await expect(addTrashedAsRemoved(t as never, changes)).resolves.toBe(0);

		expect(changes).toHaveLength(1);
		expect(t.diagnostics.record).toHaveBeenCalledWith(expect.objectContaining({ operation: 'list-trashed-files' }));
	});

	it('does nothing when the listing is unavailable (undefined)', async () => {
		const t = fakePlugin({ tracked: 'a.md' }, async () => undefined);
		const changes = [change('x')];
		await expect(addTrashedAsRemoved(t as never, changes)).resolves.toBe(0);
		expect(changes).toHaveLength(1);
	});
});
