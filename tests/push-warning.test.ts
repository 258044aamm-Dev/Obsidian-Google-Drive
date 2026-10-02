import { describe, expect, it } from 'vitest';
import { massDeleteWarning } from '../helpers/push-warning';

type Op = 'create' | 'delete' | 'modify';
const ops = (n: number, op: Op = 'delete'): [string, Op][] =>
	Array.from({ length: n }, (_, i) => [`n${i}.md`, op]);

describe('massDeleteWarning', () => {
	it('stays quiet for ordinary pushes', () => {
		expect(massDeleteWarning([], 100, true)).toBeUndefined();
		expect(massDeleteWarning(ops(5, 'modify'), 100, true)).toBeUndefined();
		expect(massDeleteWarning(ops(3), 1000, true)).toBeUndefined();
		expect(massDeleteWarning(ops(20), 1000, true)).toBeUndefined(); // exactly 20 of 1000
	});
	it('warns above 20 deletions', () => {
		expect(massDeleteWarning(ops(21), 5000, true)).toContain('deletes 21 items');
	});
	it('warns above 25% of the tracked items, even for few files', () => {
		expect(massDeleteWarning(ops(3), 10, true)).toContain('30% of 10 items');
		expect(massDeleteWarning(ops(5), 20, true)).toBeUndefined(); // exactly 25%
	});
	it('counts only deletions', () => {
		expect([...ops(30, 'create'), ...ops(2)].length).toBe(32);
		expect(massDeleteWarning([...ops(30, 'create'), ...ops(2)], 1000, true)).toBeUndefined();
	});
	it('says what happens to the deleted items', () => {
		expect(massDeleteWarning(ops(30), 100, true)).toContain('Trash');
		expect(massDeleteWarning(ops(30), 100, false)).toContain('permanently');
	});
	it('works when nothing is tracked yet', () => {
		expect(massDeleteWarning(ops(25), 0, true)).toContain('deletes 25 items');
		expect(massDeleteWarning(ops(2), 0, true)).toBeUndefined();
	});
});
