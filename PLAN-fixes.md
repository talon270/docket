# Docket — defects and additions plan

Written 2026-08-25, against the repo at commit `62490fd` (guided tour shipped).
Method: read `js/app.js`, `js/schema.js`, `js/storage.js` line-level; verified
the two defects by running the app headlessly rather than reasoning about it
(touch drag under an emulated iPhone; delete under a seeded task with
subtasks). Everything in Part A quotes a measured result.

**Nothing below is implemented at the time of writing — this is the plan.**

---

## Part A — defects, ranked

### A1 · BUG (high): a phone cannot move a card

`wireDragDrop()` binds `dragover` / `drop` / `dragleave`, and `cardEl()` binds
`dragstart`. These are HTML5 drag events, which do not fire from touch input.
The app ships `manifest.webmanifest`, an `apple-touch-icon`, and a
`max-width: 860px` single-column board — it is meant to be installed on a
phone.

Measured under a 390×844 viewport with `has_touch=True`: `dragstart fires on
touch: False`, and task status stayed `todo` across a full
touchstart → touchmove → touchend sequence. A phone user can create tasks and
can never advance one.

**Fix:** add a status control to the card detail modal, which already opens on
tap. Smallest because the modal, its save path, and the `doneAt` bookkeeping
all exist — this routes touch through built code rather than adding a
touch-drag engine. Drag stays as the pointer gesture.

### A2 · DESIGN RISK (high): delete is permanent with no undo

`memory.md` states: "Reversibility over confirmation dialogs. Undo, a visible
banner, a logged change — not a modal." Delete currently has no confirm
(correct) and no undo (not correct).

Measured: created a task with three subtasks, opened it, clicked Delete —
`tasks.length` 1 → 0, no toast, no banner, no in-app recovery. The only
recovery path is a JSON export taken beforehand.

**Fix:** on delete, hold the removed task and its array index in memory and
show the existing toast with an Undo action for 8s. Smallest because
`showToast()` already exists; it needs an optional action button, not a new
component.

---

## Part B — the build

Ordered so schema work lands once, and later steps build on earlier ones.

### B1 · Schema v2 + migration

`SCHEMA_VERSION` 1 → 2. Three fields added to `Task`:

```js
notes: string        // "" default — free text under the title
recurrence: null | { every: 'day'|'week'|'month', interval: number }
order: number | null // null = fall back to priority/date sort
```

Migration runs wherever a file or mirror is read: any task missing a field
gets the default. No field is removed and no shape changes, so a v1 file
loads without loss and a v2 file is still readable by the sort/render code
if a field is absent.

### B2 · Card status control (fixes A1)

Segmented To do / In progress / Done in the card modal, above the actions.
Setting Done writes `doneAt`; moving off Done clears it. Same code path as a
drag drop.

### B3 · Undo delete (fixes A2)

`showToast(message, {actionLabel, onAction})`. Delete stashes
`{task, index}`, restores by splicing back at the original index so the
card returns to where it was, not to the end.

### B4 · Notes field

Textarea in the modal under the title. Cards show a small marker when notes
are non-empty. Notes are searchable (B6).

### B5 · Recurring tasks

`recurrence` set from the modal: every N day/week/month, or none. When a
recurring task is marked done — by drag, by the B2 control, or by the modal —
a fresh task is created with the same title/project/priority/notes/subtasks
(subtasks reset to unticked) and `dueDate` advanced by one interval. The
completed instance stays done and archives normally.

Deliberately *not* modelling a series: no "edit all future occurrences", no
end date, no skip. Each occurrence is an independent task, which is why
completing one can never corrupt another. Revisit only if daily use shows a
real need.

### B6 · Search

Text input in the project bar. Matches title and notes, case-insensitive,
across board and archive. Shows a result count and a clear button. Filtering
is applied in `visibleTasks()` and in the archive list so one predicate
covers both views.

### B7 · Agenda view

Third view alongside Board and Archive. Groups unarchived, unfinished tasks
by due date into: Overdue, Today, Tomorrow, This week, Later, No date.
Local-time date keys throughout — never `toISOString()`. Clicking a row opens
the card modal.

### B8 · Keyboard status changes

Cards get `tabindex="0"`. With a card focused: `1` / `2` / `3` set To do /
In progress / Done, `Enter` opens it, `Delete` removes it (undoable via B3).
Focus is preserved across the re-render so repeated keys work.

### B9 · Manual ordering

Drag within a column reorders instead of only changing status. On drop, the
whole column is reassigned `order` 0..n, so no fractional drift accumulates.
A column with no explicit order anywhere keeps the current priority-then-due
sort, so nothing changes until you drag something.

---

## Out of scope

- **Recurrence as a series.** See B5 — occurrences are independent by design.
- **Reordering in the agenda view.** It is a read-and-open surface; ordering
  belongs to the board.
- **Search across subtask titles.** Title and notes only; subtasks are
  detail, and matching them would surface cards whose visible text does not
  contain the query.
- **Touch drag-and-drop.** B2 solves mobile status changes through the modal.
  A touch-drag engine is a large surface for a gesture the modal already
  covers.
