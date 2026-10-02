import type ObsidianGoogleDrive from '../main';
import { Notice, requestUrl, RequestUrlResponse } from 'obsidian';
import { sanitizeMessage, suggestAction } from './diagnostics';
import {
	DriveHttpError,
	isRetryableStatus,
	markNetworkError,
	net,
	noteRetry,
	requestTimeoutFor,
	retryDelay,
	sleep,
	withTimeout,
} from './net-retry';

/** A request that creates a file or folder: repeating it blindly could create a duplicate (see drive.ts). */
const isCreateRequest = (method: string, path: string) =>
	method === 'POST' && /^\/?(upload\/)?drive\/v3\/files(\?|$)/.test(path);

interface RequestOptions {
	body?: BodyInit;
	headers?: Record<string, string>;
	json?: unknown;
}

interface DriveResponse {
	readonly ok: boolean;
	readonly status: number;
	readonly headers: Record<string, string>;
	arrayBuffer(): Promise<ArrayBuffer>;
	json<T>(): Promise<T>;
	text(): Promise<string>;
}

const serializeBody = async (
	options: RequestOptions,
): Promise<{ body?: string | ArrayBuffer; contentType?: string }> => {
	if (options.json !== undefined) {
		return {
			body: JSON.stringify(options.json),
			contentType: 'application/json',
		};
	}

	if (options.body === undefined || options.body === null) return {};
	if (typeof options.body === 'string') return { body: options.body };
	if (options.body instanceof ArrayBuffer) return { body: options.body };
	if (ArrayBuffer.isView(options.body)) {
		return {
			body: options.body.buffer.slice(
				options.body.byteOffset,
				options.body.byteOffset + options.body.byteLength,
			),
		};
	}

	const encoded = new Request('https://localhost', {
		method: 'POST',
		body: options.body,
	});
	return {
		body: await encoded.arrayBuffer(),
		contentType: encoded.headers.get('Content-Type') ?? undefined,
	};
};

const toDriveResponse = (response: RequestUrlResponse): DriveResponse => ({
	ok: response.status >= 200 && response.status < 300,
	status: response.status,
	headers: response.headers ?? {},
	arrayBuffer: async () => response.arrayBuffer,
	json: async <T>() => response.json as T,
	text: async () => response.text,
});

export const getDriveAgent = (t: ObsidianGoogleDrive) => {
	const send = (
		method: string,
		path: string,
		options: RequestOptions = {},
	) => {
		const response = (async () => {
			try {
				if (
					t.accessToken.token &&
					t.accessToken.expiresAt - Date.now() < 60_000
				) {
					const refreshed = await refreshAccessToken(t);
					if (!refreshed) {
						throw new Error(
							'Access token refresh failed; request aborted',
						);
					}
				}

				const { body, contentType } = await serializeBody(options);
				const headers = { ...options.headers };
				if (t.accessToken.token) {
					headers.Authorization = `Bearer ${t.accessToken.token}`;
				}

				const url = new URL(path, 'https://www.googleapis.com/').toString();
				const bytes =
					body instanceof ArrayBuffer
						? body.byteLength
						: typeof body === 'string'
							? body.length
							: 0;
				const timeoutMs = requestTimeoutFor(path, bytes);
				// Reading, updating by id and deleting can be repeated safely. A create is never
				// repeated here: drive.ts looks for what a lost create may have made first.
				const mayRetry = !isCreateRequest(method, path);
				let result: RequestUrlResponse;
				let attempt = 0;
				for (;;) {
					try {
						result = await withTimeout(
							requestUrl({
								url,
								method,
								headers,
								body,
								contentType,
								throw: false,
							}),
							timeoutMs,
						);
					} catch (error) {
						markNetworkError(error);
						const wait = mayRetry ? retryDelay(t, attempt) : undefined;
						if (wait === undefined) throw error;
						noteRetry(t, `${method} ${path.split('?')[0]}`, attempt, wait, error);
						await sleep(wait);
						attempt++;
						continue;
					}
					if (mayRetry && isRetryableStatus(result.status)) {
						const wait = retryDelay(t, attempt, result.headers?.['retry-after']);
						if (wait !== undefined) {
							noteRetry(
								t,
								`${method} ${path.split('?')[0]}`,
								attempt,
								wait,
								new DriveHttpError('', result.status),
							);
							await sleep(wait);
							attempt++;
							continue;
						}
					}
					break;
				}
				// A repeated delete finds the file already gone when the first try did get through.
				if (attempt > 0 && method === 'DELETE' && result.status === 404) {
					return toDriveResponse({
						status: 204,
						headers: result.headers ?? {},
						arrayBuffer: new ArrayBuffer(0),
						json: undefined,
						text: '',
					});
				}

				if (result.status < 200 || result.status >= 300) {
					const sanitized = sanitizeMessage(result.text);
					t.diagnostics.record({
						httpStatus: result.status,
						message: `HTTP ${result.status}: ${sanitized}`,
					});
					const phase = t.diagnostics.currentPhase;
					const phaseLabel = phase ? `[${phase}] ` : '';
					const { likelyCause, suggestedAction } = suggestAction(
						result.status,
						phase,
					);
					new Notice(
						`${phaseLabel}HTTP ${result.status} — ${likelyCause}. ${suggestedAction}`,
						8000,
					);
					throw new DriveHttpError(
						`Request failed with status ${result.status}: ${sanitized}`,
						result.status,
						result.headers?.['retry-after'],
					);
				}
				return toDriveResponse(result);
			} catch (error) {
				if (
					error instanceof Error &&
					error.message.includes('Request failed with status')
				) {
					throw error;
				}
				t.diagnostics.record({
					message: sanitizeMessage(error),
					stack: error instanceof Error ? error.stack : undefined,
				});
				throw error;
			}
		})();

		return {
			arrayBuffer: () => response.then((result) => result.arrayBuffer()),
			json: <T>() => response.then((result) => result.json<T>()),
			text: () => response.then((result) => result.text()),
			then: response.then.bind(response),
		};
	};

	return {
		get: (path: string, options?: RequestOptions) =>
			send('GET', path, options),
		post: (path: string, options?: RequestOptions) =>
			send('POST', path, options),
		patch: (path: string, options?: RequestOptions) =>
			send('PATCH', path, options),
		delete: (path: string, options?: RequestOptions) =>
			send('DELETE', path, options),
	};
};

export const refreshAccessToken = async (
	t: ObsidianGoogleDrive,
	refreshToken?: string,
) => {
	try {
		const token = refreshToken || t.settings.refreshToken;
		const hasCustomClient = Boolean(
			t.settings.clientId && t.settings.clientSecret,
		);
		const response = await withTimeout(
			requestUrl(
			hasCustomClient
				? {
						url: 'https://oauth2.googleapis.com/token',
						method: 'POST',
						contentType: 'application/x-www-form-urlencoded',
						body: new URLSearchParams({
							client_id: t.settings.clientId,
							client_secret: t.settings.clientSecret,
							grant_type: 'refresh_token',
							refresh_token: token,
						}).toString(),
						throw: false,
					}
				: {
						url:
							t.settings.accessTokenUrl ||
							'https://ogd-server.richardxiong.com/api/access',
						method: 'POST',
						contentType: 'application/json',
						body: JSON.stringify({
							refresh_token: token,
							clientId: t.settings.clientId,
							clientSecret: t.settings.clientSecret,
						}),
						throw: false,
					},
			),
			net.timeoutMs,
		);

		if ([400, 401, 403].includes(response.status)) {
			console.error(
				`Refresh token rejected (HTTP ${response.status}): ${response.text}`,
			);
			t.diagnostics.record({
				phase: 'token-refresh',
				operation: 'refresh-access-token',
				httpStatus: response.status,
				message: `Token endpoint rejected the request (HTTP ${response.status})`,
			});
			new Notice(
				'Your refresh token was rejected. Please add a new refresh token and try again.',
				0,
			);
			return;
		}

		if (response.status < 200 || response.status >= 300) {
			t.diagnostics.record({
				phase: 'token-refresh',
				operation: 'refresh-access-token',
				httpStatus: response.status,
				message: `Token endpoint returned HTTP ${response.status}`,
			});
			new Notice(
				`Could not refresh your access token (HTTP ${response.status}). Your refresh token was kept; please try again.`,
			);
			return;
		}

		const { expires_in, access_token } = response.json as {
			expires_in: number;
			access_token: string;
		};

		t.accessToken = {
			token: access_token,
			expiresAt: Date.now() + expires_in * 1000,
		};
		return t.accessToken;
	} catch (error) {
		t.diagnostics.record({
			phase: 'token-refresh',
			operation: 'refresh-access-token',
			message: sanitizeMessage(error),
			stack: error instanceof Error ? error.stack : undefined,
		});
		new Notice(
			'Could not refresh your access token. Your refresh token was kept; check your connection and try again.',
		);
	}
	return;
};
