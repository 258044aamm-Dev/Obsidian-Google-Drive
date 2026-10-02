/**
 * 3.10.0: the ignore list matcher. Every rule of the syntax, and the inputs that must never throw
 * or match everything by accident.
 */
import { describe, expect, it } from 'vitest';
import { ignoreMatcher, parsePatterns } from '../helpers/ignore';

const ignored = (list: string, path: string) => ignoreMatcher(list)(path);

describe('parsePatterns', () => {
	it('skips blank lines and comments, trims, lower-cases', () => {
		expect(parsePatterns('  Foo.md \n\n# note\r\n*.TMP\n   \n')).toEqual(['foo.md', '*.tmp']);
		expect(parsePatterns(undefined)).toEqual([]);
		expect(parsePatterns('')).toEqual([]);
	});
	it('drops an absurdly long pattern instead of failing', () => {
		expect(parsePatterns('a'.repeat(301))).toEqual([]);
	});
});

describe('names without a slash match at any depth', () => {
	it.each([
		['BRAT-log.md', 'BRAT-log.md', true],
		['BRAT-log.md', 'Notes/BRAT-log.md', true],
		['BRAT-log.md', 'Notes/Deep/er/BRAT-log.md', true],
		['BRAT-log.md', 'BRAT-log.md.bak', false],
		['BRAT-log.md', 'my-BRAT-log.md', false],
		['*.tmp', 'a.tmp', true],
		['*.tmp', 'x/y/a.tmp', true],
		['*.tmp', 'a.tmp.md', false],
		['draft?.md', 'draft1.md', true],
		['draft?.md', 'draft10.md', false],
		['draft?.md', 'a/draft2.md', true],
	])('%s vs %s', (list, path, expected) => {
		expect(ignored(list, path)).toBe(expected);
	});
});

describe('patterns with a slash start at the vault root', () => {
	it.each([
		['Daily/*.md', 'Daily/a.md', true],
		['Daily/*.md', 'Daily/sub/a.md', false],
		['Daily/*.md', 'Other/Daily/a.md', false],
		['/Inbox', 'Inbox/a.md', true],
		['/Inbox', 'Projects/Inbox/a.md', false],
		['Projects/Alpha', 'Projects/Alpha/notes/n1.md', true],
		['Projects/Alpha', 'Projects/Alphabet/x.md', false],
		['Projects/*/notes', 'Projects/Alpha/notes/n1.md', true],
		['Projects/*/notes', 'Projects/Alpha/x/notes/n1.md', false],
	])('%s vs %s', (list, path, expected) => {
		expect(ignored(list, path)).toBe(expected);
	});
});

describe('folders and **', () => {
	it.each([
		['Archive/', 'Archive', true],
		['Archive/', 'Archive/old.md', true],
		['Archive/', 'Archive/a/b/c.md', true],
		['Archive/', 'Notes/Archive/old.md', true], // no slash inside: any depth
		['/Archive/', 'Notes/Archive/old.md', false],
		['/Archive/', 'Archive/old.md', true],
		['Archive', 'Archives/old.md', false],
		['**/*.tmp', 'a.tmp', true],
		['**/*.tmp', 'x/y/a.tmp', true],
		['Journal/**', 'Journal/2026/09-01.md', true],
		['Journal/**', 'Journal', false],
		['Journal/**/x.md', 'Journal/x.md', true],
		['Journal/**/x.md', 'Journal/a/b/x.md', true],
		['Journal/**/x.md', 'Journal/a/b/y.md', false],
		['a**b', 'axxb', true],
		['a**b', 'ax/yb', true],
	])('%s vs %s', (list, path, expected) => {
		expect(ignored(list, path)).toBe(expected);
	});
});

describe('case, lists and odd input', () => {
	it('ignores upper and lower case', () => {
		expect(ignored('brat-LOG.md', 'Notes/BRAT-log.MD')).toBe(true);
	});
	it('matches when any line matches', () => {
		const list = '# logs\nBRAT-log.md\n\n*.tmp';
		expect(ignored(list, 'x/a.tmp')).toBe(true);
		expect(ignored(list, 'BRAT-log.md')).toBe(true);
		expect(ignored(list, 'keep.md')).toBe(false);
	});
	it('an empty list or only comments ignores nothing', () => {
		expect(ignored('', 'a.md')).toBe(false);
		expect(ignored('# only a note', 'a.md')).toBe(false);
		expect(ignored('/', 'a.md')).toBe(false);
	});
	it('special characters in a name are plain characters', () => {
		expect(ignored('a(b).md', 'a(b).md')).toBe(true);
		expect(ignored('a.b', 'axb')).toBe(false);
		expect(ignored('[x]+.md', '[x]+.md')).toBe(true);
	});
	it('many stars cannot make a match slow', () => {
		const list = '**a**a**a**a**a**a**a**a**a**a**a**a**a**b';
		const path = 'a'.repeat(800);
		const start = Date.now();
		expect(ignored(list, path)).toBe(false);
		expect(Date.now() - start).toBeLessThan(2000);
	});
	it('a leading text is remembered for the same list but a new list is used', () => {
		expect(ignored('a.md', 'a.md')).toBe(true);
		expect(ignored('b.md', 'a.md')).toBe(false);
		expect(ignored('a.md', 'a.md')).toBe(true);
	});
});
