/** A tiny stand-in for a DOM element, enough for the floating button's tests. */
export class FakeEl {
	classes = new Set<string>();
	store = new Map<string, string>();
	style = {
		setProperty: (k: string, v: string) => this.store.set(k, v),
		removeProperty: (k: string) => this.store.delete(k),
	};
	attrs: Record<string, string> = {};
	textContent = '';
	children: FakeEl[] = [];
	removed = false;
	listeners: Record<string, ((e: unknown) => void)[]> = {};
	rect = { left: 0, top: 0, width: 80, height: 40 };
	constructor(public tag: string) {}
	classList = {
		add: (c: string) => this.classes.add(c),
		remove: (c: string) => this.classes.delete(c),
		toggle: (c: string, on?: boolean) => {
			const want = on ?? !this.classes.has(c);
			if (want) this.classes.add(c);
			else this.classes.delete(c);
			return want;
		},
	};
	setAttribute(k: string, v: string) {
		this.attrs[k] = v;
	}
	appendChild(c: FakeEl) {
		this.children.push(c);
	}
	private make(tag: string, o: { cls?: string | string[]; text?: string } = {}) {
		const el = new FakeEl(tag);
		[o.cls ?? []].flat().forEach((c) => el.classes.add(c));
		el.textContent = o.text ?? '';
		this.children.push(el);
		return el;
	}
	createDiv(o?: { cls?: string | string[]; text?: string }) {
		return this.make('div', o);
	}
	createSpan(o?: { cls?: string | string[]; text?: string }) {
		return this.make('span', o);
	}
	createEl(tag: string, o?: { cls?: string | string[]; text?: string }) {
		return this.make(tag, o);
	}
	/** An empty value takes the property away, as in the browser. */
	setCssProps(props: Record<string, string>) {
		for (const [k, v] of Object.entries(props)) {
			if (v === '') this.store.delete(k);
			else this.store.set(k, v);
		}
	}
	addEventListener(type: string, fn: (e: unknown) => void) {
		(this.listeners[type] ??= []).push(fn);
	}
	remove() {
		this.removed = true;
	}
	getBoundingClientRect() {
		return this.rect;
	}
	fire(type: string, e: unknown = {}) {
		(this.listeners[type] ?? []).forEach((fn) => fn(e));
	}
}
