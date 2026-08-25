# Docket — plan

Written 2026-08-25, against no existing code — new project.
Method: grilled over 24 questions (`/grilling`) until every branch of the
design tree was settled. Nothing below is a guess; each row traces to an
answered question.

**Nothing below is implemented — this is the plan.**

## Part A — Phase 0 answers

1. **Who opens this and when?** Open constantly through the day, not a single
   daily planning session — quick capture matters more than a rich planning
   UI. Drives the always-visible quick-add bar and the keyboard shortcut.
2. **What must this app never get wrong?** Never lose a task. Drives the
   three-layer storage design below (live file → localStorage mirror →
   rolling timestamped backups) rather than trusting any single copy.
3. **What's the honest confidence of its central number?** N/A — Docket has
   no estimated/derived numbers. The nearest equivalent is *is the file in
   sync*, which is why a stale/disconnected file state gets a persistent
   banner rather than being hidden.
4. **What does it do when its data source dies?** If the file handle is lost
   (browser restart, permission expired, no file picked yet), the app keeps
   working from its localStorage mirror and shows a persistent "reconnect
   file" banner. It never blocks task capture and never silently drops back
   to a fake-fresh state.

## Part B — the build

### B1 · Data model

```js
// Docket/js/schema.js
SCHEMA_VERSION = 1

Task = {
  id: string,          // uuid
  title: string,
  projectId: string | null,
  dueDate: string | null,   // YYYY-MM-DD, local
  dueTime: string | null,   // HH:MM, optional
  priority: 'low' | 'med' | 'high',
  status: 'todo' | 'doing' | 'done',
  subtasks: [{ id, title, done: bool }],
  doneAt: string | null,    // ISO timestamp, set when moved to Done — drives 7-day archive
  archivedAt: string | null,
  createdAt: string,        // ISO timestamp
  updatedAt: string,        // ISO timestamp
}

Project = { id: string, name: string, color: string, createdAt: string }

DocketFile = {
  schemaVersion: 1,
  projects: Project[],
  tasks: Task[],
}
```

Whole-file JSON, not per-task records — the file is small enough that
autosave can rewrite it wholesale on every change, which keeps the sync
logic (file ⇄ mirror ⇄ backup) to one function instead of three.

### B2 · Storage layer (`js/storage.js`)

- **File handle** acquired via `showOpenFilePicker` / `showSaveFilePicker`,
  persisted in IndexedDB so it survives a reload without re-prompting —
  Chrome still requires a user gesture to re-*grant* permission after a
  restart, which is exactly the case the reconnect banner covers.
- **Autosave**: every mutation writes to the file (debounced ~400ms) and to
  `localStorage['docket.v1']` in the same call. The mirror is not a cache of
  the file — it is written independently on every change, so it stays
  current even if the file write fails.
- **Startup sequence**: try silent permission check (`queryPermission`) on
  the stored handle → if granted, read file, reconcile against the
  localStorage mirror by `updatedAt` (most recent wins per task), write the
  reconciled result back to both → if not granted or no handle stored, load
  from the mirror and show the reconnect banner.
- **Rolling backups**: on each successful file write, also write
  `docket.backup-YYYYMMDD-HHMMSS.json` into a `backups/` subfolder next to
  the live file, keep the newest 10, delete older ones. Same pattern as the
  timestamped `.backup-*` files elsewhere in this repo, adapted to run
  automatically instead of once before a manual edit, because every save
  here *is* the edit.

### B3 · Views

- **Board** (default view): fixed columns To Do / In Progress / Done.
  Project filter/switcher at the top (`All` + one entry per project). Cards
  sorted within a column by priority (high first), then due date. Drag
  card between columns to change `status`; dropping into Done sets `doneAt`.
- **Archive**: list of tasks with `archivedAt` set, grouped by the week they
  were archived, each with a "restore to Done" action that clears
  `archivedAt` and re-adds it to the board.
- **Quick-add bar**: pinned above the board. Title only; defaults to no
  project, no due date, `med` priority, `todo` status. Global shortcut `n`
  focuses it from anywhere in the app (skipped while a text field already
  has focus). Full editing (project, due date/time, priority, subtasks)
  happens by opening the card after it's created.

### B4 · Archive sweep

On every app load and once every 10 minutes while open, scan `tasks` for
`status === 'done' && doneAt <= now - 7d`, set `archivedAt = now`. Pure
function over the in-memory array, then goes through the normal
save-to-file-and-mirror path — no separate code path for archiving.

### B5 · Notifications (`js/reminders.js`)

- On granting Notification permission (asked once, explained inline — never
  requested silently), schedule a reminder at `dueDate+dueTime` and another
  30 minutes before, for every task that has a `dueTime` set.
- Tasks with a date but no time are not scheduled for a due-time
  notification — there's nothing to fire "at", by design (Q18: date-only
  tasks don't get the due-time reminder; a date-only board glance is still
  covered by priority sort on the board itself).
- Reschedule on any edit to `dueDate`/`dueTime`; cancel on `done`/delete.
- No quiet hours in v1 — out of scope, see below.

### B6 · PWA shell

`manifest.webmanifest` + `service-worker.js` caching the app shell (HTML,
CSS, JS) — mirrors `Helth/`'s pattern. The service worker never caches or
touches the data file; that stays entirely on the File System Access path.

### B7 · Projects

Created inline from the project filter/switcher ("+ New project" at the end
of the list) — name + a color swatch. Rename/delete via a small settings
popover on the project itself. Deleting a project with tasks in it prompts
to reassign them to "no project" rather than deleting the tasks — consistent
with "never lose a task."

## Out of scope

- **Recurring tasks.** Real feature with real edge cases (skip an
  occurrence, reschedule the series, end date) — deferred to its own plan
  once v1 is in daily use and the actual recurrence patterns you want are
  clear from real tasks, not guessed upfront.
- **Quiet hours for notifications.** Deferred until it's clear it's actually
  needed — adding a time-window check to B5 later is a small change, not
  worth designing blind now.
- **Tags.** Deliberately dropped in favor of project-only grouping (Q17) —
  not a phase-2 item, just not part of the model.
- **Multi-device sync beyond "the file."** If the JSON file itself sits in a
  synced folder (Drive/Dropbox) that's the user's setup, not something
  Docket manages — no in-app sync/merge server.
- **Non-Chrome support.** File System Access API is Chrome-only; no
  fallback UI for other browsers beyond "this needs Chrome."
