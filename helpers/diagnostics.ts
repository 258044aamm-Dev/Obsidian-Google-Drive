export type SyncPhase =
	| 'token-refresh'
	| 'connection-check'
	| 'list-files'
	| 'fetch-changes'
	| 'start-token'
	| 'download'
	| 'upload'
	| 'update'
	| 'delete'
	| 'batch-delete'
	| 'local-write'
	| 'config-sync'
	| 'root-folder'
	| 'settings'
	| 'auto-sync'
	| 'fix-paths';

export interface DiagnosticEntry {
	timestamp: number;
	phase: SyncPhase;
	operation: string;
	httpStatus?: number;
	message: string;
	likelyCause: string;
	suggestedAction: string;
	stack?: string;
}

export class DiagnosticsManager {
	private entries: DiagnosticEntry[] = [];
	private _phase: SyncPhase | null = null;
	private _operation: string | null = null;
	enabled = false;
	maskPaths = true;

	async withContext<T>(
		phase: SyncPhase,
		operation: string,
		fn: () => Promise<T>,
	): Promise<T> {
		const prevPhase = this._phase;
		const prevOperation = this._operation;
		this._phase = phase;
		this._operation = operation;
		try {
			return await fn();
		} finally {
			this._phase = prevPhase;
			this._operation = prevOperation;
		}
	}

	record(entry: {
		phase?: SyncPhase;
		operation?: string;
		message: string;
		httpStatus?: number;
		likelyCause?: string;
		suggestedAction?: string;
		stack?: string;
	}): void {
		if (!this.enabled) return;
		const phase = entry.phase ?? this._phase ?? ('unknown' as SyncPhase);
		const operation = entry.operation ?? this._operation ?? 'unknown';
		const { likelyCause, suggestedAction } = suggestAction(
			entry.httpStatus,
			phase,
		);
		this.entries.push({
			timestamp: Date.now(),
			phase,
			operation,
			httpStatus: entry.httpStatus,
			message: this.maskPaths ? maskPath(entry.message) : entry.message,
			likelyCause: entry.likelyCause ?? likelyCause,
			suggestedAction: entry.suggestedAction ?? suggestedAction,
			stack: entry.stack,
		});
	}

	get currentPhase(): SyncPhase | null {
		return this._phase;
	}

	get currentOperation(): string | null {
		return this._operation;
	}

	getEntries(): readonly DiagnosticEntry[] {
		return [...this.entries];
	}

	clear(): void {
		this.entries = [];
	}

	export(): string {
		return JSON.stringify(
			{
				format: 1,
				plugin: 'google-drive-sync',
				exportedAt: new Date().toISOString(),
				entryCount: this.entries.length,
				entries: this.entries,
			},
			null,
			2,
		);
	}
}

export function sanitizeMessage(raw: unknown): string {
	let msg: string;
	if (typeof raw === 'string') {
		msg = raw;
	} else if (raw instanceof Error) {
		msg = raw.message;
	} else if (raw === null || raw === undefined) {
		msg = '';
	} else if (typeof raw === 'number' || typeof raw === 'boolean') {
		msg = raw.toString();
	} else {
		msg = JSON.stringify(raw);
	}

	try {
		const parsed = JSON.parse(msg) as { error?: { message?: string } };
		if (parsed?.error?.message) msg = parsed.error.message;
	} catch {
		/* not JSON, use as-is */
	}

	msg = msg.replace(
		/Bearer\s+[A-Za-z0-9\-._~+/]+=*/g,
		'Bearer [REDACTED]',
	);

	msg = msg.replace(
		/(refresh_token|access_token|client_secret|client_id|authorization_code|code)["']?\s*[:=]\s*["']?[A-Za-z0-9\-._~+/]+=*/gi,
		(_, key: string) => `${key}=[REDACTED]`,
	);

	msg = msg.replace(/[A-Za-z0-9+/]{50,}={0,2}/g, '[REDACTED]');

	return msg;
}

export function maskPath(text: string): string {
	return text.replace(
		/\b([\w.@-]+(?:\/[\w.@-]+)+(\.\w+)?)\b/g,
		(fullMatch: string) => {
			const parts = fullMatch.split('/');
			return parts
				.map((part, i) => {
					if (i === parts.length - 1 && part.includes('.')) {
						const ext = part.split('.').pop();
						return `***.${ext}`;
					}
					return '***';
				})
				.join('/');
		},
	);
}

const PHASE_CAUSE_OVERRIDES: Partial<
	Record<SyncPhase, Partial<Record<number, { cause: string; action: string }>>>
> = {
	'token-refresh': {
		400: {
			cause: 'Token request was malformed',
			action: 'Verify client ID and secret in plugin settings',
		},
		401: {
			cause: 'Refresh token is invalid, expired, or revoked',
			action: 'Obtain a new refresh token via plugin settings',
		},
		403: {
			cause: 'Token endpoint access forbidden',
			action: 'Re-authenticate; the refresh token may have been revoked',
		},
	},
	'connection-check': {
		400: {
			cause: 'Connectivity check failed',
			action: 'Check internet connection and any firewall/proxy settings',
		},
	},
};

const DEFAULT_STATUS_MAP: Record<
	number,
	{ cause: string; action: string }
> = {
	400: { cause: 'Bad request', action: 'Check plugin configuration' },
	401: {
		cause: 'Authentication expired or invalid',
		action: 'Re-authenticate via plugin settings',
	},
	403: {
		cause: 'Insufficient Google Drive permissions',
		action: 'Re-authorize with full Drive access; check file sharing settings',
	},
	404: {
		cause: 'Resource not found on Google Drive',
		action: 'File may have been deleted externally; retry sync',
	},
	409: {
		cause: 'Conflict with concurrent modification',
		action: 'Retry sync; avoid editing on multiple devices simultaneously',
	},
	413: {
		cause: 'File too large for Google Drive',
		action: 'Reduce file size or split into smaller files',
	},
	429: {
		cause: 'Google API rate limit exceeded',
		action: 'Wait a few minutes and retry',
	},
	500: {
		cause: 'Google server error',
		action: 'Retry later; check Google Workspace status page',
	},
	502: {
		cause: 'Google service unavailable',
		action: 'Retry after a few minutes',
	},
	503: {
		cause: 'Google service unavailable',
		action: 'Retry after a few minutes',
	},
	504: { cause: 'Google service timeout', action: 'Retry later' },
};

export function suggestAction(
	httpStatus: number | undefined,
	phase: SyncPhase | null,
): { likelyCause: string; suggestedAction: string } {
	if (httpStatus) {
		const phaseOverrides = phase ? PHASE_CAUSE_OVERRIDES[phase] : undefined;
		const override = phaseOverrides?.[httpStatus];
		if (override) {
			return { likelyCause: override.cause, suggestedAction: override.action };
		}
		const fallback = DEFAULT_STATUS_MAP[httpStatus];
		if (fallback) {
			return { likelyCause: fallback.cause, suggestedAction: fallback.action };
		}
	}

	if (phase === 'connection-check') {
		return {
			likelyCause: 'Cannot reach Google servers',
			suggestedAction: 'Check your internet connection',
		};
	}
	if (phase === 'local-write') {
		return {
			likelyCause: 'Local file write failed',
			suggestedAction: 'Check vault permissions and disk space',
		};
	}
	return {
		likelyCause: 'An unexpected error occurred',
		suggestedAction:
			'Retry; if persistent, export diagnostics and report as a bug',
	};
}
