# Docket

A task board you can open dozens of times a day. Three columns — To do, In
progress, Done — a quick-add bar for capturing a task in one keystroke, and
projects to group things by. No account, no server: everything lives in your
browser, and you can optionally point it at a folder on your computer to keep
a real copy on disk, with rolling backups beside it.

Live at **[talon270.github.io/docket](https://talon270.github.io/docket/)**.

New here? Click **Guide** in the top right — it walks you through the whole
app one piece at a time.

## Adding a task

Click the `>>>` bar at the top (or press **N** from anywhere), type a title,
press **Enter**. The task appears on the board immediately, and a panel opens
so you can add the rest — project, due date, due time, priority, notes,
subtasks, a repeat. None of that is required. If you just want to capture the
thought and move on, close the panel and it's already saved.

**Every way of closing the panel saves it.** Esc, the ×, a click outside and
Save all keep what you typed — the task already exists by the time the panel
opens, so there's nothing to cancel, and a reflexive Esc after setting a due
date shouldn't cost you the date. Closing without changing anything writes
nothing.

## Moving a task

Three ways, whichever suits:

- **Drag** a card from one column to another.
- **Click a card and press 1, 2 or 3** for To do / In progress / Done.
- **Open the card** and use its Status buttons — this is the one that works
  on a phone, where dragging isn't available.

Dropping a card in **Done** marks it finished.

You can also **drag a card up or down within a column** to put it exactly
where you want. Until you do that, a column sorts itself by priority and
then due date; once you drag something, that column keeps your order.

## Finding things

The **search box** at the top matches both titles and notes, and searches the
board and the archive at the same time. The count shows total matches, so a
result is never hiding in a view you aren't looking at. Press **Esc** or hit
the **×** to clear it.

## Agenda

The **Agenda** tab shows the same tasks arranged by *when they're due* rather
than by status — Overdue, Today, Tomorrow, This week, Later, No date. Click
any row to open it. Useful when the board tells you what's in flight but not
what's actually urgent.

## Repeating tasks

Open a card and set **Repeats** to daily, weekly or monthly (with an "every
N" if you want every 2 weeks, say). When you mark it done, the next one is
created automatically with its due date moved forward, and its subtasks reset
to unticked. The one you finished stays finished and archives normally.

A repeat needs a due date to move forward from — the card tells you inline if
you've set one without the other. Monthly repeats clamp to the end of short
months and then return to their day: a rent due on the 31st goes 31 Jan →
28 Feb → 31 Mar, not 28 Feb → 28 Mar for ever after.

**A late tick skips what you missed.** Finish a daily task that was due ten
days ago and the next one is due tomorrow, not nine days ago — the missed
occurrences are dropped, not queued. That's the right call for a habit and the
wrong one for something you owe every period, so for those, tick them on time
or add the missed ones by hand.

## If you delete something by accident

Deleting a task or a project shows an **Undo** button for 8 seconds, and
undoing puts it back exactly where it was — a project comes back with its tasks
still in it. There's no "are you sure?" dialog — undo is better than a prompt
you'd click through anyway.

**A delete stays deleted on every device.** Docket records each delete, so a
folder or database copy that still holds the task can't bring it back on the
next merge. Undo retracts that record, and the undo travels the same way.

## Projects

Click **+ Project** to open the project dialog — give it a name, an optional
one-line description, and a color from the eight presets or the picker. Click a
project's tab at the top to filter the board down to just its tasks; click
**All** to see everything again. If you add a task while filtered to a
project, it's assigned to that project automatically.

The dialog also lists every project you already have. Click **Del** to remove
one — its tasks aren't deleted, they just lose the project label, and the Undo
toast gives the label back. If you were filtered to that project, the board
drops back to **All**.

## Due dates, priority, notes

Open a card (click it) to set a due date, a due time, and a priority of
High / Med / Low. A task that's overdue gets a red **Overdue** tag on the
board so it's easy to spot. Subtasks work the same way — open the card,
add a checklist, tick items off as you go.

Each task also has a **notes** field for the things that don't fit in a
title: a link, a room number, what the assignment actually asks for. Cards
with notes show a small `≡ Notes` marker, and notes are searchable.

## Reminders

If you set a due time, Docket can send you a browser notification 30
minutes before and again when it's due. The first time you use a due time,
it'll ask permission — nothing is scheduled silently before you say yes.
Finishing or deleting the task cancels its reminders, and a repeat's next
occurrence is armed as soon as it's created.

**Reminders need Docket open.** They're timers in the page, not a server
push — with no Docket tab or installed window running, nothing fires. Leave a
tab open in the background and they arrive on time.

## Archive

A finished task stays in the Done column for 7 days, then moves itself to
the Archive automatically. Nothing is deleted — click **Archive** at the
top to see everything that's aged out, grouped by week, with a **Restore**
button on each one. Restore puts the card back in Done for another 7 days;
its time-to-done in the numbers below then runs to the restore rather than
the original finish. The Archive also shows a few numbers about how you've
been working: average time from creating a task to finishing it, your
fastest and slowest, a breakdown by project, and your busiest week — counted
by when tasks were finished, not when they reached the archive.

## Saving your data

By default, everything is saved in your browser automatically — closing the
tab or restarting your computer doesn't lose anything. Two ways to make it
sturdier:

- **Export** — downloads a copy of everything as a `.json` file. Good for a
  manual backup, or moving your tasks to a different computer.
- **Use existing folder / Set up folder** — links Docket to a folder on your
  disk, where it keeps `docket.json`. From then on, every change is saved to
  that file automatically (plus your browser keeps its own copy too, so
  nothing is ever staked on one save succeeding). Pointing it at a folder that
  already has a `docket.json` merges the two — nothing in the file is
  overwritten. If the connection drops — say, you restarted your browser — a
  red banner tells you, and it stays until you reconnect, however much you
  edit in the meantime; your tasks are safe in the browser copy until then.
  A `docket.json` that won't parse is never written over: the rail says so,
  and the file stays exactly as it was until you fix or replace it and
  reconnect.

  **Docket asks for the folder, not the file, and that is the point.** A file
  picker hands back the file with no way to reach the folder it sits in, so
  the rolling backups had nothing to write into and silently never ran. One
  folder grant gives both. Inside it you get `backups/`, holding the last ten
  snapshots — spaced at least five minutes apart, because ten copies taken
  during one burst of typing would satisfy the counter while protecting
  nothing and evicting the older states worth keeping. Opening Docket, or
  leaving it idle, writes no backup unless something changed. The spacing
  clock does reset when the page reloads, so an edit straight after each of
  several quick reloads can still take a slot each.

  If you connected a folder before 18 September 2026, your browser may hold only
  the file, not the folder, and no backups have been written. The rail says
  **Backups are off** in that case — **Use existing folder** on the same folder
  fixes it, and is safe: it reads before it writes.
- **Import** — loads a `.json` file back in. It merges with whatever's
  already there rather than replacing it, so importing an old backup can't
  accidentally erase newer tasks.

This file-connection feature only works in Chrome (or a Chrome-based
browser like Edge or Brave) on a desktop — it's not available in Firefox,
Safari, or on any phone, and the rail says so there instead of offering the
buttons. Everything else on this page works in any browser.

## Syncing through a database instead

Click **Database off** on the status rail (or **Connect database**) to sync
through a [Turso](https://turso.tech) database instead of, or alongside, a
shared folder. This is the option for two machines that don't share a
filesystem — a laptop and a phone, or two computers on different networks.
Create a free-tier database at [turso.tech/app](https://turso.tech/app),
paste its URL and an auth token into the modal, and every device pointed at
the same database merges into the same board — deletes included. The URL has
to start with `libsql://` or `https://`; anything else is rejected before a
request is made. A wrong token is caught on the spot and leaves the old
credential in place.

- **Docket never loads a client library for this — a database write is one
  `fetch()` call.** Turso's HTTP endpoint (`{url}/v2/pipeline`) sends a
  wildcard CORS header on both the preflight and the real request, confirmed
  against a live database before writing a line of this — see
  `PLAN-turso.md`. That's the whole reason there's no CDN import here despite
  every guide showing one: the official browser client exists for
  convenience, not necessity, and skipping it keeps this app's zero-runtime-
  dependency rule intact.
- **The folder and the database are two independent remotes, not one sync
  status.** You can be connected to a folder, a database, both, or neither,
  and each fails on its own — a wrong database token never marks the folder
  disconnected, and a lost folder permission never touches the database
  strip. That's why there are two status labels on the rail instead of one.
- **The credential lives only in this browser's `localStorage`.** It is never
  written into `docket.json`, never included in an export, and Docket's code
  never sends it anywhere but that one database. That is a claim about this
  app, not about the site: GitHub Pages serves every `talon270.github.io`
  project from one origin, and any page there can read that storage. Anyone
  who gets the URL and token can read and write your tasks, so treat them
  like a password — Disconnect, in the same modal, clears them from this
  browser without touching what's stored in Turso.
- **Same merge as the folder, same guarantee.** The database holds one JSON
  row, and every device applies the identical `reconcile()` — most recent
  `updatedAt` per task or project wins, and a recorded delete beats an older
  copy. Every write merges the stored row in first, so a device that hasn't
  refreshed can't write its stale board over another's work. There's no
  separate conflict-file concept to reason about, because there's no
  filesystem sync tool underneath to produce one.
- **The merge is per card, not per field.** Two devices editing the *same*
  card between syncs: the later edit wins the whole card, and the other side's
  change to it is lost. Different cards never interfere — a drag only stamps
  the card you moved.

## Light and dark

Docket matches your system's light/dark setting automatically. Click the
**Dark** / **Light** button at the top right — it names the theme you're
looking at — to override it; your choice is remembered from then on.

## Keyboard shortcuts

| Key | What it does |
|---|---|
| `N` | Jump to the quick-add bar from anywhere |
| `Enter` (in quick-add) | Create the task |
| `1` / `2` / `3` | With a card selected: move it to To do / In progress / Done |
| `Enter` (on a card) | Open that card |
| `Esc` | Close whatever's open (the task panel saves as it closes), or clear the search |

Click a card once to select it, or `Tab` to it. While any panel is open, the
board's keys stand down — `N` and `1`–`3` never reach the card behind it.

## Install it on your phone or desktop

Docket is an installable web app. Open the live link in Chrome, and look for
an "Install" option in the browser's menu (on a phone, "Add to Home
Screen"). Once installed, it opens like any other app and works offline.
