# Implementation plan: permanent sync fix for the fork

> **Status (updated after execution):** P0 and P1 are implemented on branch `fix/manual-sync-safety` as release **3.2.0** (see the git log). P2–P8 (the state-based engine) are NOT started; they wait for on-device validation of 3.2.0.


*Plan only. No source files have been changed. Builds on `SYNC-INVESTIGATION.md` (findings F1–F7).*

**Decisions already made by you:** fix permanently in the fork · manual-only sync on every device · phone was set up by plugin's own first pull · both devices currently on upstream 3.1.1 · no unsynced phone edits.

**Goal:** two buttons, **Pull** (Drive → this device) and **Push** (this device → Drive), each deterministic, previewable, resumable, and unable to delete or overwrite anything it can't prove is safe.

---

## 1. Design in one page

### 1.1 Three states, one decision function
For every path, compare:
- **Local** (vault scan: size, mtime from `TFile.stat`, no I/O; content hash only when needed)
- **Remote** (one paginated Drive listing: `id, mimeType, properties, modifiedTime, md5Checksum, size`)
- **Base** (what this device last successfully synced: `path → {id, md5, size, localMtime, remoteModified}`), stored in a new **local-only** file `plugins/google-drive-sync/sync-base.json`, written atomically (write temp, then rename)

Per-path states: **Remote** = `absent | new | same | changed | deleted`, **Local** = `absent | new | same | changed | deleted` (relative to Base; "same" uses a size+mtime fast path, then MD5 when they differ). **Shortcut:** if local MD5 == remote MD5, the path is in sync, whatever the history (refresh Base, do nothing).

No event journal (`operations`), no `lastSyncedAt` comparison, no changes-feed cursor in the decision. That removes F2, F4, F5 by construction.

### 1.2 Pull (Drive → device). Never uploads.
| Remote | Local | Action |
|---|---|---|
| same | same | nothing |
| same | changed | keep (will go up on Push) |
| same | deleted | keep deleted (will go up on Push) |
| new | absent | download |
| new | new | MD5 equal → adopt, else **conflict** |
| changed | same | download (overwrite) |
| changed | changed | **conflict**: keep local, write Drive copy as `name (Drive YYYY-MM-DD).ext`, leave Base unchanged |
| changed | deleted | download (restore; remote edit wins over a local delete) |
| deleted | same | **delete locally (to Obsidian trash)** |
| deleted | changed | keep; report "deleted on Drive, Push will recreate" |
| deleted | deleted | drop Base entry |
| absent (never synced) | new | **keep, list as "only on this device"**; never auto-deleted |

**Folders** are derived, not tracked as events: create missing ones; remove a local folder only if Base knew it, Drive no longer has it, and it is **empty after the file actions**. (Fixes F1 properly.)

### 1.3 Push (device → Drive). Never downloads.
| Local | Remote | Action |
|---|---|---|
| same | same | nothing |
| changed | same | upload update |
| new | absent | create (look up by path first, so a retry can't duplicate) |
| new | new | MD5 equal → adopt, else **blocked (conflict)** |
| changed | changed | **blocked**: "Drive changed too, Pull first" |
| changed | deleted | create (recreate) |
| deleted | same | **delete on Drive** (only case that deletes remote; requires a Base record) |
| deleted | changed | blocked (Pull restores it) |
| same | changed/deleted/new | skip (Pull handles it) |

Drive folder delete is recursive, so a remote folder is deleted only if **every remote descendant is also in this plan's delete set or already gone**; otherwise skip and report. A 404 on delete counts as success (idempotent). Upload targets and parent-folder ids come from the fresh listing, not a stale map.

### 1.4 Extra modes
- **Mirror from Drive** (guarded, for recovery): Pull where "keep" rows become destructive (overwrite/delete-local), after a backup to the trash/backup folder and a typed confirmation.
- **Sync doctor** = the same plan computed but **never applied** (read-only report). Same code path as the preview, so it can't drift.

### 1.5 Safety rails
Preview before apply (counts + expandable lists) · mass-delete guard (default: more than 20 deletes or 25% of tracked files needs an extra explicit confirmation) · deletes go to Obsidian trash · per-item commit of Base (kill at any moment, re-run finishes the job) · per-item errors don't abort the batch, and failed items keep their old Base · in-memory sync mutex · retry with backoff on 403/429/5xx · progress notice plus "keep Obsidian open" · reuse existing diagnostics and log files.

### 1.6 Hard requirements that came out of the investigation
1. **Never sync this plugin's own folder** (`.obsidian/plugins/google-drive-sync/*`) in either direction. New catch: today `main.js` and `data.json` are synced as "config", so an upstream device could overwrite the fork's `main.js` with upstream's (and vice versa). Incoming `data.json` is ignored; secrets are never uploaded.
2. **Config files (`.obsidian/*`) are never deleted by sync**, on either side (upstream's push deletes Drive config files that are missing locally, which is dangerous for a phone missing desktop-only plugins).
3. **Drive schema unchanged** (`properties.path`/`path2…`, `vault`, `config`, real folder parents, root folder with `obsidian: vault`) so any device still on upstream keeps working.
4. **Rollback-friendly:** after every successful Pull/Push, mirror Base into legacy `driveIdToPath`, set `operations = {}`, and set `changesToken` from a token read **before** the listing. Reinstalling upstream 3.1.1 then just works.
5. **Drive deletes stay permanent `DELETE`** for now: upstream devices only learn of deletions via `removed`. Trash-based deletes are a follow-up once all devices run the fork.
6. **Manual-only:** no startup pull, no auto-push timer, no implicit pull inside Push. (`autoPush` field kept in data for compatibility, UI and timers removed.)

---

## 2. Code layout

Keep `helpers/` (avoids churn), add `helpers/sync/`. Pure logic is isolated so it is unit-testable without Obsidian.

```
helpers/sync/
  types.ts          Base/Remote/Local entries, Plan, PlanItem, reasons
  md5.ts            small pure-TS MD5 (WebCrypto has none); used only when size/mtime differ
  plan.ts           PURE: (base, remote, local, mode) -> Plan   <- tables in 1.2/1.3, most tests live here
  remote.ts         list+normalise Drive objects; detect duplicate paths (pick newest, report others)
  local.ts          vault scan from TFile.stat; lazy md5; config-dir policy (exclusions in 1.6)
  base.ts           load/save sync-base.json atomically; seed from legacy; mirror back to legacy fields
  apply-pull.ts     execute Pull plan, per-item commit
  apply-push.ts     execute Push plan, folder cascade guard, create-by-path
  guards.ts         mass-delete threshold, mutex, retry/backoff
  preview-modal.ts  grouped, scrollable, mobile-friendly; doubles as "doctor" (no Apply)
  legacy-compat.ts  mirror driveIdToPath/tokens; one-time seeding rules
main.ts             lifecycle only: ribbon icons, commands, settings tab (per AGENTS.md)
```
Commands keep stable ids (`pull`, `push`, `reset`, `fix-drive-path`) but are repointed: `reset` → Mirror from Drive; `fix-drive-path` → non-destructive "Rebuild sync state"; new `doctor`. Two ribbon icons (down/up arrows) and two big buttons in settings, so the phone doesn't depend on the command palette. Mobile "Quick action" can be pointed at Pull.

**Seeding Base on first run (upgrade from upstream):** for each legacy `driveIdToPath` path: local+remote and equal MD5 → Base entry. Known path, absent remotely, local present → Base = local MD5 (so it reads "deleted on Drive, local unchanged" and is removed) **unless** legacy `operations` flagged it, then treat as changed (kept). Anything ambiguous (content differs, no legacy record) becomes *conflict / only-on-this-device*, never a delete. Seeding happens **before** anything else runs and never replaces the legacy map.

---

## 3. Phased delivery (each step shippable and independently safe)

| # | Step | Size | Output / exit criterion |
|---|---|---|---|
| **P0** | Promote `investigation/sim` into a proper test project (`npm run test:sim`). Convert current failures to `it.fails(...)` so the red baseline is documented and flips green as fixes land | S | `npm test` still green; sim scenarios S1–S7 encoded |
| **P1** | **Safety shell, release 3.2.0** ("safe to install on phone"): neutralise migration + make `fix-drive-path` non-destructive (merge, never replace); exclude own plugin folder and `data.json`; stop uploading secrets; remove startup pull / auto-push timers; 2 ribbon icons + settings buttons calling the existing pull/push; one-line F1 fix and F2 ordering fix in legacy pull; read-only doctor v0 | M | Sims S1/S1-first/S3b pass; no ghost folders; installing on a stale phone deletes nothing; doctor reports drift |
| **P2** | `types`, `md5`, **`plan.ts`** with the truth tables + exhaustive/property unit tests | M | Every row of 1.2/1.3 covered; plan purity verified; random-input invariants hold |
| **P3** | `remote`, `local`, `base`, seeding, legacy mirror; doctor v1 uses the real plan | M | Doctor shows correct plan on real vault copies (read-only) |
| **P4** | **Pull** apply + preview modal + guards, behind setting `engine: 'v2'` (default off, flip after validation) | M | Sims S0–S7 green for Pull; kill-mid-apply test converges on re-run |
| **P5** | **Push** apply: create-by-path, cascade guard, idempotent deletes, blocked-conflict reporting | M | No duplicates under retry; no resurrection; S5b safe |
| **P6** | Conflict copies, Mirror from Drive (+backup, typed confirm), Rebuild state | S | Conflict copies are not re-conflicted; mirror reversible from backup |
| **P7** | Remove legacy engine (`operations` handlers, old pull/push/reset, auto-push), README rewrite, bump **4.0.0**, `versions.json` | S | Lint/build/tests green; README documents manual workflow and recovery |
| **P8** | Fuzz + on-device validation (section 5) | M | Soak passes; phone and desktop converge after scripted real-world cleanups |

P1 is deliberately small and mostly throw-away-free: doctor v0 and the buttons are reused by the final design, and only the one-line F1/F2 fixes are discarded in P7.

---

## 4. Testing strategy

- **Unit (pure):** `plan.ts` table tests (every row, both modes), MD5 against known vectors, path chunking (`path`/`path2…` ≤100 bytes, non-ASCII), duplicate-path handling.
- **Scenario sims (existing harness, expanded):** S0–S7 from the investigation, plus: nested folder moves, folder moved onto an existing path, file↔folder same-name swap, two devices editing the same note, Drive 404/5xx/429 injected at random points, app killed after *k*-th item, offline mid-apply.
- **Fuzz (P8):** random create/edit/delete/move sequences on two devices with random Pull/Push and random kills. Invariants checked after every step:
  1. Pull with nothing pending ⇒ device == Drive.
  2. Push with nothing blocked ⇒ Drive == device.
  3. No path exists twice on Drive.
  4. A deletion is never reverted by a sync of the *other* direction.
  5. No file content is silently overwritten (every divergence yields a conflict copy or a blocked item).
  6. Re-running any operation after a kill converges (idempotence).
- **Regression guard:** the sims run in CI alongside `npm test` and lint.

---

## 5. Real-world validation and rollout

**Spikes to settle early (simulator assumptions I couldn't verify):** (a) `md5Checksum`/`size` present for files uploaded by the plugin's multipart upload; (b) Drive batch semantics for child-after-parent deletes (plan already tolerates 404); (c) `adapter.stat`/`TFile.stat` mtime behavior on iOS/Android; (d) `fileManager.trashFile` behavior on mobile; (e) memory/time for a full listing on the phone; (f) behavior when the OS suspends Obsidian mid-apply. The doctor (read-only) gives most of these for free on real devices.

**Rollout order**
1. Back up desktop vault and phone vault; note current plugin version and `data.json` copy.
2. Install **3.2.0 (P1)** manually (or BRAT) on the **desktop** first; turn off store auto-update for this plugin; run doctor (expect "in sync").
3. Install on the **phone**; run doctor; confirm it lists exactly the stale deletions/moves and no surprises; run Pull, review the preview.
4. Use P1 for a while; move to **4.0.0** once P4–P8 pass; enable `engine: 'v2'` on desktop, then phone.
5. **Rollback:** reinstall upstream 3.1.1 `main.js`/`manifest.json`; legacy fields are kept consistent by design (1.6 #4).

---

## 6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Base corrupted/lost | Atomic write; "Rebuild sync state" reseeds safely; ambiguity never becomes a delete |
| Large vault on phone (memory/time) | One listing in pages of 1000, streaming classification, MD5 only for mismatches, chunked apply with per-item commit |
| iOS/Android suspends app mid-apply | Per-item commit + idempotent plan ⇒ re-run continues |
| User-visible churn from conflict copies | Deterministic name, never re-conflicted, listed in preview and log |
| Mixed fleet (upstream + fork) | Drive schema unchanged; own plugin folder excluded; upstream learns of deletes via `removed` (permanent DELETE kept) |
| Upstream later changes schema | Schema pinned by tests; fork is independently versioned |
| First run flags many "only on this device" items | Shown, never auto-deleted; Mirror option for deliberate cleanup |

**Out of scope for now:** changes-feed fast path, move/rename detection by MD5 (would avoid re-downloading moved folders), trash-based Drive deletes, shared drives, end-to-end encryption, a full three-way text merge.

---

## 7. Defaults I'll use unless you say otherwise
1. **Config sync** (`.obsidian` settings/themes/snippets/other plugins) stays **on** as today but never deletes, and never touches this plugin's own folder.
2. Conflict copy name: `Note (Drive 2026-09-30).md`.
3. Mass-delete guard: more than 20 deletes or 25% of tracked files.
4. `Reset local vault to Google Drive` becomes **Mirror from Drive** (same command id, safer behavior).
5. Versions: **3.2.0** = safety shell, **4.0.0** = new engine. Same plugin id (`google-drive-sync`) so data and Drive layout carry over.

## 8. What I need from you to start
Approval to begin **P0 → P1** (tests baseline + safety shell). Tell me if any default in section 7 should change, especially config sync.
