/**
 * MD5 of some bytes, as hex. Only used to compare a local file with the checksum Google Drive reports for the
 * file it holds (`md5Checksum`); it is not used for anything that must stay secret. The browser's built-in
 * crypto has no MD5, so this is the plain algorithm (RFC 1321).
 */
const SHIFTS = [
	7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16,
	23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const CONSTANTS = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

export const md5Hex = (input: ArrayBuffer | Uint8Array): string => {
	const data = input instanceof Uint8Array ? input : new Uint8Array(input);
	let a0 = 0x67452301;
	let b0 = 0xefcdab89;
	let c0 = 0x98badcfe;
	let d0 = 0x10325476;
	const words = new Uint32Array(16);

	const block = (view: DataView, offset: number) => {
		for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4, true);
		let a = a0;
		let b = b0;
		let c = c0;
		let d = d0;
		for (let i = 0; i < 64; i++) {
			let f: number;
			let g: number;
			if (i < 16) {
				f = (b & c) | (~b & d);
				g = i;
			} else if (i < 32) {
				f = (d & b) | (~d & c);
				g = (5 * i + 1) % 16;
			} else if (i < 48) {
				f = b ^ c ^ d;
				g = (3 * i + 5) % 16;
			} else {
				f = c ^ (b | ~d);
				g = (7 * i) % 16;
			}
			f = (f + a + CONSTANTS[i]! + words[g]!) >>> 0;
			a = d;
			d = c;
			c = b;
			const s = SHIFTS[i]!;
			b = (b + ((f << s) | (f >>> (32 - s)))) >>> 0;
		}
		a0 = (a0 + a) >>> 0;
		b0 = (b0 + b) >>> 0;
		c0 = (c0 + c) >>> 0;
		d0 = (d0 + d) >>> 0;
	};

	// whole 64-byte blocks straight from the input, then the rest with the padding (no copy of a big file)
	const whole = data.length - (data.length % 64);
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	for (let offset = 0; offset < whole; offset += 64) block(view, offset);
	const rest = data.length - whole;
	const tailLength = rest < 56 ? 64 : 128;
	const tail = new Uint8Array(tailLength);
	tail.set(data.subarray(whole));
	tail[rest] = 0x80;
	const tailView = new DataView(tail.buffer);
	tailView.setUint32(tailLength - 8, (data.length * 8) >>> 0, true);
	tailView.setUint32(tailLength - 4, Math.floor((data.length * 8) / 2 ** 32), true);
	for (let offset = 0; offset < tailLength; offset += 64) block(tailView, offset);

	const out = new Uint8Array(16);
	const outView = new DataView(out.buffer);
	[a0, b0, c0, d0].forEach((v, i) => outView.setUint32(i * 4, v, true));
	return Array.from(out, (b) => b.toString(16).padStart(2, '0')).join('');
};
