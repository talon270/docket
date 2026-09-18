# Turso sync — plan

Written 2026-09-18, against `js/storage.js`, `js/schema.js`, `vendor/sync.js`
and `index.html` as of the current working tree (commit `2f8ea06` plus
uncommitted changes already in the tree).

Method: read `storage.js`, `schema.js`, `vendor/sync.js`, and the sync-related
wiring in `app.js`/`index.html` line by line. Two documentation lookups against
Turso's official docs and, separately, GitHub issues / community reports, to
settle whether a browser can call Turso directly at all.

Scope, decided with you before writing this: Turso is a **third sync target**,
additive to the existing folder sync — a JSON blob in one row, reusing
`reconcile()` as-is. Not a relational rewrite. The credential is **pasted by
you into a settings field and kept in this browser's `localStorage`**, never
committed to the repo or shipped in the bundle.

**Nothing below is implemented — this is the plan.**

---

## Part A — findings, ranked

### A1 · RESOLVED: a plain `fetch()` reaches Turso directly — no CDN needed

Superseded by running it, per Phase 4's "run it, don't reason about it" —
the CDN-exception question below never needed asking.

**What was run:** with a real free-tier database you created
(`test-talon270.aws-ap-south-1.turso.io`), three checks against the
documented Hrana-over-HTTP endpoint, `POST {url}/v2/pipeline`:

1. `curl` a real `SELECT 1` with `Origin: https://example.com` — `200 OK`,
   `access-control-allow-origin: *`.
2. `curl -X OPTIONS` with `Access-Control-Request-Method/Headers` (the
   preflight a browser sends for a JSON POST with an `Authorization` header)
   — `200 OK`, `access-control-allow-headers: authorization, content-type, ...`,
   `access-control-allow-origin: *`.
3. The same `SELECT 1` request from an actual Chromium tab (Playwright,
   `file://` origin) via plain `fetch()` — `200`, zero console errors, `{value:
   "1"}` back. Also proved `CREATE TABLE IF NOT EXISTS`, a parameterised
   `INSERT ... ON CONFLICT DO UPDATE`, and reading the row back — the full
   read/write shape `js/turso.js` needs — via `curl`, then cleaned the test
   row up.

**Conclusion:** Turso's HTTP endpoint sends a wildcard CORS header on both the
preflight and the real request. The `@libsql/client/web` question (CDN,
version, WebSocket-vs-HTTP transport — since resolved by a documentation
lookup as HTTP-based anyway) is moot: `js/turso.js` talks to
`{url}/v2/pipeline` with `fetch()` and the Hrana JSON wire format directly.
Zero new runtime dependency, no exception to `context.md`'s "no CDN" rule
needed, and it is less code than wiring up a client library. Docket's
`Database URL` field takes the `libsql://` host Turso shows you; `js/turso.js`
rewrites it to `https://` before calling `/v2/pipeline`.

### A2 · MODEL GAP (medium): the sync-status model is a single string, and there will be two independent remotes

`state.syncStatus` and `#sync-strip` currently assume one remote (the folder).
Turso is a second, independent remote — you can be connected to the folder,
to Turso, to both, or to neither, and each can independently be synced,
disconnected, or erroring. Cramming that into one label loses information
(e.g. "folder is fine, database token expired" needs to be visible, not
collapsed into a single word).

**Fix:** keep `#sync-strip` exactly as it is for the folder, and add a second,
independent status line for the database (`#db-strip`, same visual language,
own `data-status`). Do not unify them into one status enum — they are
genuinely orthogonal.

### A3 · DESIGN RISK (medium): two debounced writers can race

`vendor/sync.js`'s `save()` debounces at 400ms (Docket's override) before
writing to the folder. A second, independent Turso writer debouncing on the
same mutations means two in-flight writes per keystroke burst, to two
different stores, on two different timers. Not a correctness bug —
`reconcile()` is commutative and idempotent per item — but worth naming so it
isn't "discovered" as a mystery double-write during testing later.

**Fix:** give the Turso writer its own debounce (same 400ms, same call site as
the folder's `autosave()`), and let each remote fail independently without
touching the other's state — a Turso network error must never mark the folder
sync as broken, and vice versa.

### A4 · DESIGN RISK (medium): what happens when Turso is unreachable

Phone loses signal mid-edit, token gets revoked, free-tier quota is hit. The
guard from Phase 0: **never claim synced when it isn't, never lose a task**.
Same shape as the existing "disconnected" folder state — keep working on the
localStorage mirror, show a banner, retry on the next `watch()`-style trigger
(focus/visibility), never block typing on a failed network call.

**Fix:** mirror the existing `disconnected` / `no-folder` semantics in
`vendor/sync.js` — a Turso write failure sets a `db-disconnected` status and
schedules nothing more aggressive than the existing focus-based
`refresh()`/`watch()` pattern. No polling loop, no retry timer — consistent
with the "focus rather than a poll" reasoning already written into
`vendor/sync.js`.

### A5 · COSMETIC (low): `vendor/sync.js` is not touched

`vendor/sync.js` is explicitly file-system-shaped (`showDirectoryPicker`,
`FileSystemHandle`) and marked "vendored... do not edit here." Turso needs its
own small module, not a generalization of that file into a transport-agnostic
abstraction — that would be a Hub-wide change affecting every app that vendors
`sync.js`, which is out of scope for a Docket-only ask. Noted so it isn't
attempted as a "cleaner" alternative mid-build.

---

## Part B — the build

1. **Skeleton verification first, before any UI. Done — see A1.** Run against
   a real free-tier database (`test-talon270.aws-ap-south-1.turso.io`), not a
   throwaway page importing a client library: `curl` proved the CORS headers,
   an actual Chromium tab (Playwright) proved a plain `fetch()` completes a
   `SELECT 1` with zero console errors. That result is what turned step 2 from
   "wrap `@libsql/client/web`" into "call `/v2/pipeline` directly."

2. **`js/turso.js`** — new module, `window.Docket.TursoSync`, same shape as
   `vendor/sync.js`'s instance API where it overlaps (`init`, `save`, `flush`,
   `watch`, `refresh`, `forget`, `status`, `info`) but backed by a `fetch()`
   against `{url}/v2/pipeline` instead of File System Access. On first
   successful connect, runs
   `CREATE TABLE IF NOT EXISTS docket_doc (id INTEGER PRIMARY KEY CHECK (id=1), data TEXT NOT NULL, device_id TEXT, written_at TEXT)`
   — idempotent, safe to run on every connect. Reads/writes are a single row
   (`id=1`), same one-document shape as the file, so `reconcile()` in
   `storage.js` is reused unchanged.

3. **Credential entry** — a small modal (same visual pattern as the existing
   project modal), two fields: Database URL, Auth token. Save writes
   `{url, token}` to `localStorage["docket.turso.v1"]`; Disconnect clears it.
   Never written into `docket.json` or any exported file — a credential
   accidentally exported and shared would hand over the whole database.

4. **Wire into `storage.js`** — `autosave()` calls both the folder writer (if
   connected) and the Turso writer (if configured), independently. `init()`
   merges mirror → folder → Turso with `reconcile()`, three-way, same
   most-recent-`updatedAt`-wins rule already in place for two.

5. **UI** — second status line (`#db-strip`) per A2, a "Connect database" /
   "Disconnect" pair of buttons next to the existing folder banner, reusing
   `.banner` styling from `css/layout.css`.

6. **README** — new section documenting the Turso option, written the way
   Section 4 of every other README here is written: why there's no CDN
   import despite every Turso guide showing one, named and justified, not
   hidden.

---

## Out of scope

- **Relational modeling of tasks/projects as SQL rows.** You picked the blob
  option; normalizing into real tables is a different, larger project with
  its own migration story.
- **Generalizing `vendor/sync.js` into a transport-agnostic module** so Turso
  support could be reused by Helth/Stonks/etc. Real value, but a Hub-wide
  change with its own review, not bundled into a Docket-only ask.
- **A backend proxy to avoid client-side tokens.** You explicitly chose
  BYO-credential-in-localStorage over adding a server.
- **Automatic conflict UI for Turso** equivalent to the folder's
  `sync-conflict-*.json` detection. Turso has no filesystem-sync-tool concept
  of a conflict file — `reconcile()` already resolves concurrent writes by
  timestamp, which is the same guarantee the folder path relies on.
- **Retry/backoff beyond the existing focus-triggered `watch()` pattern.** No
  new polling timer, per A4.
