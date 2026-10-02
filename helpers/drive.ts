import type ObsidianGoogleDrive from '../main';
import { getDriveAgent } from './requests';
import { E2eeError, requireUnlocked } from './e2ee';
import { isOwnPluginPath } from './own-plugin';
import { recordOwnUpload } from './sync-state';
import { isCategoryEnabled, THEME_FILES } from './config-scope';
import {
	DriveHttpError,
	isNetworkError,
	isRetryableError,
	net,
	noteRetry,
	retryDelay,
	sleep,
	withTimeout,
} from './net-retry';
import { Notice, requestUrl, TAbstractFile, TFolder } from 'obsidian';

export interface FileMetadata {
	id: string;
	name: string;
	description: string;
	mimeType: string;
	starred: boolean;
	properties: Record<string, string>;
	modifiedTime: string;
	trashed: boolean;
	/** bytes, as text (not for Google Docs files); only when asked for */
	size?: string;
	/** MD5 of the stored bytes, hex; only when asked for */
	md5Checksum?: string;
}

type StringSearch = string | { contains: string } | { not: string };
type DateComparison = { eq: string } | { gt: string } | { lt: string };

interface QueryMatch {
	name?: StringSearch | StringSearch[];
	mimeType?: StringSearch | StringSearch[];
	parent?: string;
	starred?: boolean;
	query?: string;
	properties?: Record<string, string>;
	modifiedTime?: DateComparison;
}

interface Change {
	kind: string;
	removed: boolean;
	file: FileMetadata;
	fileId: string;
	time: string;
}

export const folderMimeType = 'application/vnd.google-apps.folder';

const BLACKLISTED_CONFIG_FILES = [
	'graph.json',
	'workspace.json',
	'workspace-mobile.json',
];

const WHITELISTED_PLUGIN_FILES = [
	'manifest.json',
	'styles.css',
	'main.js',
	'data.json',
];

const escapeQueryValue = (value: string) =>
	value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");

const stringSearchToQuery = (search: StringSearch) => {
	if (typeof search === 'string') return `='${escapeQueryValue(search)}'`;
	if ('contains' in search) {
		return ` contains '${escapeQueryValue(search.contains)}'`;
	}
	if ('not' in search) return `!='${escapeQueryValue(search.not)}'`;
	return;
};

const queryHandlers = {
	name: (name: StringSearch) => 'name' + stringSearchToQuery(name),
	mimeType: (mimeType: StringSearch) =>
		'mimeType' + stringSearchToQuery(mimeType),
	parent: (parent: string) => `'${escapeQueryValue(parent)}' in parents`,
	starred: (starred: boolean) => `starred=${starred}`,
	query: (query: string) => `fullText contains '${escapeQueryValue(query)}'`,
	properties: (properties: Record<string, string>) =>
		Object.entries(properties)
			.map(
				([key, value]) =>
					`properties has { key='${escapeQueryValue(key)}' and value='${escapeQueryValue(value)}' }`,
			)
			.join(' and '),
	modifiedTime: (modifiedTime: DateComparison) => {
		if ('eq' in modifiedTime) return `modifiedTime='${modifiedTime.eq}'`;
		if ('gt' in modifiedTime) return `modifiedTime>'${modifiedTime.gt}'`;
		if ('lt' in modifiedTime) return `modifiedTime<'${modifiedTime.lt}'`;
		return;
	},
};

export const fileListToMap = (files: { id: string; name: string }[]) =>
	Object.fromEntries(files.map(({ id, name }) => [name, id]));

export const splitPath = (path: string) => {
	const encoder = new TextEncoder();
	let p = '';
	const output: Record<string, string> = {};
	let i = 1;
	for (const char of path) {
		if (encoder.encode(p + char).length > 100) {
			const key = i === 1 ? 'path' : `path${i}`;
			output[key] = p;
			p = '';
			i++;
		}
		p += char;
	}
	const key = i === 1 ? 'path' : `path${i}`;
	output[key] = p;
	return output;
};

export const unSplitPath = (properties: Record<string, string>) => {
	let path = properties.path || '';
	let i = 2;
	while (properties[`path${i}`]) {
		path += properties[`path${i}`];
		i++;
	}
	return path;
};

export const getDriveClient = (t: ObsidianGoogleDrive) => {
	const drive = getDriveAgent(t);

	/** The encryption helper while end-to-end encryption is on (throws if it is on but locked); undefined when it is off. */
	const e2 = () => requireUnlocked(t);
	/** Value of the `vault` property that marks this vault's items on Drive. */
	const vaultValue = () => e2()?.vaultTag ?? t.app.vault.getName();

	const getQuery = async (plainMatches: QueryMatch[]) => {
		const e = e2();
		const matches = e
			? await Promise.all(
					plainMatches.map(async (match) =>
						match.properties
							? {
									...match,
									properties: await e.encodeQueryProperties(
										match.properties,
									),
								}
							: match,
					),
				)
			: plainMatches;
		return encodeURIComponent(
			`(${matches
				.map((match) => {
					const entries = Object.entries(match).flatMap(
						([key, value]) =>
							value === undefined
								? []
								: Array.isArray(value)
									? value.map((v) => [key, v as string])
									: [[key, value]],
					);
					return `(${entries
						.map(([key, value]) =>
							queryHandlers[key as keyof QueryMatch](
								value as never,
							),
						)
						.join(' and ')})`;
				})
				.join(
					' or ',
				)}) and trashed=false and properties has { key='vault' and value='${escapeQueryValue(vaultValue())}' }`,
		);
	};

	const paginateFiles = async ({
		matches,
		pageToken,
		order = 'descending',
		pageSize = 30,
		include = [
			'id',
			'name',
			'mimeType',
			'starred',
			'description',
			'properties',
		],
	}: {
		matches?: QueryMatch[];
		order?: 'ascending' | 'descending';
		pageToken?: string;
		pageSize?: number;
		include?: (keyof FileMetadata)[];
	}) => {
		const query = matches
			? await getQuery(matches)
			: encodeURIComponent(
					"trashed=false and properties has { key='vault' and value='" +
						escapeQueryValue(vaultValue()) +
						"'}",
				);
		const files = await drive
			.get(
				`drive/v3/files?fields=nextPageToken,files(${include.join(
					',',
				)})&pageSize=${pageSize}&q=${query}${
					matches?.find(({ query }) => query)
						? ''
						: '&orderBy=name' +
							(order === 'ascending' ? '' : ' desc')
				}${pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''}`,
			)
			.json();
		if (!files) return;
		const listing = files as {
			nextPageToken?: string;
			files: FileMetadata[];
		};
		const e = e2();
		if (e && listing.files) {
			try {
				listing.files = await Promise.all(
					listing.files.map(async (file: FileMetadata) =>
						file.properties
							? {
									...file,
									properties: await e.decodeProperties(
										file.properties,
									),
								}
							: file,
					),
				);
			} catch (error) {
				// A listing with a damaged entry is refused as a whole: treating the entry as
				// "missing" could make Pull delete a real file on this device.
				t.diagnostics.record({
					phase: 'list-files',
					operation: 'decode-listing',
					message: error instanceof Error ? error.message : 'Could not read the encrypted listing.',
				});
				new Notice(
					'Google Drive Sync: an encrypted item on Drive could not be verified, so nothing was synced. See the diagnostics.',
					8000,
				);
				return;
			}
		}
		return listing;
	};

	const searchFiles = async (
		data: {
			matches?: QueryMatch[];
			order?: 'ascending' | 'descending';
			include?: (keyof FileMetadata)[];
		},
		includeObsidian = false,
	) => {
		const files = await paginateFiles({ ...data, pageSize: 1000 });
		if (!files) return;

		while (files.nextPageToken) {
			const nextPage = await paginateFiles({
				...data,
				pageToken: files.nextPageToken,
				pageSize: 1000,
			});
			if (!nextPage) return;
			files.files.push(...nextPage.files);
			files.nextPageToken = nextPage.nextPageToken;
		}

		if (includeObsidian) return files.files;

		return files.files.filter(
			({ properties }) => properties?.obsidian !== 'vault',
		);
	};

	/**
	 * Makes a file or folder, and survives a failure that comes from the connection or from Google.
	 * A create is not simply repeated (the first one may have got through and only its answer was
	 * lost, which would make a duplicate): after the wait, Drive is asked whether the item exists
	 * already. If it does, that one is used; only if it does not is the create repeated. If Drive
	 * cannot be asked, the original failure is reported and nothing is repeated.
	 */
	const retryCreate = async <R extends { id: string; modifiedTime?: string }>(
		what: string,
		attempt: () => Promise<R>,
		lookup: { path: string; parent: string } | undefined,
		adopt?: (found: { id: string; modifiedTime?: string }) => Promise<R>,
	): Promise<R> => {
		for (let tries = 0; ; tries++) {
			try {
				return await attempt();
			} catch (error) {
				const wait =
					lookup && isRetryableError(error)
						? retryDelay(
								t,
								tries,
								error instanceof DriveHttpError ? error.retryAfter : undefined,
							)
						: undefined;
				if (wait === undefined || !lookup) throw error;
				noteRetry(t, what, tries, wait, error);
				await sleep(wait);
				const look = async () => {
					const files = await searchFiles({
						matches: [{ properties: splitPath(lookup.path), parent: lookup.parent }],
						include: ['id', 'modifiedTime'],
					});
					if (!files) throw error;
					return files[0];
				};
				let found: { id: string; modifiedTime?: string } | undefined;
				try {
					found = await look();
					// Drive's search can lag a moment behind a create: after a lost answer look twice.
					if (!found && isNetworkError(error)) {
						await sleep(net.settleMs);
						found = await look();
					}
				} catch {
					throw error; // cannot tell whether it exists: do not risk a duplicate
				}
				if (found) {
					return adopt
						? adopt(found)
						: ({ id: found.id, modifiedTime: found.modifiedTime } as R);
				}
			}
		}
	};

	const persistRootFolderId = async (id: string) => {
		if (t.settings.rootFolderId === id) return;
		t.settings.rootFolderId = id;
		await t.saveSettings();
	};

	const getRootFolderId = async (verify = false) => {
		if (!verify && t.settings.rootFolderId) {
			return t.settings.rootFolderId;
		}

		const files = await searchFiles(
			{
				matches: [{ properties: { obsidian: 'vault' } }],
			},
			true,
		);
		if (!files) return;
		if (!files.length) {
			if (t.settings.e2eeEnabled === true) {
				// an encrypted vault is only created by "Turn on encryption", never implicitly
				return;
			}
			const rootFolder = await drive
				.post(`drive/v3/files`, {
					json: {
						name: t.app.vault.getName(),
						mimeType: folderMimeType,
						description: 'Obsidian Vault: ' + t.app.vault.getName(),
						properties: {
							obsidian: 'vault',
							vault: t.app.vault.getName(),
						},
					},
				})
				.json<{ id: string }>();
			if (!rootFolder) return;
			await persistRootFolderId(rootFolder.id);
			return rootFolder.id;
		}
		const id = files[0]?.id;
		if (!id) return;
		await persistRootFolderId(id);
		return id;
	};

	const createFolder = async ({
		name,
		parent,
		description,
		properties,
		modifiedTime,
	}: {
		name: string;
		description?: string;
		parent?: string;
		properties?: Record<string, string>;
		modifiedTime?: string;
	}) => {
		if (!parent) {
			parent = await getRootFolderId();
			if (!parent) return;
		}

		if (!properties) properties = {};
		if (!properties.vault) properties.vault = vaultValue();
		const lookupPath = unSplitPath(properties);
		const e = e2();
		if (e) {
			properties = await e.encodeProperties(properties);
			if (properties.path) name = properties.path;
		}

		const folderProperties = properties;
		const folder = await retryCreate(
			'create folder',
			() =>
				drive
					.post(`drive/v3/files?fields=id,modifiedTime`, {
						json: {
							name,
							mimeType: folderMimeType,
							description,
							parents: [parent],
							properties: folderProperties,
							modifiedTime,
						},
					})
					.json<{ id: string; modifiedTime?: string }>(),
			lookupPath ? { path: lookupPath, parent } : undefined,
		);
		if (!folder) return;
		recordOwnUpload(t, folder.id, folder.modifiedTime);
		return folder.id;
	};

	const uploadFile = async (
		file: Blob,
		name: string,
		parent?: string,
		metadata?: Partial<Omit<FileMetadata, 'id'>>,
	) => {
		if (!parent) {
			parent = await getRootFolderId();
			if (!parent) return;
		}

		if (!metadata) metadata = {};
		if (!metadata.properties) metadata.properties = {};
		if (!metadata.properties.vault) {
			metadata.properties.vault = vaultValue();
		}
		const lookupPath = unSplitPath(metadata.properties);
		const e = e2();
		if (e) {
			const plainProperties = metadata.properties;
			const path = unSplitPath(plainProperties);
			if (!path) {
				throw new E2eeError('Cannot encrypt a file without a path.', 'bad-properties');
			}
			file = new Blob(
				[(await e.encryptFile(await file.arrayBuffer(), path)) as BlobPart],
				{ type: 'application/octet-stream' },
			);
			metadata = {
				...metadata,
				properties: await e.encodeProperties(plainProperties),
			};
			if (metadata.properties?.path) name = metadata.properties.path;
		}

		const form = new FormData();
		form.append(
			'metadata',
			new Blob(
				[
					JSON.stringify({
						name,
						mimeType: file.type,
						parents: [parent],
						...metadata,
					}),
				],
				{ type: 'application/json' },
			),
		);
		form.append('file', file);

		const uploadParent = parent;
		const result = await retryCreate(
			'upload file',
			() =>
				drive
					.post(`upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime`, {
						body: form,
					})
					.json<{ id: string; modifiedTime?: string }>(),
			lookupPath ? { path: lookupPath, parent: uploadParent } : undefined,
			// the file that a lost create made: put this content into it (it may be an older copy)
			async (found) => {
				const again = new FormData();
				again.append(
					'metadata',
					new Blob([JSON.stringify(metadata?.modifiedTime ? { modifiedTime: metadata.modifiedTime } : {})], {
						type: 'application/json',
					}),
				);
				again.append('file', file);
				return drive
					.patch(`upload/drive/v3/files/${found.id}?uploadType=multipart&fields=id,modifiedTime`, {
						body: again,
					})
					.json<{ id: string; modifiedTime?: string }>();
			},
		);
		if (!result) return;
		recordOwnUpload(t, result.id, result.modifiedTime);

		return result.id;
	};

	const updateFile = async (
		id: string,
		newContent: Blob,
		newMetadata: Partial<Omit<FileMetadata, 'id'>> = {},
		/** vault path of the file; needed while encryption is on (the content is bound to its path) */
		path?: string,
	) => {
		const e = e2();
		if (e) {
			if (path === undefined) {
				throw new E2eeError('Cannot encrypt an update without the file path.', 'bad-properties');
			}
			newContent = new Blob(
				[(await e.encryptFile(await newContent.arrayBuffer(), path)) as BlobPart],
				{ type: 'application/octet-stream' },
			);
		}
		const form = new FormData();
		form.append(
			'metadata',
			new Blob([JSON.stringify(newMetadata)], {
				type: 'application/json',
			}),
		);
		form.append('file', newContent);

		const result = await drive
			.patch(
				`upload/drive/v3/files/${id}?uploadType=multipart&fields=id,modifiedTime`,
				{
					body: form,
				},
			)
			.json<{ id: string; modifiedTime?: string }>();
		if (!result) return;
		recordOwnUpload(t, result.id, result.modifiedTime);

		return result.id;
	};

	const updateFileMetadata = async (
		id: string,
		metadata: Partial<Omit<FileMetadata, 'id'>>,
	) => {
		const result = await drive
			.patch(`drive/v3/files/${id}`, {
				json: metadata,
			})
			.json<{ id: string }>();
		if (!result) return;
		return result.id;
	};

	const deleteFile = async (id: string) => {
		const result = await drive.delete(`drive/v3/files/${id}`);
		if (!result.ok) return;
		return true;
	};

	/** `path` is the vault path of the file; needed while encryption is on (the content is checked against it). */
	const getFile = (id: string, path?: string) => {
		const response = drive.get(
			`drive/v3/files/${id}?alt=media&acknowledgeAbuse=true`,
		);
		const e = e2();
		if (!e) return response;
		return {
			arrayBuffer: async () => {
				if (path === undefined) {
					throw new E2eeError('Cannot check a download without the file path.', 'bad-properties');
				}
				const downloaded = await response.arrayBuffer();
				if (!downloaded) return downloaded; // the download itself failed: same result as without encryption
				return e.decryptFile(downloaded, path);
			},
		};
	};

	const getFileMetadata = async (id: string) => {
		const metadata = await drive
			.get(`drive/v3/files/${id}`)
			.json<FileMetadata>();
		const e = e2();
		if (e && metadata?.properties) {
			return { ...metadata, properties: await e.decodeProperties(metadata.properties) };
		}
		return metadata;
	};

	/** What Drive says about one file right now: size, modified time, trashed. Read-only. */
	const getFileStatus = async (id: string) =>
		drive
			.get(`drive/v3/files/${id}?fields=id,size,modifiedTime,trashed`)
			.json<{
				id: string;
				size?: string;
				modifiedTime?: string;
				trashed?: boolean;
			}>();

	const idFromPath = async (path: string) => {
		const files = await searchFiles({
			matches: [{ properties: splitPath(path) }],
		});
		if (!files?.length) return;
		return files[0]?.id as string;
	};

	const idsFromPaths = async (paths: string[]) => {
		const files = await searchFiles({
			matches: paths.map((path) => ({ properties: splitPath(path) })),
		});
		if (!files) return;
		return files.map((file) => ({
			id: file.id,
			path: unSplitPath(file.properties),
		}));
	};

	/**
	 * Removes files from Drive. With "Delete to Trash" on (the default) they are moved to
	 * the Drive Trash, where they stay recoverable (Drive empties the Trash after about 30
	 * days); otherwise they are deleted permanently, exactly as before.
	 */
	const batchDelete = async (ids: string[]) => {
		if (!ids.length) return true;
		const trash = t.settings.deleteToTrash === true;

		for (let offset = 0; offset < ids.length; offset += 100) {
			const batch = ids.slice(offset, offset + 100);
			const boundary = `batch_${crypto.randomUUID()}`;
			const body =
				batch
					.map((fileId, index) =>
						[
							`--${boundary}`,
							'Content-Type: application/http',
							`Content-ID: <request_${offset + index + 1}>`,
							'',
							...(trash
								? [
										`PATCH /drive/v3/files/${fileId}?fields=id HTTP/1.1`,
										'Content-Type: application/json',
										'',
										JSON.stringify({ trashed: true }),
									]
								: [`DELETE /drive/v3/files/${fileId} HTTP/1.1`, '']),
						].join('\r\n'),
					)
					.concat(`--${boundary}--`)
					.join('\r\n') + '\r\n';

			const response = await drive.post(`batch/drive/v3`, {
				headers: {
					'Content-Type': `multipart/mixed; boundary=${boundary}`,
				},
				body,
			});
			if (!response.ok) return;

			const result = await response.text();
			const statuses = Array.from(
				result.matchAll(/HTTP\/1\.1 (\d{3})/g),
				(match) => Number(match[1]),
			);
			// 404 means the file is already gone, which is exactly what a delete wants.
			const failed = (status: number) =>
				(status < 200 || status >= 300) && status !== 404;
			if (
				statuses.length !== batch.length ||
				statuses.some(failed)
			) {
				const failedCount = statuses.filter(failed).length;
				t.diagnostics.record({
					phase: 'batch-delete',
					operation: 'batch-delete-files',
					httpStatus: statuses.find(failed),
					message: `${failedCount} of ${batch.length} batch deletes failed (statuses: ${statuses.join(', ')})`,
				});
				return;
			}
		}
		return true;
	};

	const getChangesStartToken = async () => {
		const result = await drive
			.get(`drive/v3/changes/startPageToken`)
			.json<{ startPageToken: string }>();
		if (!result) return;
		return result.startPageToken;
	};

	const getChanges = async (startToken: string) => {
		if (!startToken) return [];

		const request = (token: string) =>
			drive
				.get(
					`drive/v3/changes?${new URLSearchParams({
						pageToken: token,
						pageSize: '1000',
						includeRemoved: 'true',
					}).toString()}`,
				)
				.json<{
					changes: Change[];
					nextPageToken?: string;
					newStartPageToken?: string;
				}>();

		const result = await request(startToken);
		if (!result) return;
		while (result.nextPageToken) {
			const nextPage = await request(result.nextPageToken);
			if (!nextPage) return;
			result.changes.push(...nextPage.changes);
			result.newStartPageToken = nextPage.newStartPageToken;
			result.nextPageToken = nextPage.nextPageToken;
		}

		return result.changes;
	};

	/**
	 * Ids of this vault's files that are in the Drive Trash. Used by Pull so that a file
	 * trashed on another device is noticed even if the changes feed does not report it as
	 * removed. Returns undefined when the listing fails (the caller treats that as "unknown").
	 */
	const listTrashedFileIds = async () => {
		const query = encodeURIComponent(
			"trashed=true and properties has { key='vault' and value='" +
				escapeQueryValue(vaultValue()) +
				"' }",
		);
		const ids: string[] = [];
		let pageToken: string | undefined;
		do {
			const page = await drive
				.get(
					`drive/v3/files?fields=nextPageToken,files(id)&pageSize=1000&q=${query}${
						pageToken
							? '&pageToken=' + encodeURIComponent(pageToken)
							: ''
					}`,
				)
				.json<{ files?: { id: string }[]; nextPageToken?: string }>();
			if (!page) return;
			ids.push(...(page.files ?? []).map((file) => file.id));
			pageToken = page.nextPageToken;
		} while (pageToken);
		return ids;
	};

	const deleteFilesMinimumOperations = async (files: TAbstractFile[]) => {
		const folders = files.filter((file) => file instanceof TFolder);

		if (folders.length) {
			const maxDepth = Math.max(
				...folders.map(({ path }) => path.split('/').length),
			);

			for (let depth = 1; depth <= maxDepth; depth++) {
				const foldersToDelete = files.filter(
					(file) =>
						file instanceof TFolder &&
						file.path.split('/').length === depth,
				);
				await Promise.all(
					foldersToDelete.map((folder) => t.deleteFile(folder)),
				);
				foldersToDelete.forEach(
					(folder) =>
						(files = files.filter(
							({ path }) =>
								!path.startsWith(folder.path + '/') &&
								path !== folder.path,
						)),
				);
			}
		}

		await Promise.all(files.map((file) => t.deleteFile(file)));
	};

	/**
	 * @param knownOnDrive paths that already exist on Drive. Given by Push: a theme or snippet that is
	 *   not on Drive yet is uploaded even if it is old (they were not synced before 3.7.0).
	 */
	const getConfigFilesToSync = async (knownOnDrive?: Set<string>) => {
		const configFilesToSync: string[] = [];
		const { vault } = t.app;
		const { adapter } = vault;

		const none = { files: [] as string[], folders: [] as string[] };
		const [configFiles, plugins] = isCategoryEnabled(t, 'settings')
			? await Promise.all([
					adapter.list(vault.configDir),
					adapter.list(vault.configDir + '/plugins'),
				])
			: [none, none];

		await Promise.all(
			configFiles.files
				.filter(
					(path) =>
						!BLACKLISTED_CONFIG_FILES.includes(
							fileNameFromPath(path),
						),
				)
				.map(async (path) => {
					const file = await adapter.stat(path);
					if ((file?.mtime || 0) > t.settings.lastSyncedAt) {
						configFilesToSync.push(path);
					}
				})
				.concat(
					plugins.folders
						.filter((plugin) => !isOwnPluginPath(t, plugin))
						.map(async (plugin) => {
							const files = await adapter.list(plugin);
							await Promise.all(
								files.files
									.filter((path) =>
										WHITELISTED_PLUGIN_FILES.includes(
											fileNameFromPath(path),
										),
									)
									.map(async (path) => {
										const file = await adapter.stat(path);
										if (
											(file?.mtime || 0) >
											t.settings.lastSyncedAt
										) {
											configFilesToSync.push(path);
										}
									}),
							);
						}),
				),
		);

		// Themes and snippets (switchable). A missing folder just means there is nothing to sync.
		const listOrNothing = async (folder: string) => {
			try {
				return (await adapter.list(folder)) ?? none;
			} catch {
				return none;
			}
		};
		const consider = async (path: string) => {
			const file = await adapter.stat(path);
			if (
				(file?.mtime || 0) > t.settings.lastSyncedAt ||
				(knownOnDrive !== undefined && !knownOnDrive.has(path))
			) {
				configFilesToSync.push(path);
			}
		};
		if (isCategoryEnabled(t, 'themes')) {
			const themes = await listOrNothing(vault.configDir + '/themes');
			for (const theme of themes.folders) {
				const inside = await listOrNothing(theme);
				for (const path of inside.files) {
					if (THEME_FILES.includes(fileNameFromPath(path))) await consider(path);
				}
			}
		}
		if (isCategoryEnabled(t, 'snippets')) {
			const snippets = await listOrNothing(vault.configDir + '/snippets');
			for (const path of snippets.files) {
				if (path.toLowerCase().endsWith('.css')) await consider(path);
			}
		}

		return configFilesToSync;
	};

	return {
		paginateFiles,
		searchFiles,
		getRootFolderId,
		createFolder,
		uploadFile,
		updateFile,
		updateFileMetadata,
		deleteFile,
		getFile,
		getFileMetadata,
		getFileStatus,
		idFromPath,
		idsFromPaths,
		getChangesStartToken,
		getChanges,
		batchDelete,
		listTrashedFileIds,
		checkConnection,
		deleteFilesMinimumOperations,
		getConfigFilesToSync,
	};
};

export const checkConnection = async () => {
	try {
		const result = await withTimeout(
			requestUrl({
				url: 'https://www.google.com/generate_204',
				throw: false,
			}),
			net.probeTimeoutMs,
		);
		return result.status >= 200 && result.status < 300;
	} catch {
		return false;
	}
};

/**
 * Can this device reach Google's API servers (the ones Drive is on)? Any answer counts, even an
 * error page: it proves the servers are reachable. Only a failed or timed-out request does not.
 * It tells "no internet" apart from "Google is reachable but Drive is blocked" (firewall, VPN).
 */
export const checkDriveHost = async () => {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			await withTimeout(
				requestUrl({ url: 'https://www.googleapis.com/generate_204', throw: false }),
				net.probeTimeoutMs,
			);
			return true;
		} catch {
			// try once more
		}
	}
	return false;
};

export const batchAsync = async <T = unknown>(
	requests: (() => Promise<T>)[],
	batchSize = 10,
) => {
	const results = [];
	for (let i = 0; i < requests.length; i += batchSize) {
		const batch = requests.slice(i, i + batchSize);
		// Wait for every request of the batch to finish before reporting a failure. A failed
		// batch must not leave other requests running in the background: they would keep
		// changing files and state after the caller has already reported the failure.
		const settled = await Promise.allSettled(batch.map((request) => request()));
		const failed = settled.find(
			(result): result is PromiseRejectedResult => result.status === 'rejected',
		);
		if (failed) throw failed.reason;
		results.push(
			...settled.map((result) => (result as PromiseFulfilledResult<T>).value),
		);
	}
	return results;
};

export const getSyncMessage = (
	min: number,
	max: number,
	completed: number,
	total: number,
) => `Syncing (${Math.floor(min + (max - min) * (completed / total))}%)`;

export const fileNameFromPath = (path: string) =>
	path.split('/').slice(-1)[0] as string;

/**
 * @returns Batches in increasing order of depth
 */
export const foldersToBatches = <T = string | TFolder>(folders: T[]) => {
	const batches: (typeof folders)[] = new Array(
		Math.max(
			...folders.map(
				(folder) =>
					(
						(folder instanceof TFolder
							? folder.path
							: folder) as string
					).split('/').length,
			),
		),
	)
		.fill(0)
		.map(() => []);

	folders.forEach((folder) => {
		batches[
			(
				(folder instanceof TFolder ? folder.path : folder) as string
			).split('/').length - 1
		]?.push(folder);
	});

	return batches;
};
