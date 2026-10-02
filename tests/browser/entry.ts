/** Runs the plugin's real header-icon code in a page that looks (roughly) like an Obsidian note. */
import './obsidian-shim';
import { HeaderButton } from '../../helpers/header-button';

interface Sim {
	t: any;
	header: HeaderButton;
	calls: { push: number; pull: number };
}

const svgFor = (name: string) =>
	`<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon ${name}"><circle cx="12" cy="12" r="${name === 'more' ? 1.5 : 8}"/></svg>`;

/** Obsidian's header: our icon is added the way `ItemView.addAction` does it (in front of the built-in icons). */
const makeView = () => {
	const actions = document.querySelector('.view-actions') as HTMLElement;
	return {
		addAction(icon: string, title: string, cb: (e: MouseEvent) => void) {
			const el = document.createElement('a');
			el.className = 'clickable-icon view-action';
			el.setAttribute('aria-label', title);
			el.setAttribute('data-icon', icon);
			el.innerHTML = svgFor(icon);
			el.addEventListener('click', (e) => cb(e));
			actions.prepend(el);
			return el;
		},
	};
};

(window as any).startSim = (settings: Record<string, unknown> = {}): Sim => {
	const view = makeView();
	const t: any = {
		settings: { operations: {}, ...settings },
		waitingOnDrive: undefined,
		syncing: false,
		registerEvent: (x: unknown) => x,
		app: {
			workspace: {
				on: () => ({}),
				iterateAllLeaves: (cb: (leaf: unknown) => void) => cb({ view }),
			},
		},
	};
	const calls = { push: 0, pull: 0 };
	const header = new HeaderButton(t, { onPush: () => calls.push++, onPull: () => calls.pull++ });
	header.start();
	const sim = { t, header, calls };
	(window as any).sim = sim;
	return sim;
};
