/**
 * End-to-end encryption primitives (WebCrypto only, no Obsidian imports, no network).
 *
 * Key hierarchy
 *   passphrase --PBKDF2-SHA256(salt, iterations)--> KEK --AES-GCM--> wraps a random 256-bit DEK
 *   DEK --HKDF-SHA256--> content key (AES-GCM), path key (AES-GCM), path-id key (HMAC-SHA256)
 *
 * The DEK is random, so changing the passphrase only re-wraps it; no file is re-uploaded.
 * Every file is encrypted with a fresh random 96-bit nonce and is bound to its path id as
 * authenticated data, so a server cannot hand one file's bytes out under another path.
 */

export const KDF_ITERATIONS = 600_000;
/** What new vaults and new passphrases use. Only tests lower it (the header stores the number, so any value is opened correctly). */
export const kdf = { iterations: KDF_ITERATIONS };
export const FORMAT_VERSION = 1;
const MAGIC = [0x4f, 0x47, 0x44, 0x45]; // "OGDE"
const NONCE_BYTES = 12;
const HEADER_BYTES = MAGIC.length + 1 + NONCE_BYTES;
const TAG_BYTES = 16;
export const OVERHEAD_BYTES = HEADER_BYTES + TAG_BYTES;
const PATH_ID_CHARS = 22;
/** A Drive custom property may hold at most 124 bytes (key + value); keep well below that. */
const PROPERTY_PIECE_CHARS = 100;

export class E2eeError extends Error {
	constructor(
		message: string,
		readonly code:
			| 'wrong-passphrase'
			| 'not-encrypted'
			| 'corrupt'
			| 'unsupported'
			| 'locked'
			| 'bad-properties',
	) {
		super(message);
		this.name = 'E2eeError';
	}
}

const te = new TextEncoder();
const td = new TextDecoder();

const subtle = () => {
	const s = globalThis.crypto?.subtle;
	if (!s) throw new E2eeError('This device has no WebCrypto, so encryption is not available.', 'unsupported');
	return s;
};

const toBytes = (data: ArrayBuffer | Uint8Array): Uint8Array =>
	data instanceof Uint8Array ? data : new Uint8Array(data);

/** A plain ArrayBuffer copy of the bytes (WebCrypto wants a BufferSource that is not a shared view). */
const buf = (bytes: Uint8Array): ArrayBuffer =>
	bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

export const randomBytes = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));

// ---------------------------------------------------------------------------------------
// base64url
// ---------------------------------------------------------------------------------------

export const b64uEncode = (bytes: Uint8Array): string => {
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};

export const b64uDecode = (text: string): Uint8Array => {
	if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new E2eeError('Not base64url text.', 'corrupt');
	const padded = text.replaceAll('-', '+').replaceAll('_', '/') + '==='.slice((text.length + 3) % 4);
	const s = atob(padded);
	const out = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
	return out;
};

// ---------------------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------------------

export interface VaultKeys {
	/** Non-extractable HKDF key holding the DEK. This is what a device stores. */
	dek: CryptoKey;
	content: CryptoKey;
	path: CryptoKey;
	pathId: CryptoKey;
}

const HKDF_SALT = te.encode('ogd-e2ee-v1');

const deriveSubkeys = async (dek: CryptoKey): Promise<VaultKeys> => {
	const s = subtle();
	const aes = (info: string) =>
		s.deriveKey(
			{ name: 'HKDF', hash: 'SHA-256', salt: buf(HKDF_SALT), info: buf(te.encode(info)) },
			dek,
			{ name: 'AES-GCM', length: 256 },
			false,
			['encrypt', 'decrypt'],
		);
	const [content, path, pathId] = await Promise.all([
		aes('content'),
		aes('path'),
		s.deriveKey(
			{ name: 'HKDF', hash: 'SHA-256', salt: buf(HKDF_SALT), info: buf(te.encode('path-id')) },
			dek,
			{ name: 'HMAC', hash: 'SHA-256', length: 256 },
			false,
			['sign'],
		),
	]);
	return { dek, content, path, pathId };
};

/** Turns 32 raw DEK bytes into the stored form (non-extractable) and the working subkeys. */
const keysFromDek = async (raw: Uint8Array): Promise<VaultKeys> => {
	const dek = await subtle().importKey('raw', buf(raw), 'HKDF', false, ['deriveKey']);
	return deriveSubkeys(dek);
};

/** Rebuilds the working keys from the stored non-extractable DEK key. */
export const keysFromStoredDek = (dek: CryptoKey) => deriveSubkeys(dek);

const kekFrom = async (passphrase: string, salt: Uint8Array, iterations: number, usage: KeyUsage[]) => {
	const s = subtle();
	const base = await s.importKey('raw', buf(te.encode(passphrase.normalize('NFKC'))), 'PBKDF2', false, ['deriveKey']);
	return s.deriveKey(
		{ name: 'PBKDF2', hash: 'SHA-256', salt: buf(salt), iterations },
		base,
		{ name: 'AES-GCM', length: 256 },
		false,
		usage,
	);
};

// ---------------------------------------------------------------------------------------
// Vault header (stored on the encrypted vault's root folder; contains no secret)
// ---------------------------------------------------------------------------------------

export interface VaultHeader {
	v: number;
	/** random key id, also the name of this vault's key on a device */
	kid: string;
	iter: number;
	salt: string;
	/** AES-GCM(KEK, nonce, DEK), base64url of nonce | ciphertext | tag */
	wrapped: string;
}

const DEK_AAD = te.encode('ogd-e2ee-dek-v1');

const aesEncrypt = async (key: CryptoKey, plain: Uint8Array, aad: Uint8Array) => {
	const nonce = randomBytes(NONCE_BYTES);
	const ct = new Uint8Array(
		await subtle().encrypt({ name: 'AES-GCM', iv: buf(nonce), additionalData: buf(aad) }, key, buf(plain)),
	);
	return { nonce, ct };
};

/** Creates a new encrypted vault: random DEK wrapped by the passphrase. */
export const createVaultKeys = async (
	passphrase: string,
	iterations = kdf.iterations,
): Promise<{ header: VaultHeader; keys: VaultKeys }> => {
	const salt = randomBytes(16);
	const rawDek = randomBytes(32);
	const kek = await kekFrom(passphrase, salt, iterations, ['encrypt']);
	const { nonce, ct } = await aesEncrypt(kek, rawDek, DEK_AAD);
	const wrapped = new Uint8Array(nonce.length + ct.length);
	wrapped.set(nonce);
	wrapped.set(ct, nonce.length);
	const keys = await keysFromDek(rawDek);
	rawDek.fill(0);
	return {
		header: {
			v: FORMAT_VERSION,
			kid: b64uEncode(randomBytes(12)),
			iter: iterations,
			salt: b64uEncode(salt),
			wrapped: b64uEncode(wrapped),
		},
		keys,
	};
};

/** Opens the header with the passphrase. A wrong passphrase throws `wrong-passphrase` and nothing else happens. */
export const unlockVaultKeys = async (header: VaultHeader, passphrase: string): Promise<VaultKeys> => {
	if (header.v !== FORMAT_VERSION) {
		throw new E2eeError(`This encrypted vault uses format ${header.v}, which this plugin version cannot read.`, 'unsupported');
	}
	if (!Number.isInteger(header.iter) || header.iter < 1000 || header.iter > 10_000_000) {
		throw new E2eeError('The encryption header on Drive looks damaged.', 'corrupt');
	}
	const wrapped = b64uDecode(header.wrapped);
	if (wrapped.length < NONCE_BYTES + TAG_BYTES + 1) throw new E2eeError('The encryption header on Drive looks damaged.', 'corrupt');
	const kek = await kekFrom(passphrase, b64uDecode(header.salt), header.iter, ['decrypt']);
	let raw: Uint8Array;
	try {
		raw = new Uint8Array(
			await subtle().decrypt(
				{ name: 'AES-GCM', iv: buf(wrapped.slice(0, NONCE_BYTES)), additionalData: buf(DEK_AAD) },
				kek,
				buf(wrapped.slice(NONCE_BYTES)),
			),
		);
	} catch {
		throw new E2eeError('Wrong passphrase.', 'wrong-passphrase');
	}
	if (raw.length !== 32) throw new E2eeError('The encryption header on Drive looks damaged.', 'corrupt');
	const keys = await keysFromDek(raw);
	raw.fill(0);
	return keys;
};

/** New header that the same DEK opens with a new passphrase. The keys stay valid, so nothing is re-uploaded. */
export const rewrapHeader = async (
	header: VaultHeader,
	oldPassphrase: string,
	newPassphrase: string,
	iterations = kdf.iterations,
): Promise<VaultHeader> => {
	// unwrap to raw bytes once more (the stored DEK key is not extractable)
	const wrapped = b64uDecode(header.wrapped);
	const oldKek = await kekFrom(oldPassphrase, b64uDecode(header.salt), header.iter, ['decrypt']);
	let raw: Uint8Array;
	try {
		raw = new Uint8Array(
			await subtle().decrypt(
				{ name: 'AES-GCM', iv: buf(wrapped.slice(0, NONCE_BYTES)), additionalData: buf(DEK_AAD) },
				oldKek,
				buf(wrapped.slice(NONCE_BYTES)),
			),
		);
	} catch {
		throw new E2eeError('Wrong passphrase.', 'wrong-passphrase');
	}
	const salt = randomBytes(16);
	const kek = await kekFrom(newPassphrase, salt, iterations, ['encrypt']);
	const { nonce, ct } = await aesEncrypt(kek, raw, DEK_AAD);
	raw.fill(0);
	const out = new Uint8Array(nonce.length + ct.length);
	out.set(nonce);
	out.set(ct, nonce.length);
	return { v: FORMAT_VERSION, kid: header.kid, iter: iterations, salt: b64uEncode(salt), wrapped: b64uEncode(out) };
};

export const headerToProperties = (h: VaultHeader): Record<string, string> => ({
	e2ee: '1',
	hv: String(h.v),
	hk: h.kid,
	hi: String(h.iter),
	hs: h.salt,
	hw: h.wrapped,
});

export const headerFromProperties = (p: Record<string, string> | undefined): VaultHeader | undefined => {
	if (!p || p.e2ee !== '1' || !p.hv || !p.hk || !p.hi || !p.hs || !p.hw) return undefined;
	return { v: Number(p.hv), kid: p.hk, iter: Number(p.hi), salt: p.hs, wrapped: p.hw };
};

// ---------------------------------------------------------------------------------------
// File content
// ---------------------------------------------------------------------------------------

/** `OGDE | version | nonce | ciphertext+tag`. `aad` (the path id) is authenticated but not stored. */
export const encryptBytes = async (
	keys: VaultKeys,
	plain: ArrayBuffer | Uint8Array,
	aad: string,
): Promise<Uint8Array> => {
	const { nonce, ct } = await aesEncrypt(keys.content, toBytes(plain), te.encode(aad));
	const out = new Uint8Array(HEADER_BYTES + ct.length);
	out.set(MAGIC, 0);
	out[MAGIC.length] = FORMAT_VERSION;
	out.set(nonce, MAGIC.length + 1);
	out.set(ct, HEADER_BYTES);
	return out;
};

export const looksEncrypted = (data: ArrayBuffer | Uint8Array) => {
	const b = toBytes(data);
	return b.length >= OVERHEAD_BYTES && MAGIC.every((m, i) => b[i] === m);
};

export const decryptBytes = async (
	keys: VaultKeys,
	data: ArrayBuffer | Uint8Array,
	aad: string,
): Promise<ArrayBuffer> => {
	const b = toBytes(data);
	if (!looksEncrypted(b)) {
		throw new E2eeError('This file on Drive is not encrypted with this plugin\'s format.', 'not-encrypted');
	}
	if (b[MAGIC.length] !== FORMAT_VERSION) {
		throw new E2eeError(`This file uses encryption format ${b[MAGIC.length]}, which this plugin version cannot read.`, 'unsupported');
	}
	try {
		return await subtle().decrypt(
			{
				name: 'AES-GCM',
				iv: buf(b.slice(MAGIC.length + 1, HEADER_BYTES)),
				additionalData: buf(te.encode(aad)),
			},
			keys.content,
			buf(b.slice(HEADER_BYTES)),
		);
	} catch {
		throw new E2eeError(
			'A file on Drive failed its integrity check (damaged, changed, or stored under another path). It was not used.',
			'corrupt',
		);
	}
};

// ---------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------

/** Opaque, stable, searchable id of a path (also the Drive name of the item). */
export const pathIdOf = async (keys: VaultKeys, path: string): Promise<string> => {
	const mac = new Uint8Array(await subtle().sign('HMAC', keys.pathId, buf(te.encode(path))));
	return b64uEncode(mac).slice(0, PATH_ID_CHARS);
};

/** Tag that marks this vault's items on Drive. Derived from the vault name only, so a device can find the vault before it has a key. */
export const vaultTagOf = async (vaultName: string): Promise<string> => {
	const digest = new Uint8Array(await subtle().digest('SHA-256', buf(te.encode('ogd-e2ee-vault:' + vaultName))));
	return b64uEncode(digest).slice(0, PATH_ID_CHARS);
};

/** HMAC of arbitrary text, for values that must not be guessable from outside (restore point signature). */
export const keyedDigest = async (keys: VaultKeys, text: string): Promise<string> => pathIdOf(keys, 'digest:' + text);

const splitPieces = (text: string): string[] => {
	const pieces: string[] = [];
	for (let i = 0; i < text.length; i += PROPERTY_PIECE_CHARS) pieces.push(text.slice(i, i + PROPERTY_PIECE_CHARS));
	return pieces.length ? pieces : [''];
};

/** The plain path stored the way the plugin stores it today: `path`, `path2`, ... pieces of at most 100 bytes. */
const pathKeyName = (i: number) => (i === 1 ? 'path' : `path${i}`);

const plainPathOf = (props: Record<string, string>) => {
	let path = props.path || '';
	for (let i = 2; props[pathKeyName(i)]; i++) path += props[pathKeyName(i)];
	return path;
};

const isPathKey = (k: string) => /^path\d*$/.test(k);
const isEncKey = (k: string) => /^e\d+$/.test(k);

/**
 * Plain properties (as the rest of the plugin writes them) to what goes on Drive:
 * `path` becomes the path id, `e1..eN` carry the encrypted real path. Other keys pass through.
 */
export const encodeProperties = async (
	keys: VaultKeys,
	props: Record<string, string>,
): Promise<Record<string, string>> => {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(props)) if (!isPathKey(k)) out[k] = v;
	if (props.path === undefined) return out;
	const path = plainPathOf(props);
	const id = await pathIdOf(keys, path);
	const enc = await encryptBytes(keys, te.encode(path), 'path:' + id);
	out.path = id;
	splitPieces(b64uEncode(enc)).forEach((piece, i) => (out[`e${i + 1}`] = piece));
	return out;
};

/** The search form of a path property (id only). Non-path properties pass through. */
export const encodeQueryProperties = async (
	keys: VaultKeys,
	props: Record<string, string>,
): Promise<Record<string, string>> => {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(props)) if (!isPathKey(k)) out[k] = v;
	if (props.path !== undefined) out.path = await pathIdOf(keys, plainPathOf(props));
	return out;
};

/** What the server stores back to what the plugin expects: real path pieces, no `e*` keys. Throws if the path does not match its id. */
export const decodeProperties = async (
	keys: VaultKeys,
	props: Record<string, string> | undefined,
): Promise<Record<string, string>> => {
	if (!props || props.path === undefined) return { ...(props ?? {}) };
	let enc = '';
	for (let i = 1; props[`e${i}`] !== undefined; i++) enc += props[`e${i}`];
	if (!enc) throw new E2eeError('A Drive item has no encrypted path.', 'bad-properties');
	let path: string;
	try {
		path = td.decode(await decryptBytes(keys, b64uDecode(enc), 'path:' + props.path));
	} catch (e) {
		if (e instanceof E2eeError) throw new E2eeError('A Drive item has a damaged or foreign path.', 'bad-properties');
		throw e;
	}
	if ((await pathIdOf(keys, path)) !== props.path) {
		throw new E2eeError('A Drive item\'s path does not match its id.', 'bad-properties');
	}
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(props)) if (!isPathKey(k) && !isEncKey(k)) out[k] = v;
	// re-split like the plugin does (pieces of at most 100 bytes), so unSplitPath gives the path back
	let piece = '';
	let n = 1;
	for (const ch of path) {
		if (te.encode(piece + ch).length > 100) {
			out[pathKeyName(n)] = piece;
			piece = '';
			n++;
		}
		piece += ch;
	}
	out[pathKeyName(n)] = piece;
	return out;
};

// ---------------------------------------------------------------------------------------
// Passphrase quality
// ---------------------------------------------------------------------------------------

export const MIN_PASSPHRASE_CHARS = 12;

export const checkPassphrase = (passphrase: string): { ok: boolean; message: string } => {
	const p = passphrase.normalize('NFKC');
	if (p.length < MIN_PASSPHRASE_CHARS) {
		return { ok: false, message: `Use at least ${MIN_PASSPHRASE_CHARS} characters (5 random words is a good choice).` };
	}
	if (new Set(p).size < 5) return { ok: false, message: 'That passphrase repeats too few different characters.' };
	return { ok: true, message: 'Long enough. Keep it in a password manager: it cannot be recovered.' };
};
