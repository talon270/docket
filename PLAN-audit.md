# Docket — audit and fix plan

Written 2026-09-24, against commit `ad09010`. The working tree differs from it
only in file-mode bits (N1), and `origin/main` is the same commit.

Method: a line-level read of every file that ships (`index.html`, `js/*.js`,
`vendor/sync.js`, `css/*.css`, `service-worker.js`, `manifest.webmanifest`,
`404.html`), plus the README and the three existing plans. Every suspected
defect was then reproduced headlessly with Playwright 1.63 and Chromium,
against the real files served from `127.0.0.1` (a secure context, like GitHub
Pages), using real clicks, keys and drags rather than `evaluate`:

- a fake Turso endpoint that speaks the subset of the Hrana pipeline
  `js/turso.js` uses, so two browser contexts behave like two devices on one
  database;
- `showDirectoryPicker` backed by the Origin Private File System, so
  `vendor/sync.js` ran its real read, write, backup and prune code against a
  real `FileSystemDirectoryHandle`;
- on-disk profiles for every folder check (Chromium's incognito contexts crash
  the browser on navigation once a page has used file-handle permissions — a
  harness problem, not a Docket one);
- a fake clock for the ten-minute sweep.

Every number in Part A is a measured output. Where a result depends on
something headless Chromium can't reproduce, the sentence making the claim says
so. Not checked at all: the live site (github.io was unreachable from this
machine over both IPv4 and IPv6), a real phone, real Syncthing, and the native
folder picker.

**Nothing below is implemented — this is the plan.**

---

## Part A — findings, ranked

| # | Label | Claim |
|---|---|---|
| A1 | BUG (high) | Connecting a folder overwrites the `docket.json` already in it |
| A2 | BUG (high) | A double quote in a title cuts it off the first time you press Save |
| A3 | BUG (high) | Two open tabs delete each other's tasks |
| A4 | BUG (medium) | A drag on one device erases an edit made on another |
| A5 | BUG (medium) | Deleted tasks and projects come back |
| A6 | BUG (medium) | A corrupt file is overwritten by the first edit, while the strip says it isn't |
| A7 | BUG (medium) | The ten rolling backups collapse to one moment |
| A8 | BUG (medium) | Profiles connected before `0eedfaa` write no backups, silently |
| A9 | BUG (medium) | One edit after "Folder disconnected" hides the red banner |
| A10 | BUG (medium) | Import, the folder and the database are all trusted input |
| A11 | BUG (medium) | With a database configured, the board and quick-add wait on the network |
| A12 | BUG (medium) | Reminders fire at the wrong time, or for finished tasks |
| A13 | BUG (medium) | Re-entering database credentials skips the check and says "Connected" |
| A14 | BUG (medium) | Restore puts the task straight back in the archive |
| A15 | BUG (medium) | Completing a repeating task twice spawns two next occurrences |
| A16 | BUG (medium) | The task panel doesn't take focus, so keys act on the board behind it |
| A17 | INCONSISTENCY (medium) | Offline, the typefaces are gone — they are the one third-party request |
| A18 | INCONSISTENCY (medium) | Folder buttons fail silently, and a phone shows two that can never work |
| A19 | DESIGN RISK (medium) | Closing the task panel any way but Save discards what you typed |
| A20 | DESIGN RISK (medium) | Project delete can't be undone, and blanks the board if you were filtered to it |
| A21 | DESIGN RISK (medium) | The service worker can install the previous deploy |
| A22 | INCONSISTENCY (low) | Manual order leaks across columns and through filters |
| A23 | DESIGN RISK (low) | On a phone, the first card starts 70% of the way down the screen |
| A24 | MODEL GAP (low) | Repeats anchor on the last occurrence, not the series |
| A25 | MODEL GAP (low) | "Busiest week" measures when the sweep ran, not when work finished |

Seven cosmetic and seven noise items follow as tables.

### A1 · BUG (high): connecting a folder overwrites the `docket.json` already in it

`wireReconnect()` (`js/app.js:1247-1266`) handles **Use existing folder** and
**Set up folder** the same way: `await Storage.connectExistingFile()` (or
`createNewFile()`), then `Storage.autosave(state.data)`. `sync.connect()` only
acquires handles, so nothing reads the file before the debounced `writeNow()`
replaces it with this browser's board. **Set up folder** on a folder that
already has a `docket.json` does the same, because
`getFileHandle(…, { create: true })` returns the existing file.

Measured: an existing `docket.json` holding 5 tasks, a fresh profile, one click
on **Use existing folder**. The real picker hands focus back to the window when
it closes, which can trigger a focus-refresh, so it ran three ways:

| Focus event after the picker | File after 1.5 s | Board shows | Strip |
|---|---|---|---|
| none | 0 tasks | 0 cards | Synced to folder |
| at +0 ms, before the handles exist | 0 tasks | 0 cards | Synced to folder |
| at +100 ms, refresh wins the race | 0 tasks | 5 cards | Updated from another device |

Even the lucky ordering writes the empty board to disk: the pending save
captured the pre-merge `state.data` object. This is the new-laptop and
second-machine flow the folder feature exists for; on a new laptop the file is
the only copy, and A7 means the last good backup is pushed out within ten page
loads.

**Reconnect has the same gap.** `requestReconnect()` restores permission and
never reads. A task another machine added while this one was disconnected was
missing from the board after Reconnect, and the first edit erased it from the
file (file afterwards: `A, C` — `B` gone). Headless Chromium fires no focus
event when the permission prompt closes; real Chrome may, which would merge
first. That half is unconfirmed.

**The database has it once too.** A device that boots while Turso is
unreachable never reads the row, and its first edit after the network returns
overwrites it. Measured: the row went from `[Shared task, Added on the phone]`
to `[Shared task, Laptop edit once the network is back]`, strip "Synced to
database". The phone still holds its task and puts it back on its next write,
so the loss is permanent only if that device's storage is gone.

**Fix:** an `adopt(current)` in `storage.js` that every connect path awaits
before its first write — `sync.readFile()` (already public), `reconcile()`,
`saveMirror()`, `sync.writeNow()`; a parse error sets A6's corrupt flag and
writes nothing. The two handlers and Reconnect replace
`Storage.autosave(state.data)` with `state.data = await Storage.adopt(state.data)`.
In `turso.js`, the first `writeNow()` of a session reads and reconciles the row
before writing, unless `init()` or `refresh()` already succeeded. Smallest
because the merge exists and runs at boot; only these paths skip it —
`connectDb()` already calls `mergeDb()` for exactly this reason.

### A2 · BUG (high): a double quote in a title cuts it off the first time you press Save

`escapeHtml()` (`js/app.js:703`) serialises a text node, which escapes `& < >`
but not `"`. Its output goes inside `value="…"` for the title (`:718`) and each
subtask (`:791`). Typed `Read "Dune" by Friday` into quick-add: the panel that
opens showed `Read `, and Save stored `Read`. Quick-add opens that panel on
every capture, so any title containing `"` is truncated the first time you set
its due date. A subtask `The 12" ruler` displays as `The 12` and is corrupted
only if that row is edited.

The same hole is attribute injection. A title of
`x" style="animation:fade-in 1s" onanimationstart="…` ran its handler on merely
opening the card (twice). Typed by you it is harmless; arriving through import,
the folder or the database (A10) it is code running with this origin's
`localStorage`, where the Turso token lives.

**Fix:** add `.replace(/"/g, "&quot;")` to `escapeHtml`'s return. Every
attribute already routes through this one function — the callers are right,
the function is wrong.

### A3 · BUG (high): two open tabs delete each other's tasks

Every `mutate()` writes the tab's whole in-memory board over
`localStorage['docket.v1']` (`js/storage.js:119`), and nothing listens for
another tab doing the same. Default mode — no folder, no database — with two
tabs open (the installed app plus a browser tab is enough): tab A captured
"Captured in tab A", tab B captured "Captured in tab B". Tab A still displayed
its task; a fresh load held only `Captured in tab B`. Once tab A closes, its
task exists nowhere. The folder and database paths partly heal this on a tab
switch (visibilitychange → refresh); local-only has no refresh at all.

**Fix:** a `storage` event listener for `docket.v1` that reconciles the new
value into `state.data` through the same apply callback `Storage.watch()` uses,
applying without saving so two tabs can't ping-pong. Native event, existing
merge, about six lines. Land it after A5, or a delete in one tab is undone by
the other.

### A4 · BUG (medium): a drag on one device erases an edit made on another

`reorderColumn()` (`js/app.js:1022-1025`) stamps `updatedAt` on every card in
the column, and `reconcile()` keeps whole tasks by newest `updatedAt`. Two
devices on one database: B added the note "Room 204, bring the TA's rubric" to
"Lab report", and it reached the database. A's tab never lost focus — laptop in
front of you, phone in hand — so it never refreshed; A dragged "Reading" above
"Essay". The database's note afterwards: `''`. B's own copy after its next
refresh: `''`. The edit is gone everywhere, from a card A never touched.
`deleteProject()` stamps every task in the project the same way (`:917`).

**Fix:** stamp `updatedAt` only on the moved card. The other cards' `order`
values ride along with whichever version wins — a cosmetic loss instead of a
content one. Ceiling: two devices editing the *same* card still lose one side;
see Out of scope.

### A5 · BUG (medium): deleted tasks and projects come back

`reconcile()` (`js/storage.js:43`) is a union of ids. A deletion is just an
absence, and any other copy fills it. Measured through the UI:

- **Two devices, one database.** A deleted Task X (database: `[Task Y]`). B
  refreshed and added Z, and its write carried X back (`[Task Y, Task X, Task Z]`).
  A regained focus: X was back on A's board, strip "Updated from another device".
- **One device, one folder.** Delete, then reload 100 ms later: the task is
  back — the mirror had the delete, the 400 ms-debounced file write never ran,
  and boot's merge restored it. Reloaded 800 ms later instead, it stays deleted.

Projects behave the same way. README's "every device pointed at the same
database merges into the same board" holds for adds and edits and fails for
deletes, and the Undo toast becomes decoration: another device undoes the
delete anyway.

**Fix:** a tombstone list, `data.deleted = [{ id, at }]`, in schema v4. Task
and project deletes push to it; `reconcile()` unions both lists and drops any
task or project whose tombstone is newer than its `updatedAt`; Undo removes the
tombstone and bumps `updatedAt`. Smaller than a `deletedAt` field on each task
because no renderer changes — tombstoned items never reach `state.data`.
Ceiling: the list only grows, about 60 bytes per delete. Pruning after N days
reopens resurrection for any device offline longer than N, so don't prune until
it matters.

### A6 · BUG (medium): a corrupt file is overwritten by the first edit, while the strip says it isn't

`init()` (`js/storage.js:146-153`) keeps the app on the mirror when the file
won't parse — "Writing over the file here would destroy the only evidence of
what went wrong." But the file handle is live and sync.js's own status is
`synced`, so `autosave()` → `sync.save()` writes on the first edit. Measured:
a truncated `docket.json` holding a task written by "the laptop", reload, strip
"File unreadable — using browser copy", one quick-add — the file was valid JSON
again and the laptop's task was gone from it. The strip still read "File
unreadable — using browser copy", because `setStatus("synced")` does nothing
when the status is already `synced`.

**Fix:** a `folderCorrupt` flag set by `init()` and checked in `autosave()`
(skip `sync.save` while set), cleared only when you reconnect through A1's
`adopt()`. One boolean at the only place that writes.

### A7 · BUG (medium): the ten rolling backups collapse to one moment

Two writers get past the five-minute spacing in `vendor/sync.js:338`:

- **Every page load writes and backs up.** `init()` calls `sync.writeNow()`
  whenever the folder is connected (`js/storage.js:167`), and `lastBackupAt`
  lives in memory, so it is 0 on every load. One edit, then 11 reloads over
  12 s: 10 backups kept, stamped 19:44:11 to 19:44:20 UTC, one distinct content.
- **The ten-minute sweep saves when nothing changed.**
  `setInterval(() => mutate(() => {}), …)` (`js/app.js:1416`) autosaves every
  time: a file write, a backup and a database write. An idle tab under a fake
  clock: after 110 minutes, 10 backups spanning 20:04 to 21:34, one distinct
  content.

The design promises "10 × 5min of history at worst, days of it in normal use".
Measured, it is ten page loads or 100 idle minutes. Combined with A1, that is
how an overwritten file becomes unrecoverable.

**Fix:** `sweepArchive()` returns how many tasks it archived, and the interval
autosaves only when that is non-zero (it still renders, so the date and
"Overdue" tags stay current); `init()` skips its `writeNow()` when the merged
data equals what was read. Both are Docket-side. The durable fix — seeding
`lastBackupAt` from the newest `backups/` filename — belongs in
`Hub/shared/sync.js`, not the vendored copy.

### A8 · BUG (medium): profiles connected before `0eedfaa` write no backups, silently

The pre-refactor `storage.js` saved a bare file handle under
`docket-handles` / `handles` / `"file"` — the key sync.js now restores. That
profile gets a file and no folder, and `writeBackup()` returns at
`if (!dirHandle)` forever. Seeded that exact IndexedDB shape: strip "Synced to
folder", 6 cards, 0 backups after an edit, `hasDirHandle()` false, and no
mention of backups anywhere on the page. sync.js's own comment calls this
"exactly how the dead-backup bug survived unnoticed"; `Storage.hasDirHandle()`
exists so the UI can say so, and nothing calls it. If you connected Docket in
August, this is probably your profile.

**Fix:** when `hasFileHandle() && !hasDirHandle()`, show the no-file banner as
"Backups are off — reconnect the folder" with the **Use existing folder** button,
which is safe once A1 lands. One condition in `renderSyncStrip()`.

### A9 · BUG (medium): one edit after "Folder disconnected" hides the red banner

`autosave()`'s else-branch (`js/storage.js:121`) reports `mirror-only` whenever
there is no file handle, including when there is one that merely lost
permission. On load after a browser restart: strip "Folder disconnected", red
Reconnect banner showing. After one quick-add: strip "Local only", red banner
gone. The file has stopped receiving writes and the only sign of it has
disappeared. PLAN-docket Phase 0 promised this banner would be persistent.

**Fix:** `else if (sync.status() !== "disconnected")` before reporting
`mirror-only`. sync.js already has the right status; `autosave()` overwrites it.

### A10 · BUG (medium): import, the folder and the database are all trusted input

`migrate()` (`js/schema.js:50`) fills missing fields but never checks a type,
and project colours, priority, dates and ids are interpolated into HTML without
escaping (`js/app.js:219-220, 431, 543-546, 610`). Measured:

- **A colour can carry markup.** An imported project whose `color` was
  `red"><img src=x onerror="…">` ran its script once on import and again on
  every plain reload after — persisted in the mirror, and it would ride the
  folder or the database to every device.
- **One wrong type bricks the board.** An imported task with
  `subtasks: null`: the toast said "IMPORT FAILED — Cannot read properties of
  null (reading 'filter')", yet the task had already been stored (mirror:
  `My own task, Hand-edited`). Every load since throws inside `render()`: the
  Done column never draws, and everything after `render()` in `boot()` — the
  sweep, the focus refresh, the service worker — never starts. It survives
  reloads; the only way out is editing `localStorage` by hand.

GitHub Pages serves every `talon270.github.io/*` project from one origin, so
any page there can read `docket.turso.v1`. README's "never sent anywhere but
that one database" is true of Docket's code, not of the origin; what else is
deployed there is unverified.

**Fix:** validate in `migrate()`, the one function the file, mirror, import and
database reads all pass through: strings for title and notes, an array for
subtasks, colour matching `^#[0-9a-f]{6}$` or the default, priority and status
inside their enums, dates `YYYY-MM-DD` and `HH:MM` or null, and drop any item
without a string id. With A2's escape, the injection and the crash each close
in one function.

### A11 · BUG (medium): with a database configured, the board and quick-add wait on the network

`boot()` awaits `Storage.init()` (`js/app.js:1396`) before wiring or rendering
anything, and `init()` awaits three sequential Turso requests (create table,
select, insert) with no timeout on `fetch()`. With 3 s of latency: 1.5 s in,
0 of 1 cards on screen, and Enter in quick-add did nothing — the title was
still sitting uncaptured in the box after the database answered. With a request
that never returns: 0 cards at 9.5 s, indefinitely. Phase 0 says it "never
blocks task capture". Campus Wi-Fi and mobile data are exactly this.

The same await is why a stored Light choice on a Dark system paints Dark first
(`wireTheme()` runs at `:1406`): one frame without a database, the whole
round-trip with one — Dark at 0.5, 1.0, 1.5 and 2.0 s, Light 0.8 s after the
database answered.

**Fix:** render and wire from the mirror first, then run the folder and
database merge and apply its result through the `watch()` apply callback,
reconciled against the live `state.data` so edits made meanwhile survive. Add
an `AbortController` timeout (8 s) in `pipeline()`. Move the two `docket.theme`
lines out of `boot()` so they run synchronously at script load.

### A12 · BUG (medium): reminders fire at the wrong time, or for finished tasks

| Case | Measured | Cause |
|---|---|---|
| Due time more than 24.8 days out | Due 2026-10-23 10:00: "DUE IN 30 MIN" and "DUE NOW" both fired within 0.5 s of Save, and again on the next load | `setTimeout` delays above 2³¹−1 ms overflow to roughly zero (`js/reminders.js:47, 54`) |
| Finished by key `3` or by drag | "DUE IN 30 MIN — Submit form" still fired for a Done task, both ways | only the panel's Save calls `Reminders.schedule`; `applyStatus()` never cancels |
| Next occurrence of a repeat | not armed until the next page load | same |
| Android Chrome | **unconfirmed here** — Chrome's documented behaviour is that `new Notification()` throws "Illegal constructor" and only `registration.showNotification()` works | the banner still offers reminders on a phone |

README doesn't say reminders need a Docket tab open; `reminders.js` says so in
its header.

**Fix:** call `Reminders.rescheduleAll()` from `mutate()` — the one choke point
— and from the ten-minute interval, with `rescheduleAll()` clearing every timer
first; skip delays above 2³¹−1, which the interval re-arms once they come into
range; fire through `navigator.serviceWorker.ready.then((r) => r.showNotification(…))`,
which works on desktop and Android with the worker already registered. One
README sentence.

### A13 · BUG (medium): re-entering database credentials skips the check and says "Connected"

`ensured` (`js/turso.js:67`) belongs to the instance, and `connect()` never
resets it. After the first successful connect, `ensureTable()` returns without
a request, so `connect()` saves whatever was typed. Measured, a second connect
with a one-letter typo in the token: toast "Connected to database", modal
closed, strip "Database disconnected", stored token now the typo, and the only
request a 401. Switching to a fresh database in the same session: no create
table ever sent, 0 rows written, strip "Database disconnected". The realistic
trigger is rotating an expired token.

A URL typed without `libsql://` (`my-db-org.turso.io`) is fetched relative to
the page. The POST, bearer token included, went to
`<docket origin>/my-db-org.turso.io/v2/pipeline` — on the live site, to GitHub.

**Fix:** `ensured = false` at the top of `connect()`; in `submitDbConnect()`,
show the inline error instead of the toast when
`Storage.dbInfo().status !== "synced"`; reject a URL that doesn't start
`libsql://` or `https://` inline, before any request.

### A14 · BUG (medium): Restore puts the task straight back in the archive

The Restore handler (`js/app.js:348-354`) clears `archivedAt` inside `mutate()`,
and `mutate()` runs `sweepArchive()` next — which sees a done task with a
`doneAt` over seven days old and archives it again in the same call. Measured:
1 archive row before Restore, 1 after, 0 cards on the board, `archivedAt` moved
to now. It only ever works for imported tasks that have no `doneAt`.

**Fix:** Restore also sets `doneAt = nowIso()`, which gives the task seven more
days in Done. The cost: that task's time-to-done in the rail then runs to the
restore, not the original finish.

### A15 · BUG (medium): completing a repeating task twice spawns two next occurrences

`applyStatus()` (`js/app.js:186`) spawns the next occurrence on every move into
Done, with no record that it already did. "Water plants", keys `3`, `2`, `3`:
two open copies, both due 2026-09-25. A stray `3` with the panel open, then
Save, does the same (A16).

**Fix:** clear `t.recurrence` on the instance that just spawned — the new
occurrence carries the series. One line; un-completing and re-completing then
spawns nothing.

### A16 · BUG (medium): the task panel doesn't take focus, so keys act on the board behind it

`openCardModal()` shows the dialog (`js/app.js:901`) without moving focus, so
the card you clicked keeps it. With the panel open, `3` moved that card to Done
underneath; Save then moved it back to To do — and for a repeating task left
the spawned copy behind. After quick-add Enter, focus stays in the quick-add
bar, and reaching the panel's first field takes one Tab per card plus one (7
with 6 cards). `N` still fires behind the panel too. Escape closes the task and
project panels but not the database one (`:969-972`); README says Esc closes
whatever's open.

**Fix:** focus `#f-title` when the panel opens and restore focus when it
closes; `wireCardKeys()` and the `N` handler return early while any
`.modal-overlay` is visible; add `closeDbModal()` to the Escape branch.

### A17 · INCONSISTENCY (medium): offline, the typefaces are gone — they are the one third-party request

`index.html:24-26` loads Archivo Black and JetBrains Mono from Google Fonts, and
the service worker doesn't cache them. The only non-local host a normal load
contacts is `fonts.googleapis.com`. On an offline reload the shell loaded from
the worker and Archivo Black did not — the wordmark, column names and counts
fall back to Arial, everything else to `ui-monospace`. It also contradicts the
house "no CDN" rule, and every open tells Google your IP address. The CSS is
served `private, max-age=86400`, so the HTTP cache may hide this for up to a
day after you were last online.

**Fix:** self-host both families as woff2 in `fonts/`, declare them with
`@font-face` in `theme.css`, add them to `SHELL`, delete the three `<link>`s,
and bump `CACHE`.

### A18 · INCONSISTENCY (medium): folder buttons fail silently, and a phone shows two that can never work

Both catch blocks in `wireReconnect()` log to the console and do nothing else.
Without File System Access (Firefox, Safari, every phone), **Use existing
folder** changed nothing visible; the console said "This browser has no File
System Access". A folder without a `docket.json` changed nothing visible either;
the console said `NotFoundError`. On a 390 px phone that banner is 101 px of
the first screen offering two dead buttons (A23).

**Fix:** when `!Sync.supported()` (it already exists), replace the two buttons
with "Folder sync needs desktop Chrome"; in the catch blocks, show the message
inline unless `err.name === "AbortError"`, which means you cancelled.

### A19 · DESIGN RISK (medium): closing the task panel any way but Save discards what you typed

Escape, a backdrop click and × all call `closeModal()`, which only hides the
panel. Typed a note and a due date, then closed it each of the three ways: note
empty, due date empty, no message, every time. Quick-add opens this panel on
every capture, so a reflexive Escape after setting a due date loses it. Nothing
else in the app means "cancel" — capture has already been committed by then.

**Fix:** every close path runs the Save handler, guarded on the task still
existing (Delete closes the panel after removing it).

### A20 · DESIGN RISK (medium): project delete can't be undone, and blanks the board if you were filtered to it

`deleteProject()` (`js/app.js:910`) strips the project from every task and
removes it: one click on a 9 px DEL, no undo. Task delete got an 8-second Undo
in PLAN-fixes A2 for exactly this reason. Measured: filtered to Ashoka with 3
tasks, DEL, close — 0 of 3 cards and no tab active, because `activeProjectId`
is reset after `mutate()` has already rendered (`:922`). The only visible
feedback was the stale "Project "Ashoka" added" toast. There is also no rename
or recolour (PLAN-docket B7 planned rename), so a typo in a project name can
only be fixed by delete-and-recreate — the irreversible step.

**Fix:** move the `activeProjectId` reset inside the `mutate()` callback;
stash the project and the ids of its tasks, and offer the same Undo toast.

### A21 · DESIGN RISK (medium): the service worker can install the previous deploy

`install` runs `c.addAll(SHELL)` (`service-worker.js:26`), which reads through
the HTTP cache. GitHub Pages sends `Cache-Control: max-age=600` — not measured
here, since github.io was unreachable — so a deploy within ten minutes of a
visit installs the new worker with the old files, and only the next `CACHE`
bump gets you out. Reproduced under a local server sending `max-age=600`: after
a "deploy" (`docket-shell-v9` → `v10`, `app.js` changed), v10 installed without
re-requesting `app.js`, and the page ran the old code. The same run with
`new Request(u, { cache: "reload" })` re-fetched it and ran the new code. You
would hit this checking your own deploy.

**Fix:** `c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" })))`.
Verified before and after, above.

### A22 · INCONSISTENCY (low): manual order leaks across columns and through filters

- **A moved card keeps its old column's order.** `applyStatus()` never clears
  `order`. In progress, auto-sorted, read `B high, A low`. After D was dragged
  above C in To do and C was moved with `2`, it read `C, A low, B high` — the
  column went manual and lost its priority sort.
- **A filtered drag lands in the wrong place.** `dropIndex()` counts only the
  visible cards; `reorderColumn()` splices that index into the full column.
  Filtered to Ashoka, dragging A below C left `A, C`. Unfiltered, the column
  was `X home, A ashoka, Y home, C ashoka`.

**Fix:** `t.order = null` in `applyStatus()` when the status changes — a drop
assigns order immediately after, so drags are unaffected; `dropIndex()` returns
the id of the card it lands before, and `reorderColumn()` inserts before that
id.

### A23 · DESIGN RISK (low): on a phone, the first card starts 70% of the way down the screen

At 390 × 844 with realistic data: header 235 px, project tabs 49 px, status
rail 179 px (folder banner 101, database banner 49), so quick-add starts at
y = 463 and the first card at y = 595. The search box sits at x = 396–417,
off-screen inside a project bar with 124 px of hidden overflow. The quick-add
placeholder is clipped mid-word, and the `N` keyboard hint shows on a touch
screen. At 1920 × 1080 nothing is stranded — the three columns fill the width.

**Fix:** under 860 px, put the view switch, data controls, theme and guide on
one row; A18 removes the folder banner on phones; move the search box out of
the scrolling tab row; hide `.quick-add-hint` under `(pointer: coarse)`.

### A24 · MODEL GAP (low): repeats anchor on the last occurrence, not the series

- **Monthly drifts.** From the 31st: 01-31 → 02-28 → 03-28 → 04-28. README
  describes only the first step; after one short month it stays on the 28th.
- **Late dailies stay late.** Due 2026-09-14, completed 2026-09-24: the next
  one is due 2026-09-15, already overdue. Catching up takes ten completions.

**Fix:** store the anchor day in the recurrence (`{ …, day: 31 }`) and clamp
from it. For daily and weekly, advancing until the next date is today or later
is a behaviour choice, not a bug fix — tell me which one you want; either is a
few lines.

### A25 · MODEL GAP (low): "Busiest week" measures when the sweep ran, not when work finished

`archiveStats()` buckets by `archivedAt` (`js/app.js:468`), which is when the
sweep happened to see the task — seven days after it was done, or whenever the
app was next opened. Six tasks finished across three different weeks, 15–30
days ago: "Busiest week — 2026 · WK 39: 6, across 1 week of archive". The rail
is headed Throughput; it should count finishes.

**Fix:** bucket by `doneAt`, falling back to `archivedAt`.

### COSMETIC (low)

| # | Claim | Measured | Fix |
|---|---|---|---|
| C1 | Clicking the word SUBTASKS ticks the first subtask; clicking COLOUR resets the colour to red | first subtask saved as done; `#2f81f7` → `#e61919` | a `<label>` wrapping several controls activates the first one; make both a `<div>` (`js/app.js:773`, `index.html:191`) |
| C2 | Card hover never lifts, and every render replays the entrance animation | hovered transform `matrix(1, 0, 0, 1, 0, 0)` while the shadow moved; one search keystroke restarted it on 3 of 3 cards | `animation: card-in … both` pins `transform: none`; use `backwards` (`css/layout.css:411`) |
| C3 | The board says Overdue, the agenda says Today | due today at 00:01: Overdue pill on the card, agenda group "Today" | `agendaBucket()` ignores `dueTime`; reuse `isOverdue()` |
| C4 | Dark mode's white-on-red text fails AA | 3.74:1 at 8.8–9.9 px on the alert banner, the HIGH pill and the error toast (the Overdue pill uses the same two colours); 4.65:1 in light. The search count is 4.11:1 in light | fill with `#E61919` in both themes (4.65:1) and keep `#FF2A2A` for red text on dark |
| C5 | The two status labels don't match | `#sync-strip` 9.6 px sentence case, `#db-strip` 14 px uppercase | `.db-strip { font: inherit }` overrides the strip size; set `font-size` and `text-transform` explicitly |
| C6 | The export filename is UTC | 01:30 IST on 24 Sep → `docket-export-2026-09-23-20-00-00.json` | stamp in local time, as `todayKey()` does |
| C7 | The notification banner appears before any due time exists | fresh profile, zero tasks: banner showing; README says it asks "the first time you use a due time" | show it only once a task has a `dueTime` |

### NOISE (low)

| # | Claim | Fix |
|---|---|---|
| N1 | `git status` lists 14 modified files with no content change — all `100644 → 100755`, flipped by the synced folder | `git config core.fileMode false` in this repo |
| N2 | `js/storage.backup-20260825-210155.js` and `.impeccable/hook.cache.json` are untracked and not ignored; one `git add .` publishes the backup to Pages | add both patterns to `.gitignore` |
| N3 | README says "Click **MODE**"; the button reads Dark or Light | README |
| N4 | `isoWeekLabel()` isn't ISO — it counts Sunday-start weeks: 2026-01-04 → WK 02 (ISO W01), 2027-01-01 → "2027 · WK 01" (ISO 2026-W53) | rename it, or make it ISO |
| N5 | The tour promises to leave the app as it found it; started on Archive, it ends on Board | remember the view in `start()` |
| N6 | PLAN-fixes B8 listed `Delete` on a focused card; it was never built (README correctly omits it) | build it, or strike it from that plan |
| N7 | `mergedFrom` from `init()` is never read, `r.from` is always null because `migrate()` drops `deviceId`, and `state.data` starts at `schemaVersion: 2` | delete |

---

## Part B — the build

Ordered so the schema bump lands once and every data-loss fix lands before
anything cosmetic. Each step ships on its own; rerun its Part A check before and
after.

1. **Schema v4, validation, escaping** — A2's `&quot;`, A10's type checks in
   `migrate()`, and the `deleted: []` default that step 3 needs. One bump,
   one migration.
2. **No write before a read** — A1's `adopt()` for Use existing folder, Set up
   folder and Reconnect; Turso's first write of a session reconciles first;
   A6's corrupt flag; A9's status branch.
3. **Deletes stay deleted** — A5's tombstones in `reconcile()`, task delete,
   project delete and Undo.
4. **Tabs** — A3's `storage` listener.
5. **Timestamps and order** — A4 stamps only the moved card; A22 clears
   `order` on a status change and inserts by id.
6. **Backups** — A7's change-only sweep save and skipped boot write; A8's
   banner. Then, separately, the `lastBackupAt` seed in `Hub/shared/sync.js`
   and `sh Hub/tools/sync-vendor.sh`.
7. **Boot and the database** — A11 renders first, adds the fetch timeout and
   applies the theme synchronously; A13's `ensured` reset, honest toast and URL
   check.
8. **Reminders** — A12.
9. **Archive and repeats** — A14's `doneAt`, A15's cleared recurrence, A25's
   bucket; A24 once you have picked the catch-up behaviour.
10. **Panel and projects** — A16's focus and key guards, A19's close-saves,
    A20's filter reset and Undo.
11. **Shell** — A21's `cache: "reload"`, A17's self-hosted fonts, `CACHE` to
    `docket-shell-v10`.
12. **Phone and cosmetics** — A18, A23, C1–C7.
13. **README and noise** — correct the claims these findings show are false
    today: the persistent disconnect banner (A9), backups spaced five minutes
    apart (A7, A8), Restore (A14), reminders needing an open tab (A12), "Esc
    closes whatever's open" (A16), MODE (N3), same-board-on-every-device for
    deletes (A5), the monthly clamp (A24), and the credential never leaving
    for anywhere but the database (A10, A13). Then N1–N7.

---

## Part C — who builds what

Split by subsystem rather than by severity, so each agent holds one part of the
code in its head and no two agents edit the same function. **Opus goes where a
wrong fix silently loses data; Sonnet where the fix is already specified and the
check is mechanical.** Effort tracks how much of a change is about interleavings
— timers, focus events, two devices — not how many lines it is.

| Package | Findings | Model | Effort | Why |
|---|---|---|---|---|
| P1 · Schema v4, trust boundary | A2, A10; v4 also adds `deleted: []` and `recurrence.day` for P3 and P6 | Opus | high | `migrate()` runs on every read of real data: too strict drops tasks on the next load, too loose leaves the injection open. It has to be proven against seeded v1, v2 and v3 files |
| P2 · No write before a read | A1, A6, A7 (Docket side), A8, A9, A18 | Opus | xhigh | The paths that destroyed data in Part A. Correctness depends on the order of focus events, debounced saves and the new `adopt()` — reasoning about interleavings is what xhigh buys |
| P3 · Deletes, tabs, project undo | A3, A5, A20 | Opus | high | Changes what `reconcile()` keeps; the cross-tab apply must not ping-pong between tabs; Undo has to retract a tombstone |
| P4 · Boot order, database connect | A11, A13 | Opus | high | Render-first with a background merge is a race: an edit made while the merge is in flight must survive it. A13 alone is Sonnet-low work and rides along because it lives in `turso.js` |
| P5 · Reminders | A12, C7 | Sonnet | high | The fixes are specified; high for the timing checks — the 2³¹ ms overflow, a 31-minute due time, the service-worker notification path |
| P6 · Board logic | A4, A14, A15, A22, A24 (anchor day only), A25, C3, N4 | Sonnet | medium | Eight small fixes in pure functions, each with a measured repro to reverse |
| P7 · Panel keys, focus, closing | A16, A19, C1 | Sonnet | high | Only real key presses show these bugs, and the surface is wide: quick-add's hand-off to the panel, the tour's capture-phase keys, three modals |
| P8 · Shell, offline, presentation | A17, A21, A23, C2, C4, C5 | Sonnet | medium | No JavaScript: a one-line service-worker fix, self-hosted fonts and CSS, checked by screenshot at 390 and 1920 px in both themes |
| P9 · Docs, cleanup, last regression | README corrections (Part B step 13), C6, N2, N3, N5, N6, N7, the single `CACHE` bump | Sonnet | high | Runs last. The README has to describe the fixed behaviour in your voice (Agents.md § How I sound), and every Part A check reruns once more |
| P10 · Hub backup spacing (optional) | A7's durable half | Sonnet | high | A small change in a module every syncing app vendors; high for checking each of those apps |

**Not delegated.** A24's catch-up behaviour waits on your decision. N1
(`git config core.fileMode false`) is a setting on your repo, so it's yours to
run.

| Package | Touches | Done when — the Part A measurement, reversed |
|---|---|---|
| P1 | `schema.js`, `escapeHtml()` | `Read "Dune" by Friday` survives Save; the colour and `subtasks: null` imports run no script and don't break a reload; seeded v1, v2 and v3 files load with every task |
| P2 | `storage.js`, `turso.js`; connect handlers, sync strip and sweep interval in `app.js` | the 5-task file still holds 5 after Use existing folder, in all three focus orderings; B survives Reconnect; the phone's task survives an offline boot; a corrupt file is byte-identical after an edit; the red banner outlasts an edit; 11 reloads add at most 1 backup and 110 idle minutes add none; a file-only profile sees the backups banner; a browser without folder access says why instead of doing nothing |
| P3 | `reconcile()`, delete and Undo, `deleteProject()`, a `storage` listener in `boot()` | Task X stays deleted on both devices; a reload 100 ms after a delete keeps it deleted; two tabs keep both tasks; deleting the filtered project leaves ALL active with every card showing; Undo after DEL restores the project and its 3 tasks' membership |
| P4 | `boot()`, `init()`, `pipeline()`, `connect()`, `submitDbConnect()` | with the database hung, cards render and quick-add captures within a second; a typo in a second connect shows the inline error and keeps the old token; a fresh database gets its table; a URL without a scheme is rejected before any request; a stored Light choice paints Light on the first frame |
| P5 | `reminders.js`, `mutate()`, the interval, `wireNotifications()` | a reminder 30 days out fires neither on Save nor on reload; finishing by key or drag cancels it; the next occurrence is armed without a reload; the banner appears only once a due time exists |
| P6 | `applyStatus()`, `reorderColumn()`, `dropIndex()`, the Restore handler, `advanceDate()`, `archiveStats()`, `agendaBucket()`, `isoWeekLabel()` | B's notes survive A's drag; In progress keeps `B high, A low` when C arrives; the filtered drag puts A below C; keys 3, 2, 3 leave one next occurrence; monthly from 01-31 goes 02-28 then 03-31; Restore puts the card on the board; the rail counts three weeks; a task due at 00:01 today files under Overdue |
| P7 | `openCardModal()`, `closeModal()`, key handlers, the two `<label>`s | focus lands in the title field; `3` with the panel open does nothing; Escape closes the database modal; typed notes survive Escape, backdrop and ×; clicking SUBTASKS or COLOUR changes nothing |
| P8 | `service-worker.js`, `index.html`, `css/*`, a new `fonts/` with the OFL licence | after a `max-age=600` deploy the page runs the new `app.js`; an offline reload has Archivo Black; a normal load contacts no third-party host; at 390 px the search box is on-screen and, with P2's banner change, quick-add starts in the top half; hover lifts the card; white-on-red is at least 4.5:1 in both themes; the two status labels match |
| P9 | `README.md`, `guide.js`, `.gitignore`, `PLAN-fixes.md`, `exportDownload()`, the dead code | every README claim in Part B step 13 matches behaviour; 01:30 IST exports as `…-2026-09-24-01-30-00.json`; every Part A check, rerun, shows the fixed result |
| P10 | `Hub/shared/sync.js`, then `sh Hub/tools/sync-vendor.sh` | reloads within five minutes add no backup; each vendoring app still passes its own check |

### Order

P1 → P2 → P3 → P4 → P5 → P6 → P7 → P9, one at a time. All eight edit
`js/app.js`; run in sequence, each agent reads the previous one's result instead
of merging around it, and the three high findings land in the first three
packages. P8 touches no JavaScript and can run alongside any of them. P10 can
run any time after P2. If you want speed over simplicity, P5, P6 and P7 edit
disjoint functions and could run at once in separate worktrees after P4 — at
the cost of a three-way merge of `app.js`.

### Before anything runs

- **Effort is set by the agent definition, not at spawn time.** The Agent tool
  takes a model but not an effort; `effort:` comes from `.claude/agents/*.md`
  frontmatter, the key your plugin agents already use. Running this as written
  needs four definitions in `Docket/.claude/agents/` — Opus xhigh, Opus high,
  Sonnet high, Sonnet medium — sharing one body: implement only the named
  package from this plan, quote its Part A check before and after, leave other
  packages' functions alone, don't commit.
- **The checks have to outlive this session.** Every "done when" above is a
  Part A script, and those live in this session's scratchpad. Move them to
  `tools/audit/`, one check per finding id, or run every package from this
  session.
- **Git is the backup.** The tree is clean at `ad09010` apart from mode bits, so
  no `.backup-*` copies (N2).

---

## Out of scope

- **Field-level merge.** A4's fix stops untouched cards being stamped. Two
  devices editing the same card still lose one side; per-field timestamps are a
  model change with their own migration.
- **Editing `vendor/sync.js` in place.** The `lastBackupAt` seed (A7) belongs in
  `Hub/shared/sync.js`, reviewed against every app that vendors it.
- **Leaving the shared `talon270.github.io` origin, or adding a CSP.** A10's
  validation closes the injection; origin isolation is a hosting decision.
- **Project rename.** Missing since PLAN-docket B7, but a feature rather than a
  defect; A20's Undo removes the worst consequence of not having it.
- **Touch drag.** Still covered by the panel's Status control, as PLAN-fixes
  decided.
