/**
 * How the plugin deals with a slow, flaky or lost connection (3.8.0).
 *
 *  - every Drive request has a time limit, so a request that never answers cannot freeze a sync;
 *  - a failed request that is safe to repeat (reading, updating by id, deleting) is retried a few times
 *    with growing waits, within a total time limit per sync;
 *  - a request that CREATES something is never repeated blindly (see `retryCreate` in drive.ts);
 *  - failures that come from the connection (not from Google answering "no") are recognisable, so
 *    the notices can say "connection lost or too slow".
 *
 * Obsidian's `requestUrl` cannot be cancelled: a request that timed out is abandoned, and its late
 * answer is ignored.
 */
import type ObsidianGoogleDrive from '../main';

/** Mutable on purpose: tests shorten the times. */
export const net = {
	/** list, metadata and other small requests */
	timeoutMs: 30_000,
	/** uploads: this plus `perMbMs` for every MB sent */
	transferTimeoutMs: 60_000,
	perMbMs: 10_000,
	/** downloads of file content */
	downloadTimeoutMs: 120_000,
	/** waits before retry 1, 2 and 3 */
	delays: [1000, 3000, 9000],
	/** no retry is started later than this after the first retry of a sync */
	budgetMs: 60_000,
	/** the connection checks at the start of a sync */
	probeTimeoutMs: 8000,
	/** wait before the second look for a file that a lost create may have made */
	settleMs: 2000,
};

export class RequestTimeoutError extends Error {
	constructor(ms: number) {
		super(`The request did not finish within ${Math.round(ms / 1000)} seconds`);
		this.name = 'RequestTimeoutError';
	}
}

/** Google answered with an error status. */
export class DriveHttpError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly retryAfter?: string,
	) {
		super(message);
		this.name = 'DriveHttpError';
	}
}

const networkErrors = new WeakSet<object>();

/** The request itself failed (no answer from Google): lost connection, DNS, timeout. */
export const markNetworkError = (error: unknown) => {
	if (typeof error === 'object' && error !== null) networkErrors.add(error);
};

export const isNetworkError = (error: unknown) =>
	error instanceof RequestTimeoutError ||
	(typeof error === 'object' && error !== null && networkErrors.has(error));

export const isRetryableStatus = (status: number) =>
	status === 429 || status === 500 || status === 502 || status === 503 || status === 504;

export const isRetryableError = (error: unknown) =>
	isNetworkError(error) || (error instanceof DriveHttpError && isRetryableStatus(error.status));

/** The sentence added to a failure notice when the cause was the connection. */
export const CONNECTION_HINT =
	'The connection to Google Drive was lost or too slow.';

export const connectionHint = (error: unknown) =>
	isNetworkError(error) ? CONNECTION_HINT : undefined;

// Obsidian runs in a window (also a popout window); tests run without one.
const timers = (): Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'> =>
	typeof window !== 'undefined' ? window : globalThis;

export const sleep = (ms: number) => new Promise<void>((resolve) => timers().setTimeout(resolve, ms));

export const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const { setTimeout, clearTimeout } = timers();
	// the abandoned request may still fail later: nobody listens, so it must not be reported as unhandled
	promise.catch(() => undefined);
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new RequestTimeoutError(ms)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

/** Time limit for one request. `bytes` is the size of what is sent. */
export const requestTimeoutFor = (path: string, bytes: number) => {
	if (path.includes('alt=media')) return net.downloadTimeoutMs;
	if (bytes > 0) return net.transferTimeoutMs + Math.ceil(bytes / 1_000_000) * net.perMbMs;
	return net.timeoutMs;
};

// ---------------------------------------------------------------------------------------
// The retry window of a sync
// ---------------------------------------------------------------------------------------

const windows = new WeakMap<object, { start: number; last: number }>();
const STALE_MS = 5 * 60_000;

/** A new sync starts with a fresh retry window. */
export const resetRetryWindow = (t: object) => {
	windows.delete(t);
};

/**
 * Milliseconds to wait before retry number `attempt` (0 = the first retry), or undefined when no
 * retry is left: out of attempts, or the sync has spent its time for retrying.
 */
export const retryDelay = (t: object, attempt: number, retryAfter?: string) => {
	const base = net.delays[attempt];
	if (base === undefined) return undefined;
	const now = Date.now();
	let window = windows.get(t);
	if (!window || now - window.last > STALE_MS) {
		window = { start: now, last: now };
		windows.set(t, window);
	}
	let wait = Math.round(base * (0.8 + Math.random() * 0.4));
	const seconds = Number(retryAfter);
	if (Number.isFinite(seconds) && seconds > 0) {
		wait = Math.max(wait, Math.min(seconds * 1000, 30_000));
	}
	if (now - window.start + wait > net.budgetMs) return undefined;
	window.last = now;
	return wait;
};

export const noteRetry = (
	t: ObsidianGoogleDrive,
	what: string,
	attempt: number,
	waitMs: number,
	error: unknown,
) => {
	try {
		const reason =
			error instanceof DriveHttpError
				? `HTTP ${error.status}`
				: error instanceof Error
					? error.message
					: String(error);
		t.diagnostics.record({
			operation: 'retry',
			message: `${what}: ${reason}; retry ${attempt + 1} of ${net.delays.length} in ${Math.round(waitMs / 100) / 10} s`,
		});
	} catch {
		// diagnostics are best effort
	}
};
