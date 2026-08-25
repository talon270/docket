# Docket

A task board you can open dozens of times a day. Three columns — To do, In
progress, Done — a quick-add bar for capturing a task in one keystroke, and
projects to group things by. No account, no server: everything lives in your
browser, and you can optionally point it at a file on your computer to keep
a real copy on disk.

Live at **[talon270.github.io/docket](https://talon270.github.io/docket/)**.

New here? Click **Guide** in the top right — it walks you through the whole
app one piece at a time.

## Adding a task

Click the `>>>` bar at the top (or press **N** from anywhere), type a title,
press **Enter**. The task appears on the board immediately, and a panel opens
so you can add the rest — project, due date, due time, priority, notes,
subtasks, a repeat. None of that is required. If you just want to capture the
thought and move on, close the panel and it's already saved.

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
months, so the 31st becomes the 28th in February rather than skipping ahead.

## If you delete something by accident

Deleting a task shows an **Undo** button for 8 seconds, and undoing puts the
card back exactly where it was. There's no "are you sure?" dialog — undo is
better than a prompt you'd click through anyway.

## Projects

Click **+ Project** to make one — give it a name and a color. Click a
project's tab at the top to filter the board down to just its tasks; click
**All** to see everything again. If you add a task while filtered to a
project, it's assigned to that project automatically.

To delete a project, open the project list and click **Del**. Its tasks
aren't deleted — they just lose the project label.

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

## Archive

A finished task stays in the Done column for 7 days, then moves itself to
the Archive automatically. Nothing is deleted — click **Archive** at the
top to see everything that's aged out, grouped by week, with a **Restore**
button on each one. The Archive also shows a few numbers about how you've
been working: average time from creating a task to finishing it, your
fastest and slowest, and a breakdown by project.

## Saving your data

By default, everything is saved in your browser automatically — closing the
tab or restarting your computer doesn't lose anything. Two ways to make it
sturdier:

- **Export** — downloads a copy of everything as a `.json` file. Good for a
  manual backup, or moving your tasks to a different computer.
- **Use existing file / Create file** — links Docket to an actual file on
  your disk. From then on, every change is saved to that file automatically
  (plus your browser keeps its own copy too, so nothing is ever staked on
  one save succeeding). If the connection to the file ever drops — say, you
  restarted your browser — a banner tells you, and your tasks are still safe
  in the browser copy until you reconnect.
- **Import** — loads a `.json` file back in. It merges with whatever's
  already there rather than replacing it, so importing an old backup can't
  accidentally erase newer tasks.

This file-connection feature only works in Chrome (or a Chrome-based
browser like Edge or Brave) — it's not available in Firefox or Safari.
Everything else on this page works in any browser.

## Light and dark

Docket matches your system's light/dark setting automatically. Click
**MODE** at the top right to override it — your choice is remembered from
then on.

## Keyboard shortcuts

| Key | What it does |
|---|---|
| `N` | Jump to the quick-add bar from anywhere |
| `Enter` (in quick-add) | Create the task |
| `1` / `2` / `3` | With a card selected: move it to To do / In progress / Done |
| `Enter` (on a card) | Open that card |
| `Esc` | Close whatever's open, or clear the search |

Click a card once to select it, or `Tab` to it.

## Install it on your phone or desktop

Docket is an installable web app. Open the live link in Chrome, and look for
an "Install" option in the browser's menu (on a phone, "Add to Home
Screen"). Once installed, it opens like any other app and works offline.
