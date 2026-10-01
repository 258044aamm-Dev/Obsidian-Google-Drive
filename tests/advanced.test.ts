import { describe, expect, it } from 'vitest';
import { ADVANCED_SUMMARY, advancedSettingGroup, isAdvancedOpen, setAdvancedOpen } from '../helpers/advanced';

describe('the Advanced section', () => {
	it('is folded when nothing has been done yet (the default)', () => {
		expect(isAdvancedOpen()).toBe(false);
	});

	it('folded, it holds one card that says what is behind the arrow; unfolded, the given rows', () => {
		const rows = [{ name: 'A' }, { name: 'B' }];
		setAdvancedOpen(false);
		const folded = advancedSettingGroup(rows);
		expect(folded.heading).toBe('Advanced');
		expect(folded.items).toHaveLength(1);
		expect(folded.items![0]).toMatchObject({ name: 'Advanced settings', desc: ADVANCED_SUMMARY });
		expect(typeof (folded.items![0] as { render?: unknown }).render).toBe('function'); // the card is a button as a whole
		setAdvancedOpen(true);
		expect(advancedSettingGroup(rows).items).toEqual(rows);
		setAdvancedOpen(false);
	});
});
