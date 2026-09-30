import { describe, expect, it } from 'vitest';
import { describeGrantedScopes, parseScopes } from '../helpers/doctor';

const A = 'https://www.googleapis.com/auth/';

describe('Google permission check (pure part)', () => {
	it('splits the scope string Google answers with', () => {
		expect(parseScopes(`${A}drive.file openid`)).toEqual([`${A}drive.file`, 'openid']);
		expect(parseScopes('  ')).toBeNull();
		expect(parseScopes(undefined)).toBeNull();
		expect(parseScopes(42)).toBeNull();
	});

	it('drive.file alone is reported as the plugin\'s own files only, without a warning', () => {
		const r = describeGrantedScopes([`${A}drive.file`]);
		expect(r.line).toContain('drive.file');
		expect(r.line).toContain('only see and change Drive files it created');
		expect(r.warning).toBeUndefined();
	});

	it('harmless extras next to drive.file do not raise a warning', () => {
		expect(describeGrantedScopes([`${A}drive.file`, 'openid', `${A}userinfo.email`]).warning).toBeUndefined();
		expect(describeGrantedScopes([`${A}drive.file`, `${A}drive.appdata`]).warning).toBeUndefined();
	});

	it.each(['drive', 'drive.readonly', 'drive.metadata', 'drive.metadata.readonly', 'drive.photos.readonly'])(
		'warns when the token has %s',
		(scope) => {
			const r = describeGrantedScopes([`${A}drive.file`, `${A}${scope}`]);
			expect(r.warning).toContain('WHOLE Drive');
			expect(r.warning).toContain(scope);
			expect(r.warning).toContain('myaccount.google.com/connections');
		},
	);

	it('says so when the permissions could not be read, and when there is no Drive access at all', () => {
		expect(describeGrantedScopes(null).line).toContain('could not be checked');
		expect(describeGrantedScopes(null).warning).toBeUndefined();
		expect(describeGrantedScopes(['openid']).line).toContain('no Drive access');
	});
});
