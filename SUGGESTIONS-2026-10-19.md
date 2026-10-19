# Docket — suggestions

Written 2026-10-19, against the working tree: commit `8f740ee` plus
uncommitted work. That includes the hairline empty-state figures another
session added this morning (`hairline-host.js`, `hairline-pegboard.js`, the
cache bump to `docket-shell-v14`).
Method: headless Chromium on `file://` and `http://`, light and dark, at 390,
1440 and 1920 px, with a click-through. An unreadable-mirror probe (seed
`docket.v1` with truncated JSON, open, check whether it survives). A
two-apps-one-origin service-worker test. `PLAN-audit.md` (24 Sep, 25
findings) was read so as not to repeat it. Its P1–P8 look shipped, going by
the commits since.

**Two fixes applied in this pass (A1, A2). Everything else is a suggestion
and is not implemented.** Backups: `js/storage.backup-20261019-043230.js`,
`js/app.backup-20261019-043230.js`,
`service-worker.backup-20261019-053918.js`.

## Result

Zero page errors and console errors on `file://` and `http://`, both themes,
all three widths. No sideways scroll at 390 px.

## Part A — findings, ranked

### A1 · BUG (high): an unreadable browser mirror is replaced by an empty board as the page loads — FIXED

The September audit covered a corrupt *folder file* (its A6). It did not cover
the browser's own copy. `loadMirror()` returned `null` on a parse or migrate
error, and `loadLocal()` then did `saveMirror(makeFile())` straight away. So
with no folder or database connected, the only copy of every task was
overwritten during boot, with no message.

| | `docket.v1` original kept after load | Message |
|---|---|---|
| Before | **no**, overwritten at load | none |
| After | yes, as `docket.v1.unreadable-<ms>` | alert banner at the top of the status rail naming the key |

**Fix (applied):** `loadMirror()` copies the raw text aside in its catch, once
per load, before `loadLocal()` can save. `Storage.unreadableKey()` exposes the
key, and `boot()` prepends a `.banner.alert` (text set with `textContent`).
That is 20 lines across `storage.js` and `app.js`. If a folder or database is
connected, it still merges in afterwards, as before.

### A2 · BUG (high): the service worker deleted every other app's offline cache — FIXED

On activate it deleted every cache except its own. Docket, vis, Study,
attendance-budget, epok, inkstone, filin and the rest all live on
`talon270.github.io`, which is one origin and so one CacheStorage. So every
Docket deploy wiped the other apps' offline copies, and theirs wiped
Docket's.

Reproduced on one local origin with a `no-store` server. Open `vis` (cache
`vis-shell-3`), then open Docket:

| | Caches after Docket activates | `vis` opened offline |
|---|---|---|
| Before | `docket-shell-v14` only | **504 "Offline, and this file was never cached."** |
| After | `vis-shell-3`, `docket-shell-v14` (a planted `docket-shell-stale-old` is still deleted) | opens |

**Fix (applied):** delete only names starting `docket-shell-`. That is one
line plus a comment. It ships under the `v14` bump already in the tree. If
`v14` was deployed before this change, bump to `v15` so installed copies pick
it up. The same fix went into 9 other apps' workers.

### A3 · DESIGN RISK (medium): the audit's P10 is still open — backup spacing resets on every reload

`Hub/shared/sync.js:152` keeps `lastBackupAt` in memory only. So the first
folder write after any reload always makes a backup, and ten quick reloads
can still fill all ten slots with one moment (the audit's A7, root cause).
Docket's own side was fixed by not writing on load unless the merge brought
something. The shared root fix (P10: "reloads within five minutes add no
backup") isn't in `shared/sync.js`. The vendored copies are identical to it
apart from their header. See `Hub/SUGGESTIONS-2026-10-19.md`.

## Out of scope

- Everything already in `PLAN-audit.md` that has since shipped.
- File System Access paths (Connect folder, Reconnect). Headless Chromium
  can't grant a directory picker, so these were not driven.

## Check log

- `tools/audit/checks.py`: 36 checks, 0 failed. Run by the test-runner agent
  on a snapshot of the folder taken at 05:51, after both fixes above
  (04:33 and 05:39).
