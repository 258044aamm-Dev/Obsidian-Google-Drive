/**
 * Keeping a sync going on a phone: ask the system to keep the screen on while a sync runs, and say
 * so when the app was in the background during one. The plugin cannot stop the operating system
 * from pausing or closing the app; a sync that is cut short is safe to repeat (progress is saved
 * after each item).
 */
import { Platform } from 'obsidian';
import { withTimeout } from './net-retry';

interface WakeLockLike {
	release: () => Promise<void>;
}
type WakeLockNavigator = {
	wakeLock?: { request: (type: 'screen') => Promise<WakeLockLike> };
};

const states = new WeakMap<object, { wanted: boolean; lock?: WakeLockLike; hiddenAt?: number }>();
const stateOf = (t: object) => {
	let s = states.get(t);
	if (!s) {
		s = { wanted: false };
		states.set(t, s);
	}
	return s;
};

const request = async (t: object) => {
	const s = stateOf(t);
	try {
		const nav = navigator as unknown as WakeLockNavigator;
		if (!nav.wakeLock || s.lock) return;
		const lock = await withTimeout(nav.wakeLock.request('screen'), 3000);
		if (!s.wanted || s.lock) {
			// the sync ended while the request was on its way
			void lock.release().catch(() => undefined);
			return;
		}
		s.lock = lock;
	} catch {
		// not supported or refused: the sync works the same, the screen may just turn off
	}
};

/** A sync starts: keep the screen on (phones only, best effort). */
export const holdScreenAwake = (t: object) => {
	if (!Platform.isMobile) return;
	stateOf(t).wanted = true;
	void request(t);
};

/** The sync ended or failed. */
export const releaseScreen = (t: object) => {
	const s = states.get(t);
	if (!s) return;
	s.wanted = false;
	const lock = s.lock;
	s.lock = undefined;
	if (lock) void lock.release().catch(() => undefined);
};

export const KEEP_OPEN_NOTICE = 'Keep this screen open until the sync has finished.';

export const BACKGROUND_NOTICE =
	'The app was in the background while syncing. If the sync does not finish, press the button again: nothing is lost and nothing is uploaded twice.';

/**
 * The app went to the background or came back. Returns a message to show when it came back after
 * more than a few seconds away during a sync.
 */
export const onVisibilityChange = (
	t: object,
	visible: boolean,
	syncing: boolean,
	now = Date.now(),
): string | undefined => {
	const s = stateOf(t);
	if (!visible) {
		if (syncing) s.hiddenAt = now;
		return undefined;
	}
	const hiddenAt = s.hiddenAt;
	s.hiddenAt = undefined;
	if (!syncing || hiddenAt === undefined) return undefined;
	// the system releases the screen lock while the app is hidden
	if (s.wanted) {
		s.lock = undefined;
		void request(t);
	}
	return now - hiddenAt >= 5000 ? BACKGROUND_NOTICE : undefined;
};
