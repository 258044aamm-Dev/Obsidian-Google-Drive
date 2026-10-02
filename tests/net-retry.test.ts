import { afterEach, describe, expect, it } from 'vitest';
import {
	connectionHint,
	DriveHttpError,
	isNetworkError,
	isRetryableStatus,
	markNetworkError,
	net,
	requestTimeoutFor,
	resetRetryWindow,
	retryDelay,
	withTimeout,
	RequestTimeoutError,
} from '../helpers/net-retry';

const saved = { ...net, delays: [...net.delays] };
afterEach(() => Object.assign(net, saved));

describe('retry rules', () => {
	it('only temporary statuses are retried', () => {
		for (const s of [429, 500, 502, 503, 504]) expect(isRetryableStatus(s)).toBe(true);
		for (const s of [200, 204, 400, 401, 403, 404, 409, 412]) expect(isRetryableStatus(s)).toBe(false);
	});

	it('waits grow, then run out', () => {
		net.delays = [1000, 3000, 9000];
		net.budgetMs = 1_000_000;
		const t = {};
		const waits = [0, 1, 2].map((i) => retryDelay(t, i)!);
		expect(waits[0]!).toBeGreaterThanOrEqual(800);
		expect(waits[0]!).toBeLessThanOrEqual(1200);
		expect(waits[2]!).toBeGreaterThan(waits[0]!);
		expect(retryDelay(t, 3)).toBeUndefined();
	});

	it('Retry-After is honoured but capped at 30 seconds', () => {
		net.delays = [1000];
		net.budgetMs = 1_000_000;
		expect(retryDelay({}, 0, '5')).toBe(5000);
		expect(retryDelay({}, 0, '999')).toBe(30_000);
		expect(retryDelay({}, 0, 'soon')).toBeLessThanOrEqual(1200);
	});

	it('the time budget stops further retries; a new sync starts fresh', () => {
		net.delays = [10, 10];
		net.budgetMs = 5;
		const t = {};
		expect(retryDelay(t, 0)).toBeUndefined();
		net.budgetMs = 1_000_000;
		expect(retryDelay(t, 0)).toBeDefined();
		resetRetryWindow(t);
		expect(retryDelay(t, 0)).toBeDefined();
	});

	it('errors from the connection are recognised; a refusal from Google is not one', () => {
		const lost = new Error('net::ERR_INTERNET_DISCONNECTED');
		expect(connectionHint(lost)).toBeUndefined();
		markNetworkError(lost);
		expect(isNetworkError(lost)).toBe(true);
		expect(connectionHint(lost)).toMatch(/lost or too slow/);
		expect(connectionHint(new DriveHttpError('Request failed with status 403', 403))).toBeUndefined();
		expect(connectionHint(new RequestTimeoutError(30000))).toMatch(/lost or too slow/);
	});

	it('withTimeout passes results and errors through and gives up on a silent request', async () => {
		await expect(withTimeout(Promise.resolve(5), 50)).resolves.toBe(5);
		await expect(withTimeout(Promise.reject(new Error('x')), 50)).rejects.toThrow('x');
		await expect(withTimeout(new Promise(() => undefined), 20)).rejects.toBeInstanceOf(RequestTimeoutError);
	});

	it('uploads and downloads get more time than small requests, growing with size', () => {
		expect(requestTimeoutFor('drive/v3/files', 0)).toBe(net.timeoutMs);
		expect(requestTimeoutFor('drive/v3/files/x?alt=media', 0)).toBe(net.downloadTimeoutMs);
		expect(requestTimeoutFor('upload/drive/v3/files', 5 * 1024 * 1024)).toBeGreaterThan(
			requestTimeoutFor('upload/drive/v3/files', 1024),
		);
	});
});
