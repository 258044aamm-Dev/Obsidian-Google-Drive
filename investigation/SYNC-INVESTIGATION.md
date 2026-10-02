# Google Drive Sync: why the phone doesn't follow the desktop, and how to design Pull / Push

*Investigated 2026-09-30. Code read: upstream `RichardX366/Obsidian-Google-Drive` @ `1922dd0` (3.1.1, what your phone runs) and your fork `258044aamm-Dev/Obsidian-Google-Drive` @ `493fb35` (3.1.2).*

---

## 1. TL;DR

1. **Drive, desktop and the plugin's logic disagree only on the phone side.** The desktop push is correct. The bug is in how the phone *interprets* Drive afterwards.
2. **Folders: a deterministic bug (reproduced).** When Drive says "folder X was deleted/moved away", the phone deletes the files inside but **keeps the folder, and marks it `create`**. `helpers/pull.ts:173-186`: the condition is inverted. The next push from the phone then **re-creates those folders on Drive**, and the desktop pulls them back. That's the "deleted and moved folders don't go away" symptom, and it is self-perpetuating.
3. **Files: fragile, and I could not reproduce your exact file symptom from code alone.** With an intact bookkeeping state, deleted/moved *files* propagate correctly (scenario S7). Several ways to lose that state are proven below. The most likely on a phone: **nothing pulled at all**, because the only automatic pull runs on a *cold start* of Obsidian, and mobile OSes usually resume a suspended app instead.
4. **Your fork makes the current situation worse if installed on the phone right now.** Its one-time "path migration" rebuilds the ID→path map from what's *currently* on Drive, which erases the only record of what was deleted. In simulation, the phone then keeps **all** deleted files and pushes them back to Drive (S1-first). **Do not install fork 3.1.2 on the phone until this is patched.**
5. **Recommendation:** replace "event journal + two time/token cursors" with a **state-based three-way reconcile** (Local vs Remote vs last-synced *Base* manifest), exposed as two explicit buttons with a preview step. Ship a small safety patch first so the fork is safe to install on the phone.

---

## 2. What I did (and how far to trust it)

- Read every sync path in upstream and diffed the fork. **The fork did not change the core detection/deletion logic**, only diagnostics, notices, logging, pagination encoding, parent-folder creation and the migration. So the root causes below exist in both.
- Built a **simulation harness** (`investigation/sim/`) that runs the **real** `main.ts`, `pull.ts`, `push.ts`, `drive.ts` against an in-memory fake Google Drive v3 (real query strings, changes feed, batch delete, multipart upload) and a fake Obsidian vault (events, trash, ENOENT on missing parents). Two devices share one Drive. Same scenarios ran on upstream 3.1.1 and the fork. Re-run with `investigation/run-all.sh`.
- Checked Google's docs for the API semantics the plugin relies on.

**Proven (simulation):** F1, F2, F4, F5, F6. **Proven by code reading:** F3, F7. **Not provable from here:** the actual contents of *your phone's* `data.json`, and what your phone showed when it opened. See §9 for how to find out.

**Assumptions baked into the simulation** (they could differ on a real device):
| Assumption | Basis | Sensitivity |
|---|---|---|
| Obsidian fires `delete`/`rename` for every descendant of a folder | Matches another fork's bug report ([HyosHi11 PR #1](https://github.com/HyosHi11/Obsidian-GDrive-Sync/pull/1)); I also ran it with `false` | Results identical both ways |
| Deleting a child in the same Drive batch as its parent folder returns 2xx | Your desktop push evidently succeeded. Strict 404 variant = S6 | Strict variant self-heals on retry |
| Vault events from `adapter.writeBinary` fire before it resolves | Plugin restores ops right after the write; if real events fire later, a race exists | Unknown; not relied on |
| Page tokens of the changes feed don't expire | Google: "The page token doesn't expire" ([1](https://developers.google.com/workspace/drive/api/reference/rest/v3/changes/getStartPageToken), [2](https://developers.google.com/workspace/drive/api/reference/rest/v3/changes/list)) | Token expiry is **ruled out** as a cause |

---

## 3. How the upstream plugin actually syncs

Everything hangs off three pieces of local state in `data.json` (`main.ts:20-46`):

| State | Meaning | Updated by |
|---|---|---|
| `operations: {path → create/modify/delete}` | Event journal of local changes since last push | Obsidian `create/modify/delete/rename` events; also **rewritten by every pull** |
| `driveIdToPath: {driveId → path}` | "What I believe exists on Drive" (only way to map a `removed` change to a path) | Push (on create), pull (only for files *modified since `lastSyncedAt`*) |
| `lastSyncedAt` (device clock) + `changesToken` (Drive feed cursor) | Two independent "how far have I read" cursors | `endSync()`, which stamps both *after* the work, using two separate calls (`main.ts:318-342`) |

**Pull** (`helpers/pull.ts`):
1. *New/changed on Drive* = `files.list` with `modifiedTime > lastSyncedAt` (line 34-39). **Device clock vs Drive-side time.**
2. *Deleted on Drive* = `changes.list` from `changesToken`, keeping `removed:true`, mapped to paths **through `driveIdToPath`** (line 101-121). An unknown id is silently ignored.
3. Before that, it *infers local intent* by comparing `driveIdToPath` with the vault (lines 50-99): path known to Drive but missing locally ⇒ mark `delete`; local path unknown to the map ⇒ mark `create`. **This inference is what turns any stale map into resurrections.**
4. Applies deletions (`deleteFilesMinimumOperations`), then downloads. Local `modify` ops win over Drive ("local priority").

**Push** (`helpers/push.ts`): runs a silent pull first, then permanently `DELETE`s Drive ids for `delete` ops, creates/updates the rest, then **uploads `data.json` itself** (line 517-523) *before* clearing `operations` (line 525).

**A move is delete + create.** Path is the identity; Drive objects carry `properties.path` (split into ≤100-byte chunks).

**Auto-triggers:** only `onLayoutReady` → one silent pull at app start (`main.ts:107`), and an optional auto-push timer. No resume hook, no interval.

---

## 4. Findings, ranked

### F1 (certain, upstream + fork). Deleted/moved folders are kept and re-marked `create`
`pull.ts:173-186`:
```ts
const deletedFolders = deletions.filter(f => f instanceof TFolder).filter(folder => {
  if (pathToId[folder.path]) return;
  if (folder.children.find(c => !deletionPaths.includes(c.path))) return true;   // has a child NOT being deleted → DELETE folder
  t.settings.operations[folder.path] = 'create';                                 // every child is being deleted → KEEP folder, re-upload it
  return;
});
```
The two branches are swapped relative to the evident intent (keep a folder that still holds local-only content; delete one whose whole content is going away). Effects reproduced in S1/S2/S3/S7-contrast:
- After the desktop cleanup, the phone ends with `Archive/`, `Projects/Beta/`, `Projects/Alpha/`, `Projects/Alpha/notes/` as empty shells, all flagged `create`.
- It never self-heals (S1 "after 2nd restart": unchanged).
- The next **phone push puts the ghost folders back on Drive**, and the **desktop pulls them back**. The cleanup is undone.
- A *files-only* cleanup is fine (S7). Only folder deletes/moves trigger it, which is exactly what you did.

### F2 (proven). The id→path map is mutated *before* deletions are applied, so a half-finished pull turns a deletion into a resurrection
`pull.ts:121` does `delete driveIdToPath[fileId]` while *planning*. If the pull then dies (file locked, network drop, **mobile OS kills the app**), the changes token has not advanced, but the map entry is gone. On retry the `removed` change maps to nothing (ignored) and the still-present local file is classified "unknown to Drive" ⇒ `create`.
S3b: `Inbox/a.md` (deleted on desktop) stays on the phone and is **re-uploaded to Drive** by the next phone push.

### F3 (code-proven, likely for your phone). No automatic pull when Obsidian is merely resumed
The only automatic pull is inside `onLayoutReady` (cold start). iOS/Android typically keep Obsidian suspended in memory, so "I opened Obsidian on my phone" often triggers **no sync at all**. The manual fallback is a command-palette entry (`Pull from Google Drive`), and the only UI affordance is one ribbon icon labelled *Push*. This is the plainest reason your phone can look stale, and exactly the gap two explicit buttons would close.

### F4 (proven + code). Two cursors on two different clocks
- New/changed files are found by `modifiedTime > lastSyncedAt` (phone clock vs timestamps stamped by the *desktop* at upload). S4: with the phone clock 60 s ahead, a file the desktop pushed shortly after never arrives, **silently and permanently** (nothing later re-selects it).
- `endSync` reads `Date.now()` first and fetches a *new* start token afterwards, not the `newStartPageToken` from the list it just consumed. Anything changed in that window is skipped forever by whichever cursor was not watching.
Real-world impact of skew is small on NTP-synced phones. The race is always present.

### F5 (proven). `data.json` is itself synced, including volatile state
Push uploads `JSON.stringify(t.settings)` *before* `operations = {}` (S0: the uploaded copy holds 16 stale pending ops, an empty `changesToken`, and **your `refreshToken`/client secret**). A second device that starts from that copy inherits someone else's pending ops:
- **S5b (data loss):** phone set up the README way ("download the Obsidian folder from Drive", which includes `data.json`). Desktop later edits a note and pushes. The phone sees the note as *locally modified* (inherited `modify` op), **skips downloading the desktop's version** ("local priority"), and its next push **uploads the old text over the desktop's edit** on Drive.
- Clean bootstrap (empty vault + plugin's own first pull) is fine (S0: 0 pending ops).

### F6 (proven, **fork only**). The 3.1.2 first-launch migration destroys deletion information
`checkAndMigrate()` (`main.ts:539`) runs before the startup pull whenever `lastInstalledVersion === ''`. That is **true for every device that was on upstream**. `runPathMigration()` replaces `driveIdToPath` with the map of what is on Drive *now*. Files deleted on Drive are no longer in it, so their `removed` changes are ignored and the stale local copies become "new local files":
S1-first: the phone keeps **every** deleted/moved file, flags them all `create`, and the next push **restores all of them on Drive and the desktop**. The same mechanism applies to the manual `Fix Google Drive paths` command (it also wipes `operations`), which upstream's README recommends.

### F7 (minor but real)
- `DEFAULT_SETTINGS` is copied shallowly (`Object.assign({}, DEFAULT_SETTINGS, …)`), so `operations`/`driveIdToPath` are shared objects when no `data.json` exists (harmless in one process, bites the settings-tab re-`onload()` path).
- `upsertFile` restores a stale `delete` op after downloading the file. Fixed only by the next pull.
- Push aborts on any non-2xx in a batch; if Drive answers 404 for a child whose folder was already deleted, the push stops half-way (S6; recovers on retry in simulation).
- Drive `md5Checksum` is never used, so "same content" is never recognised (forces overwrite-or-skip decisions).

### Why this matches your symptoms
| You saw | Explained by |
|---|---|
| Moved/deleted **folders** wrong on phone | F1 (certain) |
| Deleted/moved **files** not reflected | F3 (no pull ran), F2 (interrupted pull), F5 (inherited ops: phone "wins"), or state damage from earlier cycles of F1/F6. **Needs your phone's data to pin down (§9)** |
| Desktop later "gets stuff back" | F1 → push → desktop pull |

### Ruled out
- **Token expiry** (documented non-expiring).
- **Drive being wrong:** S0/S1 show Drive == desktop after the desktop push.
- **Fork's core logic differing from upstream:** only F6 is fork-specific.

---

## 5. Simulation results (identical scenarios on both code bases)

| # | Scenario | Upstream 3.1.1 (phone) | Fork 3.1.2 steady-state | Fork 3.1.2 first launch |
|---|---|---|---|---|
| S0 | Clean bootstrap via plugin's own first pull | ✅ identical, 0 ops | ✅ | ✅ |
| S1 | Desktop deletes files+folders, moves 2 folders → phone restart (auto pull) | ❌ 4 folder shells kept, flagged `create` | ❌ same | ❌❌ **all 10 deleted/moved paths kept** |
| S1→ | …then phone pushes a note | ❌ ghost folders resurrected on Drive **and desktop** | ❌ same | ❌❌ all deleted files resurrected |
| S2 | Manual *Pull from Google Drive* instead | ❌ same as S1 | ❌ same | n/a |
| S3 | Pull interrupted during download | ❌ same as S1 (deletes had run) | ❌ | n/a |
| S3b | Pull dies after planning, before local deletes | ❌ deleted file stays **and is re-uploaded** | ❌ | n/a |
| S4 | Phone clock +60 s | ❌ new desktop file never arrives | ❌ | n/a |
| S5 | Phone bootstrapped from Drive copy | ⚠️ 8 phantom `modify` ops, needless re-uploads, no dupes | ⚠️ | n/a |
| S5b | …then desktop edits a note, phone pushes | ❌ **desktop edit overwritten on Drive** | ❌ | n/a |
| S6 | Strict Drive 404 on child delete | ⚠️ push aborts, retry recovers | ⚠️ | n/a |
| S7 | Files-only cleanup (no folders) | ✅ identical | ✅ | n/a |

---

## 6. Requirements for the new Pull / Push (derived from the failures above)

1. **Stateless w.r.t. events and clocks.** Decide from *current* Local vs *current* Remote vs *Base*, never from "what events did I see" or "what time was it". (F2, F4)
2. **Idempotent and resumable.** Re-running after a crash finishes the job; Base is committed **per item after it succeeds**, never at plan time. (F2)
3. **Pull never uploads; Push never downloads.** Each button has one direction and says so. (F3, F1)
4. **Nothing is deleted or overwritten without a preview** and a mass-deletion guard; local deletions go to Obsidian's trash. (F5, F6)
5. **Conflicts keep both copies**, deterministically named, and are never re-conflicted. (F5b)
6. **Unknown provenance is never destructive:** a file with no Base record is *never* auto-deleted on either side. (F6)
7. **Volatile state stays local:** `operations`/tokens/id-map/secrets are not synced; incoming `data.json` from Drive is ignored. (F5)
8. **Folders are derived, not tracked:** create what's needed; remove a folder only when empty after deletions. (F1)
9. **Drive schema unchanged** (`properties.path`, `vault`, `config`, real folder parents), so a device still running upstream keeps working.

---

## 7. Options

| | A. Patch current design | B. **State-based 3-way reconcile + manual Pull/Push** | C. B + changes-feed fast path | D. "Mirror" only (Drive wins / phone wins) | E. Switch tool (Obsidian Sync, Git, Syncthing…) |
|---|---|---|---|---|---|
| Idea | Fix F1/F2/F5/F6 in place, add two commands | Full remote listing + local scan + Base manifest → plan → preview → apply | As B, but use `changes.list` to skip the full listing when nothing changed | Pull = make phone equal Drive; Push = make Drive equal phone | Leave this plugin |
| Data-loss risk | Medium: still depends on event journal and `lastSyncedAt` | **Low:** decisions from content/Base, conflicts preserved | Low (fallback to full listing on any doubt) | High if the phone has unpushed edits (mitigated by preview/backup) | Depends |
| Duplicates | Medium (create-by-path not idempotent) | **Low** (look up by path before create; detect dup paths) | Low | Low | n/a |
| Conflict handling | Local always wins (silent overwrite, F5b) | Explicit: keep both | Same as B | None | Tool-specific |
| Fixes *today's* stuck phone | Partly | **Yes** (Base can be seeded from old `driveIdToPath`) | Yes | Yes (blunt) | Yes (re-setup) |
| Works beside upstream on other devices | Yes | **Yes** (Drive schema unchanged) | Yes | Yes | No |
| Mobile cost | Low | Moderate: one paginated listing (~1 call per 1000 files) + local stat | Lower on quiet days | Moderate | n/a |
| Effort | Small | **Medium** | Medium-large | Small | none (not a fork edit) |
| Main downside | Root fragility remains | Bigger change, needs tests | More moving parts; changes feed is account-wide and has no paths | Unsafe as the only mode | Gives up your fork goal |

**Why not just A:** F1/F2/F5/F6 are all symptoms of the same design choice: *inferring intent from a journal and two cursors*. Patching each leaves the class intact; the next app kill or bootstrap re-creates it.
**Why D is still useful:** as an explicit, guarded **"Mirror from Drive"** option *inside* B (Base = ∅ with a forced-delete policy and a backup) for exactly the case you have today.
**Why C later, not now:** it's an optimisation; B's full listing is cheap for vault-sized data and strictly more robust.

---

## 8. Recommendation: B, delivered in phases

### Phase 0: make the fork safe to put on the phone (small; do first)
- **Neutralise the destructive migration (F6):** never replace `driveIdToPath`; at most *merge* (add missing ids, keep old ones), and only after a successful pull. Make `Fix Google Drive paths` non-destructive the same way.
- **Fix the inverted folder condition (F1)** and apply deletions with the map mutated only *after* success (F2).
- **Stop syncing `plugins/google-drive-sync/data.json`** in both directions; never upload secrets (F5).
- Add a **read-only "Sync doctor" command**: lists what differs between phone and Drive, plus `operations` / map size / tokens. No writes. This gives us *your phone's* ground truth without risk.
- Add the two **ribbon icons + commands + settings buttons**: *Pull from Google Drive*, *Push to Google Drive*, with startup auto-pull made optional (F3).

### Phase 1: the new engine behind the same two buttons
**Base manifest** (new local file `…/google-drive-sync/sync-base.json`, never synced): `path → {driveId, remoteMd5, remoteModified, localSize, localMtime}`. Seeded once from the legacy `driveIdToPath` (paths the device *did* sync) + content match; `operations` is ignored.

**Pull** = Drive → phone
1. List every Drive object of this vault (`id, mimeType, properties, modifiedTime, md5Checksum, size`), scan local files, load Base.
2. Classify per path:

| Remote vs Base | Local vs Base | Action |
|---|---|---|
| same | same | nothing |
| changed/new | unchanged/absent | download |
| deleted | unchanged | **delete locally (to trash)** |
| deleted | edited | keep, report "will be recreated on Push" |
| changed | edited | **conflict:** keep local, save Drive copy as `name (Drive 2026-09-30).md` |
| new, no Base | exists, same md5 | adopt (record Base) |
| new, no Base | exists, different | conflict as above |
| not on Drive, no Base | exists | **keep, list as "only on this device"** (never auto-delete) |
3. Folders: create needed ones; delete a folder only when empty after step 2.
4. **Preview** (counts + list, mass-delete guard) → Apply in dependency order; update Base per item.

**Push** = phone → Drive: mirror logic, but it **refuses any path whose Drive side changed since Base** ("Pull first"), creates only after looking the path up on Drive (no duplicates on retry), deletes on Drive only for paths that have a Base record *and* are gone locally *and* are unchanged remotely. Uses fresh ids from the listing, not a stale map.

**"Mirror from Drive" (guarded):** a Pull variant that also deletes "only on this device" files, behind a backup to `.trash` and a typed confirmation, for recovering a phone like yours today.

### Safety net (applies to both)
Preview + mass-delete threshold · local deletions to Obsidian trash · single sync lock with stale detection · per-item commit · existing diagnostics/log files reused · secrets excluded · on phone: chunked work, persistent progress notice, "keep Obsidian open" warning.

### Staying compatible with the upstream you run on the phone
- Keep the **same plugin id and Drive layout**; fork devices and upstream devices can coexist.
- Optionally mirror Base into `driveIdToPath` so you can **roll back to upstream** cleanly.
- Drive deletions stay **permanent `DELETE`** for now: an upstream device only learns of deletions through the `removed` flag, which `trashed:true` would not set. (Safer trash-based deletes become possible once every device runs the fork.)
- Install on the phone manually (or BRAT) and **turn off community-store auto-update** for this plugin so it doesn't overwrite the fork's `main.js`.

### Test plan
Promote `investigation/sim` to regression tests: every scenario in §5 must pass for the new engine, plus a randomized two-device test (random create/delete/move/edit, random kills mid-apply) asserting: *no resurrection, no duplicate paths, Pull leaves phone == Drive when nothing is pending, Push leaves Drive == phone, no silent overwrite.*

---

## 9. What to do with your phone today

**Don't (for now)**
- ❌ Install fork 3.1.2 on the phone (F6).
- ❌ Press **Push** on the phone (F1/F2 would put ghosts/old files back on Drive).
- ❌ Run **Fix Google Drive paths** (same mechanism as F6). **Reset local vault to Google Drive** is *not evaluated*; avoid until tested.

**Do**
1. **Copy the phone's vault folder somewhere safe** first.
2. Check whether the phone has **unsynced edits** you care about. If so, copy those files out.
3. Run **Pull from Google Drive** from the command palette and note the exact message: `You're up to date!` while files are stale ⇒ bookkeeping problem (F1/F2/F5 state); an error/`Sync failed` ⇒ network/auth.
4. If the phone has nothing unsynced, the cleanest reset is a **fresh empty vault with the same name**, enable the plugin, paste the refresh token, and let the plugin's *own* first pull populate it (S0 is clean). **Don't** seed it by copying the Drive folder (F5b).

---

## 10. Questions that change the plan

1. **How was the phone first set up?** Fresh pull, or the README "download the Obsidian folder" method? (Decides whether F5 applies.)
2. **Is the desktop also on upstream 3.1.1, or on your fork?** (Decides whether F6 already ran there.)
3. Do you need **automatic** pull/push at all, or is **manual-only** (no startup pull, no auto-push) what you want on the phone?
4. Is it acceptable that Pull's **first run** may list "only on this device" files for you to decide on, rather than deleting them automatically?

---

## Appendix: references

- Upstream (phone): `helpers/pull.ts` 34-39, 50-99, 101-121, 173-188; `helpers/push.ts` 517-525; `helpers/drive.ts` 416-480; `main.ts` 107-130, 142-146, 225-230, 318-345.
- Fork: `main.ts` 139-160, 514-565 (migration); `git diff upstream/master master -- helpers/pull.ts` shows no change to the deletion logic.
- Harness: `investigation/sim/*`, run with `investigation/run-all.sh`; separate vitest config so `npm test` is unaffected (still 100/100).
- Drive docs: [page tokens don't expire](https://developers.google.com/workspace/drive/api/reference/rest/v3/changes/getStartPageToken); [`files.delete` is permanent and recursive](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/delete).
- Corroboration: other users report "nothing gets pulled" ([Obsidian forum](https://forum.obsidian.md/t/google-drive-sync-plugin/92077)); another fork documents the same folder-deletion and per-descendant-event hazards ([HyosHi11 PR #1](https://github.com/HyosHi11/Obsidian-GDrive-Sync/pull/1)).
