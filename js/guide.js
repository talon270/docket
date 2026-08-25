// DOCKET · GUIDE
// · A modal spotlight tour: dims everything but the current target, and
//   walks through what each part of the app does in plain words.
// · Purely opt-in — button-triggered only, never auto-started on load. A
//   tool that turns itself on for you without asking is exactly the
//   "silent configuration" this house avoids.
// · Steps that need a different view (the archive) switch to it on enter
//   and switch back on exit, so the tour never leaves the app in a
//   different state than it found it.
"use strict";

(function () {
  const STEPS = [
    {
      target: "#quick-add-input",
      title: "Quick add",
      body: "Type a title and press Enter — the task is created immediately, and its detail panel opens so you can add a due date, notes, subtasks or a repeat. None of that is required to save it.",
    },
    {
      target: "#board",
      title: "The board",
      body: "Three columns: To do, In progress, Done. Drag a card between them, or click one and press 1, 2 or 3. Drag a card up or down inside a column to set your own order. On a phone, open the card and use its Status buttons.",
      onEnter: () => window.Docket.App.goToView("board"),
    },
    {
      target: ".search-box",
      title: "Search",
      body: "Searches titles and notes at once, across the board and the archive together. The count tells you how many tasks match in total, so a result is never hidden in a view you are not looking at.",
    },
    {
      target: "#agenda-list",
      title: "Agenda",
      body: "The same tasks arranged by when they are due instead of by status: Overdue, Today, Tomorrow, This week, Later, No date. Click any row to open it.",
      onEnter: () => window.Docket.App.goToView("agenda"),
      onExit: () => window.Docket.App.goToView("board"),
    },
    {
      target: ".project-bar",
      title: "Projects",
      body: "Click + Project to make one. Click its tab to filter the board down to just that project — a task you add while filtered goes straight into it.",
    },
    {
      target: "#sync-strip",
      title: "Where your data lives",
      body: "Everything saves to this browser automatically, so closing the tab never loses anything. This strip tells you whether it's also synced to a real file on your disk.",
    },
    {
      target: "#export-btn",
      title: "Export & import",
      body: "Export downloads a full backup as a file. Import loads one back in and merges it with what's already here — it can never accidentally overwrite a newer task.",
    },
    {
      target: "#theme-toggle",
      title: "Light & dark",
      body: "Docket follows your system's light/dark setting automatically. Click here to override it — your choice is remembered from then on.",
    },
    {
      target: "#archive-rail .rail-content",
      title: "Archive",
      body: "A finished task waits 7 days, then archives itself automatically — nothing is ever deleted, and Restore brings it straight back. This panel shows how you've actually been working: average time to finish a task, fastest, slowest, and a breakdown by project.",
      onEnter: () => window.Docket.App.goToView("archive"),
      onExit: () => window.Docket.App.goToView("board"),
    },
    {
      target: "#guide-btn",
      title: "That's Docket",
      body: "Press N to capture a task from anywhere. Click a card and press 1, 2 or 3 to move it. Deleting always offers an Undo. Come back here whenever you want the tour again — it never changes what is on your board.",
    },
  ];

  let index = 0;
  let active = false;
  let restoreFocus = null;

  const $ = (id) => document.getElementById(id);

  function targetEl(step) {
    return document.querySelector(step.target);
  }

  function positionSpot(rect) {
    const pad = 8;
    const spot = $("tour-spot");
    spot.style.top = `${rect.top - pad}px`;
    spot.style.left = `${rect.left - pad}px`;
    spot.style.width = `${rect.width + pad * 2}px`;
    spot.style.height = `${rect.height + pad * 2}px`;
  }

  function positionCard(rect) {
    const card = $("tour-card");
    const margin = 16;
    const cardRect = card.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let top = rect.bottom + margin;
    if (top + cardRect.height > vh - margin) {
      top = rect.top - cardRect.height - margin;
    }
    if (top < margin) top = Math.max(margin, (vh - cardRect.height) / 2);

    let left = rect.left;
    if (left + cardRect.width > vw - margin) left = vw - cardRect.width - margin;
    if (left < margin) left = margin;

    card.style.top = `${top}px`;
    card.style.left = `${left}px`;
  }

  function renderStep() {
    const step = STEPS[index];
    const el = targetEl(step);
    if (!el) {
      // The target isn't in the DOM for some reason (a future edit renamed
      // an id) — skip rather than spotlight nothing.
      index < STEPS.length - 1 ? next() : end();
      return;
    }

    el.scrollIntoView({ block: "center", behavior: "instant" in window ? "instant" : "auto" });
    const rect = el.getBoundingClientRect();
    positionSpot(rect);

    $("tour-step-label").textContent = `GUIDE ${String(index + 1).padStart(2, "0")}/${String(STEPS.length).padStart(2, "0")}`;
    $("tour-title").textContent = step.title;
    $("tour-body").textContent = step.body;
    $("tour-back").disabled = index === 0;
    $("tour-next").textContent = index === STEPS.length - 1 ? "Done" : "Next";

    // Card sizes itself off the new text before it can be positioned
    requestAnimationFrame(() => positionCard(el.getBoundingClientRect()));
  }

  function goToStep(newIndex) {
    const leaving = STEPS[index];
    if (leaving.onExit) leaving.onExit();
    index = newIndex;
    const entering = STEPS[index];
    if (entering.onEnter) entering.onEnter();
    // Give the view switch a frame to render before measuring its layout.
    requestAnimationFrame(renderStep);
  }

  function next() {
    if (index >= STEPS.length - 1) {
      end();
      return;
    }
    goToStep(index + 1);
  }

  function back() {
    if (index === 0) return;
    goToStep(index - 1);
  }

  function start() {
    if (active) return;
    active = true;
    index = 0;
    restoreFocus = document.activeElement;
    $("tour").hidden = false;
    document.addEventListener("keydown", onKeydown, true);
    window.addEventListener("resize", onResize);
    const first = STEPS[0];
    if (first.onEnter) first.onEnter();
    requestAnimationFrame(renderStep);
  }

  function end() {
    if (!active) return;
    const leaving = STEPS[index];
    if (leaving.onExit) leaving.onExit();
    active = false;
    $("tour").hidden = true;
    document.removeEventListener("keydown", onKeydown, true);
    window.removeEventListener("resize", onResize);
    if (restoreFocus && restoreFocus.focus) restoreFocus.focus();
  }

  function onResize() {
    if (active) renderStep();
  }

  function onKeydown(e) {
    if (e.key === "Escape") { e.preventDefault(); end(); }
    if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); next(); }
    if (e.key === "ArrowLeft") { e.preventDefault(); back(); }
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("guide-btn").addEventListener("click", start);
    $("tour-next").addEventListener("click", next);
    $("tour-back").addEventListener("click", back);
    $("tour-skip").addEventListener("click", end);
  });
})();
