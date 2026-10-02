/**
 * Browser check of the header icon (3.12.0+) in real Chromium, on a phone-sized and a desktop-sized page.
 *
 *   npm i --no-save playwright && npx playwright install chromium
 *   node tests/browser/run.mjs            (screenshots go to tests/browser/out/)
 *
 * It runs the plugin's REAL helpers/header-button.ts, helpers/badge.ts and styles.css. What it does NOT
 * have is Obsidian itself: the note header, the theme colours and the menu are rough stand-ins (see
 * `pageCss` below). So it can show layout, touch and colour-contrast problems of our own parts, but it
 * cannot show how Obsidian's real header or themes look. Use tests/browser/DEVICE-CHECKLIST.md for that.
 */
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const out = path.join(here, 'out');
mkdirSync(out, { recursive: true });
const require = createRequire(import.meta.url);
const pw = require(require.resolve('playwright', { paths: [root, process.env.PLAYWRIGHT_DIR ?? root] }));

// 1. the plugin code, bundled for a page, with the `obsidian` module replaced by the small stand-in
const bundle = await build({
	entryPoints: [path.join(here, 'entry.ts')],
	bundle: true,
	write: false,
	format: 'iife',
	target: 'es2020',
	alias: { obsidian: path.join(here, 'obsidian-shim.ts') },
	logLevel: 'error',
});
const js = bundle.outputFiles[0].text;
const pluginCss = readFileSync(path.join(root, 'styles.css'), 'utf8');

// 2. a rough Obsidian: header, theme colours, menu. The numbers are guesses based on Obsidian's look.
const themes = {
	light: '--background-primary:#ffffff;--background-secondary:#f2f3f5;--text-normal:#222;--text-muted:#5c5c5c;--interactive-accent:#8a5cf5;--text-on-accent:#ffffff;--background-modifier-border:#dcdcdc;--background-modifier-hover:rgba(0,0,0,.08)',
	dark: '--background-primary:#1e1e1e;--background-secondary:#262626;--text-normal:#dadada;--text-muted:#a3a3a3;--interactive-accent:#7b6cd9;--text-on-accent:#ffffff;--background-modifier-border:#363636;--background-modifier-hover:rgba(255,255,255,.1)',
};
const pageCss = (theme) => `
:root{${themes[theme]};--size-4-1:4px}
@keyframes spin{to{transform:rotate(360deg)}}
body{margin:0;background:var(--background-primary);color:var(--text-normal);font:16px system-ui,sans-serif}
.view-header{display:flex;align-items:center;gap:8px;padding:6px 8px;border-bottom:1px solid var(--background-modifier-border)}
.view-header-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.view-actions{display:flex;align-items:center}
.clickable-icon{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:6px;color:var(--text-muted);cursor:pointer}
.clickable-icon:hover{background:var(--background-modifier-hover)}
.view-content{padding:16px;line-height:1.5}
.menu{position:fixed;z-index:100;background:var(--background-secondary);border:1px solid var(--background-modifier-border);border-radius:8px;padding:4px;box-shadow:0 4px 16px rgba(0,0,0,.4);min-width:200px;max-width:calc(100vw - 8px)}
.menu-item{padding:10px 12px;border-radius:4px}
.menu-item.is-disabled{opacity:.5}
${pluginCss}`;
const html = (theme) => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${pageCss(theme)}</style></head><body class="theme-${theme}">
<div class="view-header"><span class="clickable-icon">\u2039</span><div class="view-header-title">A note with a rather long title that has to be cut</div>
<div class="view-actions"><a class="clickable-icon view-action" data-builtin="reading" aria-label="Reading view">\ud83d\udcd6</a><a class="clickable-icon view-action" data-builtin="more" aria-label="More options">\u22ee</a></div></div>
<div class="view-content">Some note text.<br>More note text.</div><script>${js}</script></body></html>`;

// 3. the checks
const results = [];
const check = (name, ok, detail = '', warn = false) => {
	results.push({ name, ok, warn });
	console.log(`${ok ? 'PASS' : warn ? 'WARN' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
};
const lum = ([r, g, b]) => {
	const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
	return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a, b) => {
	const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
	return (x + 0.05) / (y + 0.05);
};
const rgb = (s) => s.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);

const browser = await pw.chromium.launch();
const setups = [
	{ label: 'phone', theme: 'light', ctx: { ...pw.devices['Pixel 7'] }, touch: true },
	{ label: 'phone', theme: 'dark', ctx: { ...pw.devices['Pixel 7'] }, touch: true },
	{ label: 'phone-small', theme: 'dark', ctx: { ...pw.devices['Pixel 7'], viewport: { width: 320, height: 640 } }, touch: true },
	{ label: 'desktop', theme: 'light', ctx: { viewport: { width: 1280, height: 800 } }, touch: false },
	{ label: 'desktop', theme: 'dark', ctx: { viewport: { width: 1280, height: 800 } }, touch: false },
];

for (const s of setups) {
	const tag = `${s.label}/${s.theme}`;
	console.log(`\n== ${tag} ==`);
	const context = await browser.newContext(s.ctx);
	const page = await context.newPage();
	const errors = [];
	page.on('pageerror', (e) => errors.push(String(e)));
	await page.setContent(html(s.theme));
	const shot = (n) => page.screenshot({ path: path.join(out, `${s.label}-${s.theme}-${n}.png`) });
	// The icon turns during a sync, and a moving element cannot be "tapped" by selector, so tap its middle.
	const act = async (selector) => {
		const b = await page.locator(selector).boundingBox();
		const x = b.x + b.width / 2;
		const y = b.y + b.height / 2;
		return s.touch ? page.touchscreen.tap(x, y) : page.mouse.click(x, y);
	};
	const sim = (fn) => page.evaluate(fn);

	await page.evaluate(() => window.startSim());
	const icon = page.locator('.ogd-header-action');
	check(`${tag}: the icon is in the header, once`, (await icon.count()) === 1);
	const order = await page.evaluate(() => [...document.querySelectorAll('.view-actions > *')].map((e) => e.getAttribute('data-icon') ?? e.getAttribute('data-builtin')));
	check(`${tag}: the three-dots button is still the last icon`, order.at(-1) === 'more', order.join(' | '));
	const box = await icon.boundingBox();
	const vp = page.viewportSize();
	check(`${tag}: the icon is fully on the screen`, !!box && box.x >= 0 && box.x + box.width <= vp.width && box.y >= 0);
	console.log(`      icon size ${box.width}x${box.height}px`);
	const nothing = await page.evaluate(() => { const b = document.querySelector('.ogd-badge'); return !b || getComputedStyle(b).display === 'none'; });
	check(`${tag}: no number when nothing is waiting`, nothing);
	await shot('1-nothing');

	// changes waiting
	await page.evaluate(() => { sim.t.settings.operations = { a: 1, b: 1, c: 1 }; sim.t.waitingOnDrive = 2; sim.header.update(); });
	const badge = page.locator('.ogd-header-action .ogd-badge');
	check(`${tag}: the number shows 5 (3 here + 2 on Drive)`, (await badge.textContent()) === '5' && (await badge.isVisible()));
	const bb = await badge.boundingBox();
	const ib = await icon.boundingBox();
	check(`${tag}: the badge stays on its icon`, bb.x >= ib.x - 2 && bb.x + bb.width <= ib.x + ib.width + 6 && bb.y >= ib.y - 6 && bb.y + bb.height <= ib.y + ib.height + 2, `badge ${bb.width}x${bb.height}`);
	const colors = await badge.evaluate((e) => { const c = getComputedStyle(e); return [c.color, c.backgroundColor]; });
	const cr = ratio(rgb(colors[0]), rgb(colors[1]));
	check(`${tag}: the number is readable (contrast ${cr.toFixed(1)}:1; 3 is the minimum for bold text, 4.5 is better)`, cr >= 3);
	if (cr < 4.5) check(`${tag}: ... and above 4.5:1 for small text`, false, `${cr.toFixed(2)}:1`, true);
	await shot('2-five');
	await page.evaluate(() => { sim.t.settings.operations = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [i, 1])); sim.header.update(); });
	const wide = await badge.boundingBox();
	check(`${tag}: "99+" fits (${wide.width}px wide)`, (await badge.textContent()) === '99+' && wide.width <= 30);
	await shot('3-99plus');
	await page.evaluate(() => { sim.t.settings.operations = { a: 1, b: 1, c: 1 }; sim.header.update(); });

	// tap: the menu with Push and Pull
	await act('.ogd-header-action');
	const rows = page.locator('.menu .menu-item');
	check(`${tag}: a tap opens a menu with Push and Pull`, (await rows.count()) === 2 && /^Push/.test(await rows.nth(0).textContent()) && /^Pull/.test(await rows.nth(1).textContent()));
	const mb = await page.locator('.menu').boundingBox();
	check(`${tag}: the menu fits on the screen`, mb.x >= 0 && mb.y >= 0 && mb.x + mb.width <= vp.width && mb.y + mb.height <= vp.height, `${Math.round(mb.width)}x${Math.round(mb.height)}`);
	const rowH = (await rows.nth(0).boundingBox()).height;
	check(`${tag}: the menu rows are easy to hit (${Math.round(rowH)}px high, needs 36)`, rowH >= 36);
	await shot('4-menu');
	await act('.menu .menu-item:nth-child(2)');
	check(`${tag}: choosing Pull runs Pull only, and closes the menu`, (await page.evaluate(() => JSON.stringify(sim.calls))) === '{"push":0,"pull":1}' && (await page.locator('.menu').count()) === 0);
	await act('.ogd-header-action');
	await act('.menu .menu-item:nth-child(1)');
	check(`${tag}: choosing Push runs Push`, (await page.evaluate(() => JSON.stringify(sim.calls))) === '{"push":1,"pull":1}');

	// during a sync
	await page.evaluate(() => sim.header.update(true));
	const spin = await icon.evaluate((e) => ({ cls: e.classList.contains('spin'), anim: getComputedStyle(e).animationName }));
	const hiddenBadge = await badge.evaluate((e) => getComputedStyle(e).display === 'none');
	check(`${tag}: during a sync the icon turns and the number is hidden`, spin.cls && spin.anim === 'spin' && hiddenBadge, `animation: ${spin.anim}`);
	await act('.ogd-header-action');
	check(`${tag}: during a sync both menu rows are greyed out and do nothing`, (await page.locator('.menu .menu-item.is-disabled').count()) === 2);
	await shot('5-busy-menu');
	await act('.menu .menu-item:nth-child(1)');
	check(`${tag}: ... a tap on a greyed row starts nothing`, (await page.evaluate(() => JSON.stringify(sim.calls))) === '{"push":1,"pull":1}');
	await page.evaluate(() => { document.querySelector('.menu')?.remove(); sim.header.update(false); });

	// switched off
	await page.evaluate(() => { sim.t.settings.headerButton = false; sim.header.update(); });
	check(`${tag}: switching it off removes the icon`, (await icon.count()) === 0);
	check(`${tag}: no script errors`, errors.length === 0, errors.join('; '));
	await context.close();
}
await browser.close();

const failed = results.filter((r) => !r.ok && !r.warn);
const warned = results.filter((r) => !r.ok && r.warn);
console.log(`\n${results.length - failed.length - warned.length} of ${results.length} checks passed, ${warned.length} warnings, ${failed.length} failed. Screenshots: ${out}`);
writeFileSync(path.join(out, 'result.json'), JSON.stringify(results, null, 1));
process.exit(failed.length ? 1 : 0);
