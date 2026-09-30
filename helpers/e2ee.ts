/**
 * End-to-end encryption: the runtime part (key storage on the device, turning encryption on
 * and off for this device, and the object the Drive client and the history code use).
 * The cryptography itself is in crypto.ts.
 */
import { Notice } from 'obsidian';
import type ObsidianGoogleDrive from '../main';
import {
	E2eeError,
	checkPassphrase,
	createVaultKeys,
	decodeProperties,
	decryptBytes,
	encodeProperties,
	encodeQueryProperties,
	encryptBytes,
	headerFromProperties,
	headerToProperties,
	keyedDigest,
	keysFromStoredDek,
	looksEncrypted,
	pathIdOf,
	rewrapHeader,
	unlockVaultKeys,
	vaultTagOf,
	type VaultHeader,
	type VaultKeys,
} from './crypto';
import { getDriveAgent, refreshAccessToken } from './requests';
import { isOwnPluginPath } from './own-plugin';

export { E2eeError } from './crypto';

// ---------------------------------------------------------------------------------------
// Where a device keeps its key
// ---------------------------------------------------------------------------------------

export interface KeyStore {
	get(id: string): Promise<CryptoKey | undefined>;
	put(id: string, key: CryptoKey): Promise<void>;
	delete(id: string): Promise<void>;
}

export const memoryKeyStore = (): KeyStore => {
	const map = new Map<string, CryptoKey>();
	return {
		get: async (id) => map.get(id),
		put: async (id, key) => void map.set(id, key),
		delete: async (id) => void map.delete(id),
	};
};

/**
 * The key is a NON-EXTRACTABLE CryptoKey in this device's IndexedDB: it is outside the vault folder
 * (so copying the vault does not copy it) and script cannot read its bytes back out.
 */
export const indexedDbKeyStore = (): KeyStore => {
	const open = () =>
		new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open('ogd-e2ee-keys', 1);
			request.onupgradeneeded = () => request.result.createObjectStore('keys');
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error ?? new Error('IndexedDB is not available.'));
		});
	const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) => {
		const db = await open();
		try {
			return await new Promise<T>((resolve, reject) => {
				const request = fn(db.transaction('keys', mode).objectStore('keys'));
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
			});
		} finally {
			db.close();
		}
	};
	return {
		get: (id) => run('readonly', (s) => s.get(id) as IDBRequest<CryptoKey | undefined>),
		put: async (id, key) => void (await run('readwrite', (s) => s.put(key, id))),
		delete: async (id) => void (await run('readwrite', (s) => s.delete(id))),
	};
};

export const createKeyStore = (): KeyStore =>
	typeof indexedDB !== 'undefined' ? indexedDbKeyStore() : memoryKeyStore();

// ---------------------------------------------------------------------------------------
// What the Drive client uses while encryption is on
// ---------------------------------------------------------------------------------------

export class E2ee {
	constructor(
		readonly keys: VaultKeys,
		/** `vault` property value of this vault's items on Drive (hash of the vault name) */
		readonly vaultTag: string,
		readonly kid: string,
	) {}

	pathId = (path: string) => pathIdOf(this.keys, path);
	encodeProperties(props: Record<string, string>) {
		return encodeProperties(this.keys, props);
	}
	encodeQueryProperties = (props: Record<string, string>) => encodeQueryProperties(this.keys, props);
	decodeProperties = (props: Record<string, string> | undefined) => decodeProperties(this.keys, props);
	digest = (text: string) => keyedDigest(this.keys, text);

	/** Encrypted bytes for the file at `path` (the path id is authenticated with the content). */
	async encryptFile(plain: ArrayBuffer | Uint8Array, path: string): Promise<Uint8Array> {
		return encryptBytes(this.keys, plain, await this.pathId(path));
	}

	async decryptFile(data: ArrayBuffer | Uint8Array, path: string): Promise<ArrayBuffer> {
		return decryptBytes(this.keys, data, await this.pathId(path));
	}

	/** Restore points and other items that are not tied to a vault path. */
	encryptBlob = (plain: ArrayBuffer | Uint8Array, label: string) => encryptBytes(this.keys, plain, 'blob:' + label);
	decryptBlob = (data: ArrayBuffer | Uint8Array, label: string) => decryptBytes(this.keys, data, 'blob:' + label);
	isEncrypted = looksEncrypted;
}

export const requireUnlocked = (t: ObsidianGoogleDrive): E2ee | undefined => {
	if (t.settings.e2eeEnabled !== true) return undefined;
	if (!t.e2ee) {
		throw new E2eeError(
			'End-to-end encryption is on, but this device does not have the key. Enter the passphrase in the plugin settings.',
			'locked',
		);
	}
	return t.e2ee;
};

// ---------------------------------------------------------------------------------------
// Turning it on / off, changing the passphrase, unlocking
// ---------------------------------------------------------------------------------------

interface RootFolder {
	id: string;
	properties?: Record<string, string>;
	createdTime?: string;
}

const escapeQueryValue = (value: string) => value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");

const ensureAuth = async (t: ObsidianGoogleDrive) => {
	if (!t.accessToken.token && !(await refreshAccessToken(t))) {
		throw new Error('Could not sign in to Google Drive. Check the refresh token.');
	}
};

const findEncryptedRoot = async (t: ObsidianGoogleDrive, tag: string): Promise<RootFolder | undefined> => {
	const q = `trashed=false and properties has { key='obsidian' and value='vault' } and properties has { key='vault' and value='${escapeQueryValue(tag)}' }`;
	const page = await getDriveAgent(t)
		.get(`drive/v3/files?fields=files(id,properties,createdTime)&pageSize=100&q=${encodeURIComponent(q)}`)
		.json<{ files?: RootFolder[] }>();
	return [...(page?.files ?? [])].sort((a, b) => (a.createdTime ?? '').localeCompare(b.createdTime ?? ''))[0];
};

export const plainLinkOf = (t: ObsidianGoogleDrive) => ({
	rootFolderId: t.settings.rootFolderId,
	driveIdToPath: t.settings.driveIdToPath,
	operations: t.settings.operations,
	lastSyncedAt: t.settings.lastSyncedAt,
	changesToken: t.settings.changesToken,
});

const localItemsToCreate = (t: ObsidianGoogleDrive) => {
	const ops: Record<string, 'create'> = {};
	for (const file of t.app.vault.getAllLoadedFiles()) {
		const path = file.path;
		if (!path || path === '/' || isOwnPluginPath(t, path)) continue;
		if (path === t.app.vault.configDir || path.startsWith(t.app.vault.configDir + '/')) continue;
		ops[path] = 'create';
	}
	return ops;
};

/**
 * Links THIS device to the encrypted Drive vault of this vault name. Creates it when it does not
 * exist yet (this device's files are then all marked for upload, so the next Push sends them
 * encrypted); otherwise opens it with the passphrase (run Pull next). The plain link is saved so
 * that turning encryption off can go back to it. Nothing on the existing plain Drive vault is changed.
 */
export const enableEncryption = async (
	t: ObsidianGoogleDrive,
	passphrase: string,
	/** the passphrase typed a second time; when given it must match before a NEW vault is created */
	repeat?: string,
): Promise<'created' | 'joined'> => {
	if (t.syncing) throw new Error('A sync is running. Try again when it has finished.');
	if (t.settings.e2eeEnabled) throw new Error('Encryption is already on for this device.');
	await ensureAuth(t);

	const vaultName = t.app.vault.getName();
	const tag = await vaultTagOf(vaultName);
	const existing = await findEncryptedRoot(t, tag);

	let header: VaultHeader;
	let keys: VaultKeys;
	let rootId: string;
	let mode: 'created' | 'joined';
	if (existing) {
		const found = headerFromProperties(existing.properties);
		if (!found) throw new Error('A Drive folder for this vault exists but has no encryption header. Nothing was changed.');
		keys = await unlockVaultKeys(found, passphrase); // throws "Wrong passphrase." before anything is written
		header = found;
		rootId = existing.id;
		mode = 'joined';
	} else {
		const quality = checkPassphrase(passphrase);
		if (!quality.ok) throw new Error(quality.message);
		if (repeat !== undefined && repeat !== passphrase) {
			throw new Error(
				repeat === ''
					? 'Type the passphrase a second time in the "Repeat the passphrase" box. A new encrypted vault needs it twice.'
					: 'The two passphrases are different. A new encrypted vault needs the same passphrase typed twice.',
			);
		}
		({ header, keys } = await createVaultKeys(passphrase));
		const created = await getDriveAgent(t)
			.post('drive/v3/files?fields=id', {
				json: {
					name: 'Encrypted Obsidian vault',
					mimeType: 'application/vnd.google-apps.folder',
					description: 'End-to-end encrypted Obsidian vault (Obsidian Google Drive). Do not edit.',
					properties: { obsidian: 'vault', vault: tag, ...headerToProperties(header) },
				},
			})
			.json<{ id: string }>();
		if (!created?.id) throw new Error('Drive did not confirm the new encrypted vault folder. Nothing was changed.');
		rootId = created.id;
		mode = 'created';
	}

	const changesToken = await t.drive.getChangesStartToken();
	if (!changesToken) throw new Error('Could not read the Drive changes position. Nothing was changed on this device.');
	await t.keyStore.put(header.kid, keys.dek);

	// Only now change this device.
	t.settings.e2eePlainLink = plainLinkOf(t);
	t.settings.rootFolderId = rootId;
	t.settings.driveIdToPath = {};
	t.settings.changesToken = changesToken;
	t.settings.lastSyncedAt = 0;
	t.settings.operations = mode === 'created' ? localItemsToCreate(t) : {};
	t.settings.e2eeEnabled = true;
	t.settings.e2eeKid = header.kid;
	t.e2ee = new E2ee(keys, tag, header.kid);
	await t.saveSettings();
	t.updateStatusBar();
	return mode;
};

/** Gives the key to a device that has encryption on but lost its key (app data cleared) or never had it. */
export const unlockEncryption = async (t: ObsidianGoogleDrive, passphrase: string) => {
	if (t.settings.e2eeEnabled !== true) throw new Error('Encryption is not turned on for this device.');
	await ensureAuth(t);
	const tag = await vaultTagOf(t.app.vault.getName());
	const root = await findEncryptedRoot(t, tag);
	const header = headerFromProperties(root?.properties);
	if (!root || !header) throw new Error('The encrypted vault was not found on Drive.');
	if (header.kid !== t.settings.e2eeKid) {
		throw new Error('The encrypted vault on Drive is a different one from the one this device was linked to. Turn encryption off and on again to link it.');
	}
	const keys = await unlockVaultKeys(header, passphrase);
	await t.keyStore.put(header.kid, keys.dek);
	t.e2ee = new E2ee(keys, tag, header.kid);
	t.updateStatusBar();
};

/** Turns encryption off for this device and goes back to the plain Drive link it had before (if it had one). */
export const disableEncryption = async (t: ObsidianGoogleDrive) => {
	if (t.syncing) throw new Error('A sync is running. Try again when it has finished.');
	if (t.settings.e2eeEnabled !== true) return;
	const kid = t.settings.e2eeKid;
	const back = t.settings.e2eePlainLink;
	t.settings.e2eeEnabled = false;
	t.settings.e2eeKid = '';
	delete t.settings.e2eePlainLink;
	t.e2ee = undefined;
	if (back) {
		t.settings.rootFolderId = back.rootFolderId;
		t.settings.driveIdToPath = back.driveIdToPath;
		t.settings.operations = back.operations;
		t.settings.lastSyncedAt = back.lastSyncedAt;
		t.settings.changesToken = back.changesToken;
	} else {
		t.settings.rootFolderId = '';
		t.settings.driveIdToPath = {};
		t.settings.operations = {};
		t.settings.lastSyncedAt = 0;
		t.settings.changesToken = '';
	}
	await t.saveSettings();
	if (kid) await t.keyStore.delete(kid).catch(() => undefined);
	t.updateStatusBar();
};

/** New passphrase for the encrypted vault. Other devices keep working; only a NEW device needs the new one. */
export const changePassphrase = async (t: ObsidianGoogleDrive, oldPassphrase: string, newPassphrase: string) => {
	if (t.settings.e2eeEnabled !== true) throw new Error('Encryption is not turned on for this device.');
	const quality = checkPassphrase(newPassphrase);
	if (!quality.ok) throw new Error(quality.message);
	await ensureAuth(t);
	const rootId = t.settings.rootFolderId;
	if (!rootId) throw new Error('This device is not linked to an encrypted vault folder yet.');
	const agent = getDriveAgent(t);
	const root = await agent.get(`drive/v3/files/${encodeURIComponent(rootId)}?fields=id,properties`).json<RootFolder>();
	const header = headerFromProperties(root?.properties);
	if (!header) throw new Error('The encrypted vault header was not found on Drive.');
	const next = await rewrapHeader(header, oldPassphrase, newPassphrase); // throws "Wrong passphrase." first
	await agent.patch(`drive/v3/files/${encodeURIComponent(rootId)}?fields=id`, {
		// all properties, so the result is the same whether Drive merges or replaces them
		json: { properties: { ...(root?.properties ?? {}), ...headerToProperties(next) } },
	});
};

/** Called from onload: reads this device's key. Never throws; a missing key leaves the plugin locked with a notice. */
export const loadEncryption = async (t: ObsidianGoogleDrive) => {
	t.e2ee = undefined;
	if (t.settings.e2eeEnabled !== true) return;
	try {
		const dek = t.settings.e2eeKid ? await t.keyStore.get(t.settings.e2eeKid) : undefined;
		if (!dek) throw new Error('no key');
		t.e2ee = new E2ee(await keysFromStoredDek(dek), await vaultTagOf(t.app.vault.getName()), t.settings.e2eeKid);
	} catch {
		new Notice(
			'Google Drive Sync: end-to-end encryption is on, but this device does not have the key. Open the plugin settings and enter the passphrase. Sync is paused until then.',
			0,
		);
	}
};
