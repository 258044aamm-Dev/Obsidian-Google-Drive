import type ObsidianGoogleDrive from '../main';
import { isConfigPathSynced } from './config-scope';

/**
 * The ignore list: patterns (one per line) for files and folders that sync leaves alone.
 *
 *  - blank lines and lines that start with `#` are skipped; spaces around a line are trimmed;
 *  - `*` matches any characters except `/`, `**` matches anything including `/`, `?` matches one character;
 *  - a pattern without `/` matches a file or folder NAME at any depth (`BRAT-log.md`, `*.tmp`);
 *  - a pattern with a `/` at the start or in the middle starts at the vault root (`Daily/*.md`, `/Inbox`);
 *  - a `/` at the very end is allowed and changes nothing (`Archive/` is `Archive`);
 *  - a match on a folder covers everything inside it;
 *  - upper and lower case are the same.
 *
 * The pattern is matched by a small automaton, not by a regular expression, so no pattern can make
 * the match slow or fail.
 */

type Token =
	| { kind: 'lit'; char: string }
	| { kind: 'one' } // ?
	| { kind: 'star' } // *
	| { kind: 'deep' } // **
	| { kind: 'dirs' }; // **/ : any folders, or nothing

const MAX_PATTERN_LENGTH = 300;

const tokenize = (pattern: string): Token[] => {
	const tokens: Token[] = [];
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i] as string;
		if (char === '*') {
			let end = i;
			while (pattern[end + 1] === '*') end++;
			if (end > i) {
				if (pattern[end + 1] === '/') {
					tokens.push({ kind: 'dirs' });
					i = end + 1; // the `/` belongs to the token
				} else {
					tokens.push({ kind: 'deep' });
					i = end;
				}
			} else {
				tokens.push({ kind: 'star' });
			}
		} else if (char === '?') {
			tokens.push({ kind: 'one' });
		} else {
			tokens.push({ kind: 'lit', char });
		}
	}
	return tokens;
};

/** The patterns of a list: trimmed, without blank lines and comments. */
export const parsePatterns = (text: string | undefined): string[] =>
	(text ?? '')
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith('#'))
		.map((line) => line.toLowerCase())
		.filter((line) => line.length <= MAX_PATTERN_LENGTH);

const compile = (pattern: string): Token[] | undefined => {
	let body = pattern;
	while (body.length > 1 && body.endsWith('/')) body = body.slice(0, -1);
	const anchored = body.includes('/');
	if (body.startsWith('/')) body = body.slice(1);
	if (!body) return undefined;
	const tokens = tokenize(body);
	// Without a `/` the name may be anywhere in the tree.
	return anchored ? tokens : [{ kind: 'dirs' }, ...tokens];
};

const isSkippable = (token: Token | undefined) =>
	token !== undefined &&
	(token.kind === 'star' || token.kind === 'deep' || token.kind === 'dirs');

/** True when the pattern matches the path, or a folder above it (every folder covers what is inside). */
const matches = (tokens: Token[], path: string): boolean => {
	const end = tokens.length;
	/** Adds what can be reached without reading a character: a wildcard may match nothing. */
	const close = (states: Set<number>, from: Iterable<number>) => {
		for (const start of from) {
			let state = start;
			while (isSkippable(tokens[state])) {
				state++;
				states.add(state);
			}
		}
		return states;
	};
	let states = close(new Set([0]), [0]);
	for (let pos = 0; pos <= path.length; pos++) {
		// A match that ends here covers the path when the next character starts a new name.
		if (states.has(end) && (pos === path.length || path[pos] === '/')) return true;
		if (pos === path.length) break;
		const char = path[pos] as string;
		const next = new Set<number>();
		/** States just entered by reading a character (a following wildcard may match nothing). */
		const entered: number[] = [];
		for (const state of states) {
			const token = tokens[state];
			if (!token) continue;
			if (token.kind === 'lit') {
				if (token.char === char) entered.push(state + 1);
			} else if (token.kind === 'one') {
				if (char !== '/') entered.push(state + 1);
			} else if (token.kind === 'star') {
				if (char !== '/') entered.push(state);
			} else if (token.kind === 'deep') {
				entered.push(state);
			} else {
				// `**/`: it has not matched anything yet unless the slash is read
				next.add(state);
				if (char === '/') entered.push(state + 1);
			}
		}
		entered.forEach((state) => next.add(state));
		if (!next.size) return false;
		states = close(next, entered);
	}
	return false;
};

export type IgnoreMatcher = (path: string) => boolean;

const compileList = (text: string | undefined): IgnoreMatcher => {
	const compiled = parsePatterns(text)
		.map(compile)
		.filter((tokens): tokens is Token[] => !!tokens);
	if (!compiled.length) return () => false;
	return (path) => {
		const lower = path.toLowerCase();
		return compiled.some((tokens) => matches(tokens, lower));
	};
};

let lastText: string | undefined;
let lastMatcher: IgnoreMatcher = () => false;

/** A matcher for a list; the last one is remembered, so repeated calls with the same text are cheap. */
export const ignoreMatcher = (text: string | undefined): IgnoreMatcher => {
	const key = text ?? '';
	if (key !== lastText) {
		lastMatcher = compileList(key);
		lastText = key;
	}
	return lastMatcher;
};

/** Is this path on the user's ignore list (on this device)? */
export const isIgnored = (t: ObsidianGoogleDrive, path: string): boolean =>
	ignoreMatcher(t.settings.ignorePatterns)(path);

/** Does sync look at this path at all: not in a switched-off settings category, not on the ignore list. */
export const isSyncedPath = (t: ObsidianGoogleDrive, path: string): boolean =>
	isConfigPathSynced(t, path) && !isIgnored(t, path);

/**
 * Forgets pending marks of ignored paths. Returns how many were dropped. The files are not touched,
 * neither here nor on Drive.
 */
export const dropIgnoredMarks = (t: ObsidianGoogleDrive): number => {
	const matcher = ignoreMatcher(t.settings.ignorePatterns);
	let dropped = 0;
	for (const path of Object.keys(t.settings.operations)) {
		if (!matcher(path)) continue;
		delete t.settings.operations[path];
		dropped++;
	}
	return dropped;
};

/** How many files in the vault the list matches (for the settings page). */
export const countIgnoredFiles = (t: ObsidianGoogleDrive): number => {
	const matcher = ignoreMatcher(t.settings.ignorePatterns);
	return t.app.vault.getFiles().filter((file) => matcher(file.path)).length;
};
