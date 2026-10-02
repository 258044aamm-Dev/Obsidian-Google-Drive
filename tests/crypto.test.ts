import { beforeAll, describe, expect, it } from 'vitest';
import {
	E2eeError,
	OVERHEAD_BYTES,
	b64uDecode,
	b64uEncode,
	checkPassphrase,
	createVaultKeys,
	decodeProperties,
	decryptBytes,
	encodeProperties,
	encodeQueryProperties,
	encryptBytes,
	headerFromProperties,
	headerToProperties,
	kdf,
	keyedDigest,
	keysFromStoredDek,
	looksEncrypted,
	pathIdOf,
	rewrapHeader,
	unlockVaultKeys,
	vaultTagOf,
} from '../helpers/crypto';

const PASS = 'correct horse battery staple';
const text = (s: string) => new TextEncoder().encode(s);
const str = (b: ArrayBuffer | Uint8Array) => new TextDecoder().decode(b);
const failsWith = async (p: Promise<unknown>, code: string) => {
	try {
		await p;
	} catch (e) {
		expect(e).toBeInstanceOf(E2eeError);
		expect((e as E2eeError).code).toBe(code);
		return;
	}
	throw new Error('expected an E2eeError ' + code);
};

beforeAll(() => {
	kdf.iterations = 1000; // key derivation speed only; the format stores the number
});

describe('vault keys', () => {
	it('opens with the right passphrase and gives the same keys as the creator', async () => {
		const { header, keys } = await createVaultKeys(PASS);
		const again = await unlockVaultKeys(header, PASS);
		const enc = await encryptBytes(keys, text('hello'), 'id1');
		expect(str(await decryptBytes(again, enc, 'id1'))).toBe('hello');
	});

	it('rejects a wrong passphrase with a clear error', async () => {
		const { header } = await createVaultKeys(PASS);
		await failsWith(unlockVaultKeys(header, PASS + '!'), 'wrong-passphrase');
	});

	it('NFKC-normalises the passphrase (same text typed on another keyboard)', async () => {
		const { header } = await createVaultKeys('caf\u00e9 caf\u00e9 caf\u00e9');
		await unlockVaultKeys(header, 'cafe\u0301 cafe\u0301 cafe\u0301');
	});

	it('rejects a damaged or foreign header', async () => {
		const { header } = await createVaultKeys(PASS);
		await failsWith(unlockVaultKeys({ ...header, v: 99 }, PASS), 'unsupported');
		await failsWith(unlockVaultKeys({ ...header, iter: 5 }, PASS), 'corrupt');
		await failsWith(unlockVaultKeys({ ...header, wrapped: b64uEncode(new Uint8Array(40)) }, PASS), 'wrong-passphrase');
	});

	it('header survives the round trip through Drive properties', async () => {
		const { header } = await createVaultKeys(PASS);
		const props = headerToProperties(header);
		for (const [k, v] of Object.entries(props)) expect(k.length + v.length).toBeLessThanOrEqual(124); // Drive limit
		expect(headerFromProperties(props)).toEqual(header);
		expect(headerFromProperties({})).toBeUndefined();
		expect(headerFromProperties({ ...props, hw: '' })).toBeUndefined();
	});

	it('changing the passphrase keeps the data key: old files stay readable', async () => {
		const { header, keys } = await createVaultKeys(PASS);
		const enc = await encryptBytes(keys, text('kept'), 'x');
		await failsWith(rewrapHeader(header, 'wrong wrong wrong', 'a brand new passphrase'), 'wrong-passphrase');
		const next = await rewrapHeader(header, PASS, 'a brand new passphrase');
		expect(next.kid).toBe(header.kid);
		expect(next.salt).not.toBe(header.salt);
		await failsWith(unlockVaultKeys(next, PASS), 'wrong-passphrase');
		const opened = await unlockVaultKeys(next, 'a brand new passphrase');
		expect(str(await decryptBytes(opened, enc, 'x'))).toBe('kept');
	});

	it('the stored non-extractable data key rebuilds working keys', async () => {
		const { keys } = await createVaultKeys(PASS);
		expect(keys.dek.extractable).toBe(false);
		const rebuilt = await keysFromStoredDek(keys.dek);
		const enc = await encryptBytes(keys, text('same'), 'p');
		expect(str(await decryptBytes(rebuilt, enc, 'p'))).toBe('same');
		expect(await pathIdOf(rebuilt, 'a/b.md')).toBe(await pathIdOf(keys, 'a/b.md'));
	});
});

describe('file encryption', () => {
	it('round-trips empty, small, binary and large content', async () => {
		const { keys } = await createVaultKeys(PASS);
		for (const size of [0, 1, 15, 16, 17, 1000, 100_000]) {
			const plain = new Uint8Array(size).map((_, i) => (i * 31 + 7) & 255);
			const enc = await encryptBytes(keys, plain, 'id');
			expect(enc.length).toBe(size + OVERHEAD_BYTES);
			expect(looksEncrypted(enc)).toBe(true);
			expect(new Uint8Array(await decryptBytes(keys, enc, 'id'))).toEqual(plain);
		}
	});

	it('never repeats a nonce and never shows plaintext', async () => {
		const { keys } = await createVaultKeys(PASS);
		const a = await encryptBytes(keys, text('SECRET NOTE'), 'id');
		const b = await encryptBytes(keys, text('SECRET NOTE'), 'id');
		expect(a).not.toEqual(b);
		expect(str(a)).not.toContain('SECRET');
	});

	it('detects any changed byte, a truncated file and trailing garbage', async () => {
		const { keys } = await createVaultKeys(PASS);
		const enc = await encryptBytes(keys, text('important words'), 'id');
		for (let i = 0; i < enc.length; i++) {
			const bad = enc.slice();
			bad[i] = bad[i]! ^ 1;
			await expect(decryptBytes(keys, bad, 'id')).rejects.toBeInstanceOf(E2eeError);
		}
		await expect(decryptBytes(keys, enc.slice(0, enc.length - 1), 'id')).rejects.toBeInstanceOf(E2eeError);
		await expect(decryptBytes(keys, new Uint8Array([...enc, 0]), 'id')).rejects.toBeInstanceOf(E2eeError);
	});

	it('refuses ciphertext that belongs to another path (swap / move attack)', async () => {
		const { keys } = await createVaultKeys(PASS);
		const enc = await encryptBytes(keys, text('for a.md'), await pathIdOf(keys, 'a.md'));
		await failsWith(decryptBytes(keys, enc, await pathIdOf(keys, 'b.md')), 'corrupt');
	});

	it('refuses other vaults\' keys and plain files', async () => {
		const one = await createVaultKeys(PASS);
		const two = await createVaultKeys(PASS);
		const enc = await encryptBytes(one.keys, text('x'), 'id');
		await failsWith(decryptBytes(two.keys, enc, 'id'), 'corrupt');
		await failsWith(decryptBytes(one.keys, text('# a plain markdown note, not encrypted at all'), 'id'), 'not-encrypted');
		const future = enc.slice();
		future[4] = 2;
		await failsWith(decryptBytes(one.keys, future, 'id'), 'unsupported');
	});

	it('known-answer: a file written by this version (format 1) opens', async () => {
		// Fixed vector so that a future change of the format cannot silently orphan existing vaults.
		const header = {
			v: 1,
			kid: 'kid',
			iter: 1000,
			salt: 'AAAAAAAAAAAAAAAAAAAAAA',
			wrapped: '',
		};
		// build the wrapped DEK deterministically with WebCrypto, independent of crypto.ts
		const s = globalThis.crypto.subtle;
		const base = await s.importKey('raw', text(PASS), 'PBKDF2', false, ['deriveKey']);
		const kek = await s.deriveKey(
			{ name: 'PBKDF2', hash: 'SHA-256', salt: new Uint8Array(16), iterations: 1000 },
			base,
			{ name: 'AES-GCM', length: 256 },
			false,
			['encrypt'],
		);
		const dek = new Uint8Array(32).map((_, i) => i);
		const nonce = new Uint8Array(12).map((_, i) => 100 + i);
		const ct = new Uint8Array(await s.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: text('ogd-e2ee-dek-v1') }, kek, dek));
		header.wrapped = b64uEncode(new Uint8Array([...nonce, ...ct]));
		const keys = await unlockVaultKeys(header, PASS);
		// the path id is HMAC-SHA256(HKDF(dek, salt 'ogd-e2ee-v1', info 'path-id'), path) cut to 22 characters,
		// computed here without crypto.ts, so a change of the derivation (which would orphan every file) fails
		const hk = await s.importKey('raw', dek, 'HKDF', false, ['deriveKey']);
		const macKey = await s.deriveKey(
			{ name: 'HKDF', hash: 'SHA-256', salt: text('ogd-e2ee-v1'), info: text('path-id') },
			hk,
			{ name: 'HMAC', hash: 'SHA-256', length: 256 },
			false,
			['sign'],
		);
		const mac = new Uint8Array(await s.sign('HMAC', macKey, text('Inbox/a.md')));
		expect(await pathIdOf(keys, 'Inbox/a.md')).toBe(b64uEncode(mac).slice(0, 22));
	});
});

describe('path properties', () => {
	const cases = [
		'a.md',
		'Inbox/a.md',
		'Projects/Alpha/notes/deep.md',
		'日本語/ノート.md',
		'emoji 🎉/file ✨.md',
		'x/' + 'very long name '.repeat(30) + '.md',
		'.obsidian/plugins/some-plugin/data.json',
	];
	/** Same rule as splitPath in helpers/drive.ts: pieces of at most 100 bytes in path, path2, ... */
	const split = (path: string) => {
		const out: Record<string, string> = {};
		let piece = '';
		let i = 1;
		for (const char of path) {
			if (new TextEncoder().encode(piece + char).length > 100) {
				out[i === 1 ? 'path' : `path${i}`] = piece;
				piece = '';
				i++;
			}
			piece += char;
		}
		out[i === 1 ? 'path' : `path${i}`] = piece;
		return out;
	};

	it.each(cases)('round-trips %s and hides it', async (path) => {
		const { keys } = await createVaultKeys(PASS);
		const plain = { ...split(path), vault: 'V', config: 'false' };
		expect(Object.keys(plain).length).toBeGreaterThanOrEqual(3);
		const enc = await encodeProperties(keys, plain);
		const all = JSON.stringify(enc);
		for (const part of path.split('/').filter((p) => p.length > 3)) expect(all).not.toContain(part);
		expect(enc.vault).toBe('V');
		expect(enc.config).toBe('false');
		expect(enc.path).toBe(await pathIdOf(keys, path));
		expect(enc.path).toHaveLength(22);
		for (const [k, v] of Object.entries(enc)) expect(k.length + v.length).toBeLessThanOrEqual(124);
		const dec = await decodeProperties(keys, enc);
		expect(dec).toEqual(plain);
		expect(await encodeQueryProperties(keys, plain)).toEqual({ vault: 'V', config: 'false', path: enc.path });
	});

	it('is stable (the same path always has the same id) and differs per vault key', async () => {
		const one = await createVaultKeys(PASS);
		const two = await createVaultKeys(PASS);
		expect(await pathIdOf(one.keys, 'a.md')).toBe(await pathIdOf(one.keys, 'a.md'));
		expect(await pathIdOf(one.keys, 'a.md')).not.toBe(await pathIdOf(two.keys, 'a.md'));
		expect(await keyedDigest(one.keys, 'x')).not.toBe(await keyedDigest(two.keys, 'x'));
	});

	it('rejects a swapped, forged or foreign path record', async () => {
		const { keys } = await createVaultKeys(PASS);
		const other = await createVaultKeys(PASS);
		const a = await encodeProperties(keys, { path: 'a.md' });
		const b = await encodeProperties(keys, { path: 'b.md' });
		// b's encrypted path under a's id
		await failsWith(decodeProperties(keys, { ...b, path: a.path! }), 'bad-properties');
		// a's id with no encrypted path
		await failsWith(decodeProperties(keys, { path: a.path! }), 'bad-properties');
		// foreign key
		await failsWith(decodeProperties(other.keys, a), 'bad-properties');
		// damaged piece
		await failsWith(decodeProperties(keys, { ...a, e1: a.e1!.slice(0, -2) + 'AA' }), 'bad-properties');
	});

	it('passes items without a path (e.g. history files) through unchanged', async () => {
		const { keys } = await createVaultKeys(PASS);
		expect(await decodeProperties(keys, { history: 'h', kind: 'point' })).toEqual({ history: 'h', kind: 'point' });
		expect(await decodeProperties(keys, undefined)).toEqual({});
	});

	it('vault tag is stable and does not contain the name', async () => {
		const tag = await vaultTagOf('My Private Vault');
		expect(tag).toBe(await vaultTagOf('My Private Vault'));
		expect(tag).not.toContain('Private');
		expect(tag).not.toBe(await vaultTagOf('Other'));
	});
});

describe('base64url and passphrase rules', () => {
	it('base64url round-trips all byte values without padding', () => {
		const all = new Uint8Array(256).map((_, i) => i);
		const s = b64uEncode(all);
		expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(b64uDecode(s)).toEqual(all);
	});

	it('requires at least 12 characters and some variety', () => {
		expect(checkPassphrase('short').ok).toBe(false);
		expect(checkPassphrase('aaaaaaaaaaaaaaaa').ok).toBe(false);
		expect(checkPassphrase('correct horse battery staple').ok).toBe(true);
	});
});
