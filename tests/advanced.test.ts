import { describe, expect, it } from 'vitest';
import { ADVANCED_SUMMARY, advancedSettingGroup, isAdvancedOpen, setAdvancedOpen } from '../helpers/advanced';

describe('the Advanced section', () => {
	it('is folded when nothing has been done yet (the default)', () => {
		expect(isAdvancedOpen()).toBe(false);
	});

	it('folded, it holds one line that says what is behind the arrow; unfolded, the given rows', () => {
		const rows = [{ name: 'A' }, { name: 'B' }];
		setAdvancedOpen(false);
		const folded = advancedSettingGroup(rows);
		expect(folded.heading).toBe('Advanced');
		expect(folded.items).toEqual([{ name: 'Advanced settings', desc: ADVANCED_SUMMARY }]);
		setAdvancedOpen(true);
		expect(advancedSettingGroup(rows).items).toEqual(rows);
		setAdvancedOpen(false);
	});
});
