import { describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { md5Hex } from '../../helpers/md5';

const node = (b: Uint8Array) => createHash('md5').update(b).digest('hex');

describe('md5Hex', () => {
	it('gives the standard test vectors (RFC 1321)', () => {
		const te = new TextEncoder();
		expect(md5Hex(te.encode(''))).toBe('d41d8cd98f00b204e9800998ecf8427e');
		expect(md5Hex(te.encode('a'))).toBe('0cc175b9c0f1b6a831c399e269772661');
		expect(md5Hex(te.encode('abc'))).toBe('900150983cd24fb0d6963f7d28e17f72');
		expect(md5Hex(te.encode('message digest'))).toBe('f96b697d7cb7938d525a2f31aaf161d0');
		expect(md5Hex(te.encode('abcdefghijklmnopqrstuvwxyz'))).toBe('c3fcd3d76192e4007dfb496cca67e13b');
		expect(md5Hex(te.encode('12345678901234567890123456789012345678901234567890123456789012345678901234567890'))).toBe(
			'57edf4a22be3c955ac49da2e2107b67a',
		);
	});

	it('agrees with Node for every length around the block and padding borders', () => {
		for (let n = 0; n <= 200; n++) {
			const b = new Uint8Array(randomBytes(n));
			expect(md5Hex(b), `length ${n}`).toBe(node(b));
		}
	});

	it('agrees with Node for a big file, an ArrayBuffer and a view into a larger buffer', () => {
		const big = new Uint8Array(randomBytes(3_000_001));
		expect(md5Hex(big)).toBe(node(big));
		expect(md5Hex(big.buffer.slice(0, 1000))).toBe(node(big.subarray(0, 1000)));
		expect(md5Hex(big.subarray(7, 1234))).toBe(node(big.subarray(7, 1234)));
	});
});
