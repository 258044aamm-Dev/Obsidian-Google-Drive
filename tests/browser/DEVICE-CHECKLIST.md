# Real-device checklist (phone and desktop)

The simulations (tests/sim and tests/browser) cannot show how Obsidian itself looks. Run this list once on a
real phone/tablet and once on a desktop after installing a new version. Tick each line or note what you saw.

Before you start: install the release, open Settings → Community plugins, make sure Google Drive Sync is on, and
have at least one note open. Make a test vault copy if you are unsure.

## Header icon (3.12.0 phone, 3.13.0 also desktop)
- [ ] A Drive icon (arrows up and down) shows in the note header, near the reading-view icon and the three dots.
      Note where it sits (left of the book icon? next to the dots?): ______________
- [ ] It shows on every note and on every open tab/pane, also after switching notes.
- [ ] Edit a note. After a moment a small number appears on the icon (1 per changed file).
- [ ] The number is readable (not cut off, not hidden under another icon) in your theme, light and dark.
- [ ] Tap/click the icon: a menu opens with **Push** and **Pull**, both always there.
- [ ] The menu fits on the screen and the rows are easy to hit with a finger.
- [ ] Choose **Push**: the Push window opens (same as the ribbon Push). Cancel it; the number stays.
- [ ] Choose **Pull**: a pull runs (same as the ribbon Pull).
- [ ] During a sync the icon turns and the number is hidden; the menu rows are greyed out.
- [ ] Settings → Advanced → "Show a Drive icon in the note header" off: the icon disappears at once. On: it returns.
- [ ] Phone only: with the on-screen keyboard open the icon is still reachable or hidden without any glitch.

## Counts
- [ ] Settings → Advanced → "Check Google Drive for waiting changes" on. Change a file on another device and push.
      Within 15 minutes (or after restarting Obsidian) the icon number goes up.
- [ ] After Pull the number goes down to 0 and disappears.

## Drive web page (use a test file!)
- [ ] Trash a note in the Drive web page, then Pull: the note is removed here.
- [ ] Restore it from the Drive Trash, then Pull: the note is back (3.13.1).
- [ ] Rename a file in the Drive web page, then Pull: nothing changes here, no errors.
- [ ] Upload a new file in the Drive web page into the vault folder, then Pull: it is not downloaded (expected).

## Phone only
- [ ] Lock the screen during a sync, unlock: Obsidian shows what happened (see the background notice).
- [ ] Airplane mode, tap Push: a clear message, nothing lost; turn it off, Push again: works.

Anything that does not match: write down the Obsidian version, the device, the theme, and send a screenshot.
