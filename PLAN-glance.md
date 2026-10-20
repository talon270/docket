# Glance in Docket — plan

Written 2026-10-20, against the repo at commit `a096daf` (clean tree, plus the
untracked `hairline/` folder holding the standalone figure).
Method: read `index.html`, `js/hairline-host.js`, `js/hairline-pegboard.js`,
the board half of `js/app.js` (`mutate`, `render`, `renderColumn`,
`submitQuickAdd`), `css/layout.css` around `.board` and `.empty-figure`, and
`service-worker.js`. Measured the board at 1920×1080, 1440×900 and 390×844
under Playwright with three tasks added through the real quick-add bar.

**Nothing below is implemented — this is the plan.**

---

## What changes from the standalone figure

**The figure stops inventing notes.** The standalone `hairline/glance.js` sticks
a note on any row you hover and keeps it on a press — a demo state that belongs
to nobody. Inside Docket that would be a board that shows tasks you don't have.
Every note in the app version is a real To do task; the pointer only reads.

| | Standalone (`hairline/glance.js`) | In Docket (`js/hairline-glance.js`) |
|---|---|---|
| Notes on the board | fake: rows 1–2 at rest, hover adds, press keeps | the real To do count, rows filled top-down, capped at 4 |
| What adds a note | hovering a row | a task created anywhere (quick add, repeat spawn, import, sync) |
| Mini board | fills the hovered row after the lag | fills the new task's row 300ms after its note lands |
| Bright mark | the row the mini board saw last | the same — the newest To do task's mini row |
| Hover | adds a note | reads only: the read-out shows `todo 2`, an empty row reads `empty` |
| Click | keeps the note | opens that task's detail panel; an empty row does nothing |
| Slider | lag, 0–700ms | none; the lag is fixed at the 300ms default |

## Part A — findings that shape the build

### A1 · DESIGN RISK (high): "always visible" has no free slot on the board

At 1920×1080 the three columns span the full width (`.board` is
`repeat(3, minmax(0, 1fr))`, 640px each) and the page grows with its content
(`.app-shell { min-height: 100vh }`; columns never scroll on their own). The
quick-add bar is 61px tall and the topbar 70px — a 400×320 figure there renders
under 80px wide, and the Hairline rule is that the silhouette must read at
240px. There is no unused rectangle that big that stays on screen.

**Fix:** a fixed dock in the bottom-right corner, 220px wide (176px tall at the
figure's 5:4), outside `.board` so it stays put while the page scrolls. It
overlaps the Done column's lower right; `.column-body` in the board view gets
`padding-bottom` equal to the dock's height so the last card in every column
can always scroll clear of it. Smallest because it adds one element and two CSS
rules and moves nothing that exists. **This is the decision to approve or
change** — the alternative is a fourth, narrow grid column, which shrinks every
card by ~70px at 1440.

### A2 · DESIGN RISK (medium): a row cap of 4 hides the fifth task

The figure has four rows. With seven To do tasks the board is full and adding
an eighth changes nothing visible.

**Fix:** when the board is already full, a new task still replays the add: the
fourth row's note goes back to the pad and comes back, and the mini board
re-fills its fourth row. The read-out on that row says `todo 4+`. Stated in the
README rather than hidden: the figure counts to four; the column header's count
is the real number.

### A3 · INCONSISTENCY (low): the figure needs data, the host only passes a number

`hairline-host.js` calls `mount({ stage, svg, read }, figure.range[1])` and
keeps the handle to itself; nothing reaches a mounted figure afterwards. The
host header says it is "the same in every app that uses a figure", so changing
it diverges from the pegboard's contract.

**Fix:** `app.js` writes the state onto the placeholder as `data-count` and
`data-newest` and dispatches a `docket:todos` event on it; the figure listens
with `bag.on(stage, "docket:todos", …)` and reads the dataset. The host stays
unchanged. Click-to-open goes the other way: the figure dispatches
`docket:open` with the row index, and `app.js` maps it to a task id.

## Part B — the build

1. **Timestamped backups** of `js/app.js`, `css/layout.css`, `index.html`,
   `service-worker.js`.
2. **`js/hairline-glance.js`** — copy of `hairline/glance.js` with the demo
   state removed: no `kept`, no hover-add; rows filled from `data-count`; bright
   on `data-newest`; `down` dispatches `docket:open`. The empty board at rest
   (zero tasks) shows four ruled rows, a full pad, and the mini board blank with
   its bezel as the one bright mark — a composed empty state, not a blank one.
3. **Dock markup + CSS** — `<div id="glance-dock" class="glance-dock"
   data-hairline-figure="glance">` after `</main>`; `position: fixed; right;
   bottom`; the five `--hairline-*` tokens mapped exactly as `.empty-figure`
   does, so both themes come from `theme.css`. Hidden below 860px, where the
   board is one column and a fixed corner covers half a phone screen.
4. **Wire it in `app.js`** — in `renderBoard()`, compute the To do tasks the
   column shows (`visibleTasks()` filtered to `todo`, so the project filter and
   search apply, same as the column), and if the count or newest id changed
   since last render, update the dataset and dispatch. "Newest" is the To do
   task with the latest `createdAt`. Listen for `docket:open` → `openCardModal`.
   Shown on the Board view only; hidden on Agenda and Archive.
5. **`service-worker.js`** — add `./js/hairline-glance.js` to `SHELL`, bump
   `docket-shell-v15` → `v16`.
6. **README** — one short section under "Adding a task": what the corner board
   is, that it counts to four, that clicking a row opens it.

## Verification (Gate 2)

Playwright, real clicks and keystrokes, scratch script in the session
scratchpad:

- Fresh profile and seeded profile load with zero console errors.
- Add three tasks through the quick-add bar: `data-count` goes 0 → 1 → 2 → 3,
  and after each the mini board's bright row is the new one (assert the `hi`
  class on the right path).
- Add a fifth and a sixth: the replay fires, nothing throws, count shows `4+`.
- Click a filled row in the dock: the detail panel opens on that task.
- Switch project tab and type a search: the dock follows the column.
- Both themes; 1920, 1440 and 390 widths; the last card in Done scrolls clear
  of the dock at 1440.
- Run the standing checklist from `md/skills.md` (old-schema seed, backup
  round-trip) — no schema change is planned, so this should be a no-op proof.

## Out of scope

- **A real always-on-top window** (Document Picture-in-Picture). Different
  feature, Chrome-only; you picked the figure.
- **More than four rows**, scrolling, or titles drawn in the figure — rule 10
  keeps words out of the drawing, and the read-out stays a few characters
  (`todo 2`), so no titles anywhere in the dock.
- **Phone layout.** Hidden under 860px; a phone already shows the To do column
  first.
- **A user setting to hide the dock.** Add one if it gets in the way in real
  use, not before.
- **Changes to `hairline-host.js` or the vendored kernel.**
