# Docket

A task board you can open dozens of times a day. Three columns — To do, In
progress, Done — a quick-add bar for capturing a task in one keystroke, and
projects to group things by. No account, no server: everything lives in your
browser, and you can optionally point it at a file on your computer to keep
a real copy on disk.

Live at **[talon270.github.io/docket](https://talon270.github.io/docket/)**.

## Adding a task

Click the `>>>` bar at the top (or press **N** from anywhere), type a title,
press **Enter**. The task appears on the board immediately, and a panel opens
so you can add the rest — project, due date, due time, priority, subtasks.
None of that is required. If you just want to capture the thought and move
on, close the panel and it's already saved.

## Moving a task

Drag a card from one column to another. Dropping it in **Done** marks it
finished.

## Projects

Click **+ Project** to make one — give it a name and a color. Click a
project's tab at the top to filter the board down to just its tasks; click
**All** to see everything again. If you add a task while filtered to a
project, it's assigned to that project automatically.

To delete a project, open the project list and click **Del**. Its tasks
aren't deleted — they just lose the project label.

## Due dates and priority

Open a card (click it) to set a due date, a due time, and a priority of
High / Med / Low. A task that's overdue gets a red **Overdue** tag on the
board so it's easy to spot. Subtasks work the same way — open the card,
add a checklist, tick items off as you go.

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
| `Esc` | Close whatever's open (a card, a menu) |

## Install it on your phone or desktop

Docket is an installable web app. Open the live link in Chrome, and look for
an "Install" option in the browser's menu (on a phone, "Add to Home
Screen"). Once installed, it opens like any other app and works offline.
