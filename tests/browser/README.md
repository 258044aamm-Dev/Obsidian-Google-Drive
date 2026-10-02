# Browser check of the header icon

Runs the plugin's real `helpers/header-button.ts`, `helpers/badge.ts` and `styles.css` in headless Chromium, on a
phone-sized page (touch, Pixel 7 and a small 320 px phone) and a desktop-sized page, in a light and a dark theme.

```
npm i --no-save playwright && npx playwright install chromium
node tests/browser/run.mjs
```

Screenshots and `result.json` are written to `tests/browser/out/` (not committed).

What it checks: the icon is added once and is the first of the header icons, it is on screen, the number shows and
stays on the icon (also "99+"), its colours are readable, a tap opens the Push/Pull menu, the menu fits and its rows
are big enough, each row runs only its own action, the icon turns during a sync and the menu is greyed out, and the
switch removes the icon.

What it does NOT have: Obsidian. The note header, the theme colours and the menu are rough stand-ins, and
`obsidian-shim.ts` only provides what the two helpers use. Use `DEVICE-CHECKLIST.md` for the real thing.
Not run by `npm test`: it needs a browser download and is not part of the vitest suites.

On a machine without the system libraries Chromium needs (a bare container), install them first
(Debian: `apt-get install libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 libasound2t64 libxdamage1 libxkbcommon0`).
