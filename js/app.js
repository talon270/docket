// DOCKET · APP
// · Owns render state, view switching, and every DOM event handler.
// · All mutation goes through mutate(fn) so autosave + archive sweep + a
//   single re-render always follow the same path — no direct pushes to
//   state.tasks anywhere else in the file.
"use strict";

(function () {
  const { makeTask, makeProject, nowIso } = window.Docket.Schema;
  const Storage = window.Docket.Storage;
  const Reminders = window.Docket.Reminders;

  const ARCHIVE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
  const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

  const state = {
    data: { schemaVersion: 2, projects: [], tasks: [] },
    view: "board", // 'board' | 'agenda' | 'archive'
    activeProjectId: "all",
    search: "",
    syncStatus: "no-file", // 'synced' | 'mirror-only' | 'disconnected' | 'no-file'
  };

  const els = {};

  function $(id) {
    return document.getElementById(id);
  }

  function cacheEls() {
    [
      "board", "col-todo", "col-doing", "col-done", "archive-list",
      "body-todo", "body-doing", "body-done",
      "count-todo", "count-doing", "count-done",
      "tm-active", "tm-done", "tm-archived", "tm-date",
      "project-tabs", "quick-add-input", "sync-strip", "reconnect-banner",
      "view-board-btn", "view-archive-btn", "theme-toggle", "theme-label", "new-project-btn",
      "project-modal", "project-modal-list", "project-modal-error", "project-swatches",
      "new-project-name", "new-project-desc", "new-project-color",
      "card-modal", "card-modal-body", "notif-banner", "notif-enable-btn",
      "export-btn", "import-btn", "import-file-input", "toast",
      "view-agenda-btn", "search-input", "search-clear", "search-count",
    ].forEach((id) => (els[id] = $(id)));
  }

  let toastTimer = null;
  // opts: { isError, actionLabel, onAction, duration }
  function showToast(message, opts) {
    const o = typeof opts === "boolean" ? { isError: opts } : opts || {};
    const el = els["toast"];
    el.classList.toggle("toast-error", !!o.isError);
    el.innerHTML = "";

    const text = document.createElement("span");
    text.className = "toast-text";
    text.textContent = message;
    el.appendChild(text);

    if (o.actionLabel && o.onAction) {
      const btn = document.createElement("button");
      btn.className = "toast-action";
      btn.type = "button";
      btn.textContent = o.actionLabel;
      btn.addEventListener("click", () => {
        clearTimeout(toastTimer);
        el.hidden = true;
        o.onAction();
      });
      el.appendChild(btn);
    }

    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), o.duration || 4000);
  }

  function mutate(fn) {
    fn(state.data);
    sweepArchive(state.data);
    Storage.autosave(state.data);
    render();
  }

  function sweepArchive(data) {
    const cutoff = Date.now() - ARCHIVE_AFTER_MS;
    for (const t of data.tasks) {
      if (t.status === "done" && !t.archivedAt && t.doneAt && new Date(t.doneAt).getTime() <= cutoff) {
        t.archivedAt = nowIso();
        t.updatedAt = nowIso();
      }
    }
  }

  // ---- rendering ------------------------------------------------------------

  function priorityRank(p) {
    return { high: 0, med: 1, low: 2 }[p] ?? 1;
  }

  // One predicate for both board and archive, so a search can never show a
  // different set of matches depending on which view you are looking at.
  function matchesSearch(t) {
    const q = state.search.trim().toLowerCase();
    if (!q) return true;
    return (
      t.title.toLowerCase().includes(q) ||
      (t.notes || "").toLowerCase().includes(q)
    );
  }

  function visibleTasks() {
    return state.data.tasks.filter((t) => {
      if (t.archivedAt) return false;
      if (state.activeProjectId !== "all" && t.projectId !== state.activeProjectId) return false;
      return matchesSearch(t);
    });
  }

  function projectById(id) {
    return state.data.projects.find((p) => p.id === id) || null;
  }

  // Local-time YYYY-MM-DD. Never toISOString() — that is UTC and would call a
  // task overdue up to a day early or late depending on the timezone.
  function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function isOverdue(task) {
    if (!task.dueDate || task.status === "done") return false;
    const today = todayKey();
    if (task.dueDate < today) return true;
    if (task.dueDate > today) return false;
    if (!task.dueTime) return false; // due today, date-only: the rest of today still counts
    return new Date(`${task.dueDate}T${task.dueTime}:00`).getTime() < Date.now();
  }

  function dateKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  // Advances a YYYY-MM-DD key by one recurrence interval, in local time.
  // Month steps clamp to the last valid day, so the 31st repeating monthly
  // lands on the 30th/28th rather than silently rolling into next month.
  function advanceDate(key, recurrence) {
    const [y, m, d] = key.split("-").map(Number);
    const n = recurrence.interval || 1;
    if (recurrence.every === "day") {
      const dt = new Date(y, m - 1, d + n);
      return dateKey(dt);
    }
    if (recurrence.every === "week") {
      const dt = new Date(y, m - 1, d + n * 7);
      return dateKey(dt);
    }
    const targetMonth = m - 1 + n;
    const lastDay = new Date(y, targetMonth + 1, 0).getDate();
    return dateKey(new Date(y, targetMonth, Math.min(d, lastDay)));
  }

  function describeRecurrence(r) {
    if (!r) return null;
    const n = r.interval || 1;
    return n === 1 ? `Every ${r.every}` : `Every ${n} ${r.every}s`;
  }

  // Every path that can complete a task funnels through here — drag, the
  // modal's status control, and the keyboard shortcuts — so recurrence and
  // doneAt bookkeeping can never disagree between them.
  function applyStatus(d, taskId, status) {
    const t = d.tasks.find((x) => x.id === taskId);
    if (!t || t.status === status) return;
    const wasDone = t.status === "done";
    t.status = status;
    t.updatedAt = nowIso();
    t.doneAt = status === "done" ? nowIso() : null;

    // Completing a recurring task spawns the next occurrence. The finished
    // instance stays done and archives normally — occurrences are
    // independent tasks, so completing one can never corrupt another.
    if (status === "done" && !wasDone && t.recurrence && t.dueDate) {
      d.tasks.push(
        makeTask({
          title: t.title,
          projectId: t.projectId,
          priority: t.priority,
          notes: t.notes,
          recurrence: { ...t.recurrence },
          dueDate: advanceDate(t.dueDate, t.recurrence),
          dueTime: t.dueTime,
          subtasks: t.subtasks.map((s) => ({ ...s, id: window.Docket.Schema.uuid(), done: false })),
        })
      );
    }
  }

  function cardEl(task) {
    const card = document.createElement("div");
    card.className = "card";
    card.draggable = true;
    card.tabIndex = 0; // keyboard: focus a card, then 1/2/3 to move it
    card.dataset.id = task.id;
    // Scoped to --proj, never --accent: overriding --accent here would repaint
    // every accent-coloured child (the HIGH pill, the overdue tag) in the
    // project's colour, which would misreport priority as a project.
    card.style.setProperty("--proj", (projectById(task.projectId) || {}).color || "var(--fg)");

    const doneSubtasks = task.subtasks.filter((s) => s.done).length;
    const proj = projectById(task.projectId);
    const overdue = isOverdue(task);

    card.innerHTML = `
      <div class="card-top">
        <span class="pill pill-${task.priority}">${task.priority}</span>
        ${proj ? `<span class="pill pill-project" style="border-left-color:${proj.color}">${escapeHtml(proj.name)}</span>` : ""}
        ${overdue ? `<span class="pill pill-overdue">Overdue</span>` : ""}
        ${task.recurrence ? `<span class="pill pill-repeat" title="${escapeHtml(describeRecurrence(task.recurrence))}">↻ ${escapeHtml(describeRecurrence(task.recurrence))}</span>` : ""}
      </div>
      <div class="card-title">${escapeHtml(task.title)}</div>
      <div class="card-meta">
        ${task.dueDate ? `<span class="${overdue ? "overdue" : ""}">${task.dueDate}${task.dueTime ? " · " + task.dueTime : ""}</span>` : ""}
        ${task.subtasks.length ? `<span>${doneSubtasks}/${task.subtasks.length} done</span>` : ""}
        ${task.notes && task.notes.trim() ? `<span class="has-notes" title="Has notes">≡ Notes</span>` : ""}
      </div>
      ${
        task.subtasks.length
          ? `<div class="card-progress"><i style="width:${Math.round((doneSubtasks / task.subtasks.length) * 100)}%"></i></div>`
          : ""
      }
    `;

    card.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", task.id);
      card.classList.add("dragging");
    });
    card.addEventListener("dragend", () => {
      card.classList.remove("dragging");
      document.querySelectorAll(".drop-target").forEach((c) => c.classList.remove("drop-target"));
    });
    card.addEventListener("click", () => openCardModal(task.id));

    return card;
  }

  const EMPTY_COPY = {
    todo: { big: "Nothing queued", small: "Press N to capture a task" },
    doing: { big: "Nothing started", small: "Drag a card here when you pick it up" },
    done: { big: "Nothing finished", small: "Completed cards archive after 7 days" },
  };

  // Renders into .column-body, never the <section> — the section also holds
  // the sticky header, and wiping it there deletes the column label.
  // A column keeps the priority-then-due sort until something in it has been
  // dragged into an explicit position; from then on that column is manual.
  // Mixing the two would make a drag appear to do nothing when the dropped
  // card's priority disagreed with where it was put.
  function sortColumn(tasks) {
    const manual = tasks.some((t) => t.order !== null && t.order !== undefined);
    if (manual) {
      return tasks.slice().sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9));
    }
    return tasks
      .slice()
      .sort(
        (a, b) =>
          priorityRank(a.priority) - priorityRank(b.priority) ||
          (a.dueDate || "9999").localeCompare(b.dueDate || "9999")
      );
  }

  function renderColumn(bodyEl, countEl, status) {
    bodyEl.innerHTML = "";
    const tasks = sortColumn(visibleTasks().filter((t) => t.status === status));

    countEl.textContent = String(tasks.length).padStart(2, "0");

    if (!tasks.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      const copy = state.search.trim()
        ? { big: "No matches", small: "Nothing in this column matches your search" }
        : EMPTY_COPY[status];
      empty.innerHTML = `${copy.big}<small>${copy.small}</small>`;
      bodyEl.appendChild(empty);
      return;
    }
    tasks.forEach((t) => bodyEl.appendChild(cardEl(t)));
  }

  function renderBoard() {
    renderColumn(els["body-todo"], els["count-todo"], "todo");
    renderColumn(els["body-doing"], els["count-doing"], "doing");
    renderColumn(els["body-done"], els["count-done"], "done");
  }

  function renderTelemetry() {
    const live = state.data.tasks.filter((t) => !t.archivedAt);
    els["tm-active"].textContent = live.filter((t) => t.status !== "done").length;
    els["tm-done"].textContent = live.filter((t) => t.status === "done").length;
    els["tm-archived"].textContent = state.data.tasks.filter((t) => t.archivedAt).length;
    els["tm-date"].textContent = todayKey();
  }

  function renderArchive() {
    const list = els["archive-list"];
    list.innerHTML = "";
    const allArchived = state.data.tasks
      .filter((t) => t.archivedAt)
      .sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
    const archived = allArchived.filter(matchesSearch);

    // The rail reports throughput over the whole archive, not the current
    // search — a filtered average would read as an overall figure.
    renderArchiveRail(allArchived);

    if (!archived.length) {
      list.innerHTML = state.search.trim()
        ? `<div class="empty-state">No matches<small>Nothing in the archive matches your search</small></div>`
        : `<div class="empty-state">Archive is empty<small>Done cards move here 7 days after completion</small></div>`;
      return;
    }

    const groups = new Map();
    for (const t of archived) {
      const wk = isoWeekLabel(t.archivedAt);
      if (!groups.has(wk)) groups.set(wk, []);
      groups.get(wk).push(t);
    }

    for (const [week, tasks] of groups) {
      const section = document.createElement("div");
      section.className = "archive-group";
      section.innerHTML = `<div class="archive-week">${week}<em>${tasks.length} task${tasks.length === 1 ? "" : "s"}</em></div>`;
      const rows = document.createElement("div");
      rows.className = "archive-rows";
      tasks.forEach((t) => {
        const row = document.createElement("div");
        row.className = "archive-row";
        row.innerHTML = `
          <span class="archive-title">${escapeHtml(t.title)}</span>
          <button class="btn-restore" data-id="${t.id}">Restore</button>
        `;
        row.querySelector(".btn-restore").addEventListener("click", () => {
          mutate((d) => {
            const task = d.tasks.find((x) => x.id === t.id);
            task.archivedAt = null;
            task.updatedAt = nowIso();
          });
        });
        rows.appendChild(row);
      });
      section.appendChild(rows);
      list.appendChild(section);
    }
  }

  // ---- agenda -------------------------------------------------------------

  // Buckets are computed from local-time date keys, never toISOString(), for
  // the same reason isOverdue() is: a UTC boundary would put "today" on the
  // wrong side of midnight for anyone not on UTC.
  function agendaBucket(task, today, tomorrow, weekEnd) {
    if (!task.dueDate) return "nodate";
    if (task.dueDate < today) return "overdue";
    if (task.dueDate === today) return "today";
    if (task.dueDate === tomorrow) return "tomorrow";
    if (task.dueDate <= weekEnd) return "week";
    return "later";
  }

  const AGENDA_GROUPS = [
    ["overdue", "Overdue"],
    ["today", "Today"],
    ["tomorrow", "Tomorrow"],
    ["week", "This week"],
    ["later", "Later"],
    ["nodate", "No date"],
  ];

  function renderAgenda() {
    const list = document.getElementById("agenda-list");
    list.innerHTML = "";

    const today = todayKey();
    const now = new Date();
    const tomorrow = dateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
    const weekEnd = dateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7));

    const open = visibleTasks().filter((t) => t.status !== "done");
    if (!open.length) {
      list.innerHTML = state.search.trim()
        ? `<div class="empty-state">No matches<small>No unfinished task matches your search</small></div>`
        : `<div class="empty-state">Nothing open<small>Every task is done or archived</small></div>`;
      return;
    }

    const buckets = new Map(AGENDA_GROUPS.map(([k]) => [k, []]));
    for (const t of open) buckets.get(agendaBucket(t, today, tomorrow, weekEnd)).push(t);

    for (const [key, label] of AGENDA_GROUPS) {
      const items = buckets.get(key);
      if (!items.length) continue;
      items.sort(
        (a, b) =>
          (a.dueDate || "9999").localeCompare(b.dueDate || "9999") ||
          (a.dueTime || "99:99").localeCompare(b.dueTime || "99:99") ||
          priorityRank(a.priority) - priorityRank(b.priority)
      );

      const section = document.createElement("section");
      section.className = "agenda-group" + (key === "overdue" ? " agenda-overdue" : "");
      section.innerHTML = `
        <div class="agenda-head">
          <span class="agenda-label">${label}</span>
          <span class="agenda-count">${String(items.length).padStart(2, "0")}</span>
        </div>`;

      const rows = document.createElement("div");
      rows.className = "agenda-rows";
      items.forEach((t) => {
        const proj = projectById(t.projectId);
        const row = document.createElement("button");
        row.type = "button";
        row.className = "agenda-row";
        row.innerHTML = `
          <span class="agenda-swatch" style="background:${proj ? proj.color : "var(--fg-dim)"}"></span>
          <span class="agenda-title">${escapeHtml(t.title)}</span>
          ${t.recurrence ? `<span class="agenda-meta">↻</span>` : ""}
          <span class="agenda-meta">${t.status === "doing" ? "In progress" : ""}</span>
          <span class="agenda-when">${t.dueDate ? t.dueDate + (t.dueTime ? " · " + t.dueTime : "") : "—"}</span>
        `;
        row.addEventListener("click", () => openCardModal(t.id));
        rows.appendChild(row);
      });
      section.appendChild(rows);
      list.appendChild(section);
    }
  }

  // Throughput figures for the archive rail. Every number here is measured
  // from stored timestamps, not estimated — createdAt and doneAt are both
  // written at the moment the event happened, so "days to done" is exact.
  // Tasks archived without a doneAt (imported from an older file) are
  // excluded from the duration figures and the sample count says so.
  function archiveStats(archived) {
    // A doneAt earlier than createdAt is impossible and can only arrive from a
    // hand-edited or corrupt import. Drop those rather than rendering a
    // negative span as a plausible "1h" — the sample line below reports the
    // shortfall, so the figure never overstates what it measured.
    const timed = archived.filter(
      (t) => t.doneAt && t.createdAt && new Date(t.doneAt) >= new Date(t.createdAt)
    );
    const days = timed.map((t) => (new Date(t.doneAt) - new Date(t.createdAt)) / 86400000);

    const byProject = new Map();
    for (const t of archived) {
      const key = t.projectId || "__none";
      byProject.set(key, (byProject.get(key) || 0) + 1);
    }

    const byWeek = new Map();
    for (const t of archived) {
      const w = isoWeekLabel(t.archivedAt);
      byWeek.set(w, (byWeek.get(w) || 0) + 1);
    }
    let busiest = null;
    for (const [w, n] of byWeek) if (!busiest || n > busiest[1]) busiest = [w, n];

    return {
      total: archived.length,
      sample: timed.length,
      avgDays: days.length ? days.reduce((a, b) => a + b, 0) / days.length : null,
      fastest: days.length ? Math.min(...days) : null,
      slowest: days.length ? Math.max(...days) : null,
      byProject: [...byProject.entries()].sort((a, b) => b[1] - a[1]),
      busiest,
      weeks: byWeek.size,
    };
  }

  function fmtDays(d) {
    if (d === null) return "—";
    if (d < 1) return `${Math.max(1, Math.round(d * 24))}h`;
    return `${d < 10 ? d.toFixed(1) : Math.round(d)}d`;
  }

  // #archive-rail itself stretches to fill the grid row (deliberately, so the
  // archive view never strands empty background beside a short list). That
  // makes its own rect useless for anything that needs the content's real
  // height — the guided tour in particular — so everything renders inside
  // this inner wrapper, which sizes to its content like a normal block.
  function renderArchiveRail(archived) {
    const rail = document.getElementById("archive-rail");
    if (!archived.length) {
      rail.innerHTML = `
        <div class="rail-content">
          <div class="rail-title">Throughput</div>
          <div class="rail-empty">Nothing archived yet. Cards move here automatically 7 days after they are marked done, and these figures fill in from their own timestamps.</div>
        </div>
      `;
      return;
    }

    const s = archiveStats(archived);
    const maxProj = Math.max(...s.byProject.map((p) => p[1]));

    rail.innerHTML = `
      <div class="rail-content">
      <div class="rail-title">Throughput</div>

      <div class="rail-figure">
        <b>${fmtDays(s.avgDays)}</b>
        <span>Average time to done</span>
        <em>${s.sample} of ${s.total} archived task${s.total === 1 ? "" : "s"} carried both timestamps</em>
      </div>

      <div class="rail-grid">
        <div class="rail-figure">
          <b>${fmtDays(s.fastest)}</b>
          <span>Fastest</span>
        </div>
        <div class="rail-figure">
          <b>${fmtDays(s.slowest)}</b>
          <span>Slowest</span>
        </div>
      </div>

      <div>
        <div class="rail-title" style="margin-bottom:0.85rem">By project</div>
        <div class="rail-rows">
          ${s.byProject
            .map(([id, n]) => {
              const proj = projectById(id);
              const color = proj ? proj.color : "var(--fg-dim)";
              const name = proj ? escapeHtml(proj.name) : "No project";
              return `
                <div class="rail-row">
                  <span class="swatch" style="background:${color}"></span>
                  <span>${name}</span>
                  <b>${n}</b>
                  <span class="rail-bar"><i style="width:${Math.round((n / maxProj) * 100)}%;background:${color}"></i></span>
                </div>`;
            })
            .join("")}
        </div>
      </div>

      <div class="rail-figure">
        <b>${s.busiest ? s.busiest[1] : 0}</b>
        <span>Busiest week — ${s.busiest ? s.busiest[0] : "—"}</span>
        <em>across ${s.weeks} week${s.weeks === 1 ? "" : "s"} of archive</em>
      </div>
      </div>
    `;
  }

  function isoWeekLabel(iso) {
    const d = new Date(iso);
    const onejan = new Date(d.getFullYear(), 0, 1);
    const week = Math.ceil(((d - onejan) / 86400000 + onejan.getDay() + 1) / 7);
    return `${d.getFullYear()} · WK ${String(week).padStart(2, "0")}`;
  }

  function renderProjectTabs() {
    const wrap = els["project-tabs"];
    wrap.innerHTML = "";
    const allTab = document.createElement("button");
    allTab.className = "tab" + (state.activeProjectId === "all" ? " active" : "");
    allTab.textContent = "ALL";
    allTab.addEventListener("click", () => {
      state.activeProjectId = "all";
      render();
    });
    wrap.appendChild(allTab);

    state.data.projects.forEach((p) => {
      const tab = document.createElement("button");
      tab.className = "tab" + (state.activeProjectId === p.id ? " active" : "");
      tab.style.setProperty("--accent", p.color);
      tab.textContent = p.name;
      tab.addEventListener("click", () => {
        // Filtering to a project also aims quick-add at it — a task created
        // while filtered to Ashoka is assigned to Ashoka.
        state.activeProjectId = p.id;
        render();
      });
      wrap.appendChild(tab);
    });
  }

  function renderProjectModalList() {
    const list = els["project-modal-list"];
    list.innerHTML = "";
    if (!state.data.projects.length) {
      const empty = document.createElement("p");
      empty.className = "project-empty";
      empty.textContent = "None yet — the board shows every task until you add one.";
      list.appendChild(empty);
      return;
    }
    state.data.projects.forEach((p) => {
      const row = document.createElement("div");
      row.className = "project-row";
      row.innerHTML = `
        <span class="swatch" style="background:${p.color}"></span>
        <span class="project-name">${escapeHtml(p.name)}${
          p.description ? `<span class="project-desc">${escapeHtml(p.description)}</span>` : ""
        }</span>
        <button class="btn-icon" data-action="delete" data-id="${p.id}">DEL</button>
      `;
      row.querySelector('[data-action="delete"]').addEventListener("click", () => deleteProject(p.id));
      list.appendChild(row);
    });
  }

  function renderSyncStrip() {
    const labels = {
      synced: "Synced to file",
      "mirror-only": "Local only",
      disconnected: "File disconnected",
      "no-file": "Local only",
    };
    els["sync-strip"].textContent = labels[state.syncStatus];
    els["sync-strip"].dataset.status = state.syncStatus;
    els["reconnect-banner"].hidden = state.syncStatus !== "disconnected";
    document.getElementById("no-file-banner").hidden = state.syncStatus === "synced";
  }

  function render() {
    els["view-board-btn"].classList.toggle("active", state.view === "board");
    els["view-agenda-btn"].classList.toggle("active", state.view === "agenda");
    els["view-archive-btn"].classList.toggle("active", state.view === "archive");
    els["board"].hidden = state.view !== "board";
    document.getElementById("agenda-view").hidden = state.view !== "agenda";
    document.getElementById("archive-view").hidden = state.view !== "archive";

    renderProjectTabs();
    renderSyncStrip();
    renderTelemetry();
    renderSearchState();
    if (state.view === "board") renderBoard();
    else if (state.view === "agenda") renderAgenda();
    else renderArchive();
  }

  function renderSearchState() {
    const q = state.search.trim();
    els["search-clear"].hidden = !q;
    const countEl = els["search-count"];
    if (!q) {
      countEl.hidden = true;
      return;
    }
    // Counts every match, board and archive alike, so the number does not
    // change meaning depending on which view happens to be open.
    const n = state.data.tasks.filter(
      (t) =>
        matchesSearch(t) &&
        (state.activeProjectId === "all" || t.projectId === state.activeProjectId)
    ).length;
    countEl.textContent = `${n} match${n === 1 ? "" : "es"}`;
    countEl.hidden = false;
  }

  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  // ---- card modal -------------------------------------------------------------

  function openCardModal(taskId) {
    const task = state.data.tasks.find((t) => t.id === taskId);
    if (!task) return;
    const modal = els["card-modal"];
    const body = els["card-modal-body"];
    body.innerHTML = `
      <label>TITLE
        <input type="text" id="f-title" value="${escapeHtml(task.title)}">
      </label>
      <div class="field-row">
        <label>PROJECT
          <select id="f-project">
            <option value="">— NONE —</option>
            ${state.data.projects.map((p) => `<option value="${p.id}" ${p.id === task.projectId ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}
          </select>
        </label>
        <label>PRIORITY
          <select id="f-priority">
            ${["high", "med", "low"].map((p) => `<option value="${p}" ${p === task.priority ? "selected" : ""}>${p.toUpperCase()}</option>`).join("")}
          </select>
        </label>
      </div>
      <div class="field-row">
        <label>DUE DATE
          <input type="date" id="f-date" value="${task.dueDate || ""}">
        </label>
        <label>DUE TIME
          <input type="time" id="f-time" value="${task.dueTime || ""}">
        </label>
      </div>

      <div class="qa-field modal-seg-field">
        <span>STATUS</span>
        <div class="seg" id="f-status" role="radiogroup" aria-label="Status">
          ${[["todo", "To do"], ["doing", "In progress"], ["done", "Done"]]
            .map(
              ([v, label]) =>
                `<button type="button" data-v="${v}" role="radio" aria-checked="${v === task.status}" class="${v === task.status ? "on" : ""}">${label}</button>`
            )
            .join("")}
        </div>
      </div>

      <div class="field-row">
        <label>REPEATS
          <select id="f-repeat-every">
            <option value="">Never</option>
            <option value="day" ${task.recurrence?.every === "day" ? "selected" : ""}>Daily</option>
            <option value="week" ${task.recurrence?.every === "week" ? "selected" : ""}>Weekly</option>
            <option value="month" ${task.recurrence?.every === "month" ? "selected" : ""}>Monthly</option>
          </select>
        </label>
        <label>EVERY N
          <input type="number" id="f-repeat-interval" min="1" max="99" value="${task.recurrence?.interval || 1}">
        </label>
      </div>
      <div class="field-note" id="f-repeat-note"></div>

      <label>NOTES
        <textarea id="f-notes" rows="3" placeholder="Links, room numbers, what the task actually asks for">${escapeHtml(task.notes || "")}</textarea>
      </label>

      <label>SUBTASKS
        <div id="f-subtasks"></div>
        <button type="button" id="f-add-subtask" class="btn-secondary">+ Subtask</button>
      </label>
      <div class="modal-actions">
        <button type="button" id="f-delete" class="btn-danger">Delete</button>
        <button type="button" id="f-save" class="btn-primary">Save</button>
      </div>
    `;

    const subtaskWrap = body.querySelector("#f-subtasks");
    function renderSubtasks(list) {
      subtaskWrap.innerHTML = "";
      list.forEach((s, i) => {
        const row = document.createElement("div");
        row.className = "subtask-row";
        row.innerHTML = `
          <input type="checkbox" ${s.done ? "checked" : ""} data-i="${i}" class="sub-done">
          <input type="text" value="${escapeHtml(s.title)}" data-i="${i}" class="sub-title">
          <button type="button" class="sub-remove" data-i="${i}">×</button>
        `;
        subtaskWrap.appendChild(row);
      });
    }
    const localSubtasks = task.subtasks.map((s) => ({ ...s }));
    renderSubtasks(localSubtasks);

    subtaskWrap.addEventListener("change", (e) => {
      const i = +e.target.dataset.i;
      if (e.target.classList.contains("sub-done")) localSubtasks[i].done = e.target.checked;
      if (e.target.classList.contains("sub-title")) localSubtasks[i].title = e.target.value;
    });
    subtaskWrap.addEventListener("click", (e) => {
      if (e.target.classList.contains("sub-remove")) {
        localSubtasks.splice(+e.target.dataset.i, 1);
        renderSubtasks(localSubtasks);
      }
    });
    body.querySelector("#f-add-subtask").addEventListener("click", () => {
      localSubtasks.push({ id: window.Docket.Schema.uuid(), title: "", done: false });
      renderSubtasks(localSubtasks);
    });

    // Status segmented control — the touch path for moving a card, since
    // HTML5 drag events never fire from a finger.
    let pendingStatus = task.status;
    const statusWrap = body.querySelector("#f-status");
    statusWrap.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-v]");
      if (!btn) return;
      statusWrap.querySelectorAll("button").forEach((b) => {
        const on = b === btn;
        b.classList.toggle("on", on);
        b.setAttribute("aria-checked", String(on));
      });
      pendingStatus = btn.dataset.v;
    });

    // Recurrence only means anything with a due date to advance from, so say
    // so inline rather than silently doing nothing on completion.
    const everySel = body.querySelector("#f-repeat-every");
    const intervalInput = body.querySelector("#f-repeat-interval");
    const repeatNote = body.querySelector("#f-repeat-note");
    function paintRepeatNote() {
      const every = everySel.value;
      intervalInput.disabled = !every;
      if (!every) {
        repeatNote.textContent = "";
        repeatNote.hidden = true;
        return;
      }
      const hasDate = !!body.querySelector("#f-date").value;
      repeatNote.textContent = hasDate
        ? "When you mark this done, the next one is created with its due date moved forward."
        : "Set a due date — a repeat needs one to move forward from, or nothing is created.";
      repeatNote.classList.toggle("field-note-warn", !hasDate);
      repeatNote.hidden = false;
    }
    everySel.addEventListener("change", paintRepeatNote);
    body.querySelector("#f-date").addEventListener("change", paintRepeatNote);
    paintRepeatNote();

    body.querySelector("#f-save").addEventListener("click", () => {
      mutate((d) => {
        const t = d.tasks.find((x) => x.id === taskId);
        t.title = body.querySelector("#f-title").value.trim() || t.title;
        t.projectId = body.querySelector("#f-project").value || null;
        t.priority = body.querySelector("#f-priority").value;
        t.dueDate = body.querySelector("#f-date").value || null;
        t.dueTime = body.querySelector("#f-time").value || null;
        t.notes = body.querySelector("#f-notes").value;
        t.subtasks = localSubtasks.filter((s) => s.title.trim());
        const every = everySel.value;
        t.recurrence = every
          ? { every, interval: Math.max(1, Math.min(99, +intervalInput.value || 1)) }
          : null;
        t.updatedAt = nowIso();

        // Status last: applyStatus reads the recurrence and due date we just
        // wrote, so completing and setting a repeat in one save spawns the
        // next occurrence from the new values rather than the old ones.
        applyStatus(d, taskId, pendingStatus);
        Reminders.schedule(d.tasks.find((x) => x.id === taskId));
      });
      closeModal();
    });

    body.querySelector("#f-delete").addEventListener("click", () => {
      const index = state.data.tasks.findIndex((x) => x.id === taskId);
      const removed = state.data.tasks[index];
      mutate((d) => {
        d.tasks = d.tasks.filter((x) => x.id !== taskId);
      });
      Reminders.cancel(taskId);
      closeModal();
      showToast(`Deleted "${removed.title}"`, {
        actionLabel: "Undo",
        duration: 8000,
        onAction: () => {
          // Spliced back at its original index so the card returns where it
          // was, not to the end of the list.
          mutate((d) => d.tasks.splice(Math.min(index, d.tasks.length), 0, removed));
          Reminders.schedule(removed);
          showToast("Restored");
        },
      });
    });

    modal.hidden = false;
  }

  function closeModal() {
    els["card-modal"].hidden = true;
  }

  // ---- project management ------------------------------------------------------

  function deleteProject(id) {
    // Deletion always reassigns affected tasks to "no project" first —
    // never confirm(), per house rule; the reassignment IS the safety net.
    mutate((d) => {
      d.tasks.forEach((t) => {
        if (t.projectId === id) {
          t.projectId = null;
          t.updatedAt = nowIso();
        }
      });
      d.projects = d.projects.filter((p) => p.id !== id);
    });
    if (state.activeProjectId === id) state.activeProjectId = "all";
    renderProjectModalList();
  }

  // ---- wiring ---------------------------------------------------------------

  // Capture is title-only and immediate — no prospective fields to fill in
  // before the task exists. Enter creates it with defaults (no project, med
  // priority, To do) and opens its detail modal right away so deadline,
  // project, priority and subtasks are added to a task that already exists,
  // never staged for one that might not get created.
  function submitQuickAdd() {
    const input = els["quick-add-input"];
    const title = input.value.trim();
    if (!title) return;

    mutate((d) => {
      d.tasks.push(
        makeTask({
          title,
          projectId: state.activeProjectId !== "all" ? state.activeProjectId : null,
        })
      );
    });
    const created = state.data.tasks[state.data.tasks.length - 1];

    input.value = "";
    openCardModal(created.id);
  }

  function wireQuickAdd() {
    const input = els["quick-add-input"];

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submitQuickAdd();
      }
    });

    document.addEventListener("keydown", (e) => {
      const tag = document.activeElement.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if (e.key === "n" && !typing) {
        e.preventDefault();
        input.focus();
      }
      if (e.key === "Escape") {
        closeModal();
        closeProjectModal();
      }
    });
  }

  function wireDragDrop() {
    [els["col-todo"], els["col-doing"], els["col-done"]].forEach((col) => {
      col.addEventListener("dragover", (e) => {
        e.preventDefault();
        col.classList.add("drop-target");
      });
      // dragleave fires when crossing onto a child, so only clear the
      // highlight once the pointer is genuinely outside the column box.
      col.addEventListener("dragleave", (e) => {
        if (!col.contains(e.relatedTarget)) col.classList.remove("drop-target");
      });
      col.addEventListener("drop", (e) => {
        e.preventDefault();
        col.classList.remove("drop-target");
        const id = e.dataTransfer.getData("text/plain");
        const status = col.dataset.status;
        const insertAt = dropIndex(col, e.clientY, id);

        mutate((d) => {
          applyStatus(d, id, status);
          reorderColumn(d, status, id, insertAt);
        });
      });
    });
  }

  // Which slot the pointer is over: the first card whose midpoint is below
  // the cursor. Excludes the dragged card so its own height does not shift
  // the target while it is being moved.
  function dropIndex(col, clientY, draggedId) {
    const cards = [...col.querySelectorAll(".card")].filter((c) => c.dataset.id !== draggedId);
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return i;
    }
    return cards.length;
  }

  // Reassigns 0..n across the whole column on every drop, so order values
  // stay dense integers and no fractional drift accumulates over time.
  function reorderColumn(d, status, movedId, insertAt) {
    const inColumn = d.tasks.filter((t) => t.status === status && !t.archivedAt);
    const others = sortColumn(inColumn.filter((t) => t.id !== movedId));
    const moved = d.tasks.find((t) => t.id === movedId);
    if (!moved) return;
    others.splice(Math.max(0, Math.min(insertAt, others.length)), 0, moved);
    others.forEach((t, i) => {
      t.order = i;
      t.updatedAt = nowIso();
    });
  }

  function wireViews() {
    els["view-board-btn"].addEventListener("click", () => {
      state.view = "board";
      render();
    });
    els["view-agenda-btn"].addEventListener("click", () => {
      state.view = "agenda";
      render();
    });
    els["view-archive-btn"].addEventListener("click", () => {
      state.view = "archive";
      render();
    });
  }

  function wireSearch() {
    const input = els["search-input"];
    input.addEventListener("input", () => {
      state.search = input.value;
      render();
      // render() rebuilds the board but not the input, so focus survives;
      // restore it explicitly anyway in case a future render touches it.
      if (document.activeElement !== input) input.focus();
    });
    els["search-clear"].addEventListener("click", () => {
      state.search = "";
      input.value = "";
      render();
      input.focus();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        state.search = "";
        input.value = "";
        render();
        input.blur();
      }
    });
  }

  // Card keyboard control. Focus a card (Tab, or click) then 1/2/3 to move
  // it between columns — the same applyStatus path a drag uses, so recurrence
  // and doneAt behave identically. Focus is restored to the same task after
  // the re-render so repeated presses keep working.
  function wireCardKeys() {
    const KEY_STATUS = { 1: "todo", 2: "doing", 3: "done" };

    document.addEventListener("keydown", (e) => {
      const card = document.activeElement?.closest?.(".card");
      if (!card) return;
      const id = card.dataset.id;

      if (KEY_STATUS[e.key]) {
        e.preventDefault();
        mutate((d) => applyStatus(d, id, KEY_STATUS[e.key]));
        refocusTask(id);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        openCardModal(id);
      }
    });
  }

  function refocusTask(id) {
    const el = document.querySelector(`.card[data-id="${id}"]`);
    if (el) el.focus();
  }

  // With no stored choice the OS decides (CSS prefers-color-scheme handles the
  // paint); this only needs to report which substrate is actually showing so
  // the toggle can be labelled with it instead of a meaningless "MODE".
  function effectiveTheme() {
    const explicit = document.documentElement.dataset.theme;
    if (explicit) return explicit;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function paintThemeLabel() {
    const t = effectiveTheme();
    els["theme-label"].textContent = t === "dark" ? "Dark" : "Light";
    els["theme-toggle"].title = `Currently ${t} — click for ${t === "dark" ? "light" : "dark"}`;
  }

  function wireTheme() {
    const stored = localStorage.getItem("docket.theme");
    if (stored) document.documentElement.dataset.theme = stored;
    paintThemeLabel();

    els["theme-toggle"].addEventListener("click", () => {
      const next = effectiveTheme() === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      localStorage.setItem("docket.theme", next);
      paintThemeLabel();
    });

    // Follow the OS while the user has not overridden it
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (!localStorage.getItem("docket.theme")) paintThemeLabel();
    });
  }

  // Eight presets covering the hues that stay distinguishable as a 3px tab
  // underline in both themes. The colour input stays for anything else.
  const PROJECT_SWATCHES = [
    "#E61919", "#E67819", "#E6C019", "#3BA55D",
    "#19B8B0", "#2F81F7", "#A371F7", "#8B8B8B",
  ];

  function setProjectColour(hex) {
    els["new-project-color"].value = hex;
    els["project-swatches"].querySelectorAll(".swatch-btn").forEach((b) => {
      b.setAttribute("aria-pressed", String(b.dataset.hex.toLowerCase() === hex.toLowerCase()));
    });
  }

  function renderProjectSwatches() {
    const wrap = els["project-swatches"];
    wrap.innerHTML = "";
    PROJECT_SWATCHES.forEach((hex) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "swatch-btn";
      b.dataset.hex = hex;
      b.style.background = hex;
      b.setAttribute("aria-label", `Colour ${hex}`);
      b.setAttribute("aria-pressed", "false");
      b.addEventListener("click", () => setProjectColour(hex));
      wrap.appendChild(b);
    });
  }

  function projectError(msg) {
    const el = els["project-modal-error"];
    el.textContent = msg || "";
    el.hidden = !msg;
  }

  function openProjectModal() {
    els["new-project-name"].value = "";
    els["new-project-desc"].value = "";
    setProjectColour(PROJECT_SWATCHES[0]);
    projectError("");
    renderProjectModalList();
    els["project-modal"].hidden = false;
    els["new-project-name"].focus();
  }

  function closeProjectModal() {
    els["project-modal"].hidden = true;
  }

  function submitProject() {
    const name = els["new-project-name"].value.trim();
    // Inline message, never alert() — a typo should not cost a modal dismiss.
    if (!name) {
      projectError("Give the project a name.");
      els["new-project-name"].focus();
      return;
    }
    const clash = state.data.projects.some((p) => p.name.toLowerCase() === name.toLowerCase());
    if (clash) {
      projectError(`A project called "${name}" already exists.`);
      els["new-project-name"].focus();
      return;
    }
    const description = els["new-project-desc"].value.trim();
    const color = els["new-project-color"].value;
    mutate((d) => {
      d.projects.push(makeProject({ name, description, color }));
    });
    els["new-project-name"].value = "";
    els["new-project-desc"].value = "";
    projectError("");
    renderProjectModalList();
    showToast(`Project "${name}" added`);
    els["new-project-name"].focus();
  }

  function wireProjects() {
    renderProjectSwatches();
    els["new-project-btn"].addEventListener("click", openProjectModal);
    document.getElementById("project-modal-close").addEventListener("click", closeProjectModal);
    document.getElementById("project-modal-add").addEventListener("click", submitProject);

    // Click the backdrop to dismiss, matching the task modal.
    els["project-modal"].addEventListener("click", (e) => {
      if (e.target === els["project-modal"]) closeProjectModal();
    });

    // Enter anywhere in the two text fields submits.
    [els["new-project-name"], els["new-project-desc"]].forEach((input) => {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          submitProject();
        }
      });
    });

    // A hand-picked colour clears the preset highlight rather than lying
    // about which swatch is active.
    els["new-project-color"].addEventListener("input", () => setProjectColour(els["new-project-color"].value));
  }

  function wireModal() {
    els["card-modal"].addEventListener("click", (e) => {
      if (e.target === els["card-modal"]) closeModal();
    });
    document.getElementById("card-modal-close").addEventListener("click", closeModal);
  }

  function wireReconnect() {
    document.getElementById("reconnect-btn").addEventListener("click", async () => {
      const status = await Storage.requestReconnect();
      state.syncStatus = status;
      render();
    });
    document.getElementById("connect-file-btn").addEventListener("click", async () => {
      try {
        await Storage.connectExistingFile();
        state.syncStatus = "synced";
        Storage.autosave(state.data);
        render();
      } catch (err) {
        console.warn("[docket] connect cancelled", err);
      }
    });
    document.getElementById("new-file-btn").addEventListener("click", async () => {
      try {
        await Storage.createNewFile();
        state.syncStatus = "synced";
        Storage.autosave(state.data);
        render();
      } catch (err) {
        console.warn("[docket] new file cancelled", err);
      }
    });
  }

  function wireDataControls() {
    els["export-btn"].addEventListener("click", () => {
      Storage.exportDownload(state.data);
      showToast("EXPORTED — CHECK YOUR DOWNLOADS");
    });

    els["import-btn"].addEventListener("click", () => els["import-file-input"].click());

    els["import-file-input"].addEventListener("change", async (e) => {
      const file = e.target.files[0];
      e.target.value = ""; // allow re-picking the same file next time
      if (!file) return;
      try {
        const imported = await Storage.importFromFile(file);
        const before = state.data.tasks.length;
        mutate((d) => {
          const merged = Storage.reconcile(d, imported);
          d.projects = merged.projects;
          d.tasks = merged.tasks;
        });
        const added = state.data.tasks.length - before;
        showToast(`IMPORTED — ${added >= 0 ? added : 0} NEW TASK${added === 1 ? "" : "S"}, REST MERGED BY MOST RECENT EDIT`);
        Reminders.rescheduleAll(state.data.tasks);
      } catch (err) {
        showToast(`IMPORT FAILED — ${err.message}`, true);
      }
    });
  }

  function wireNotifications() {
    const perm = Reminders.permissionState();
    els["notif-banner"].hidden = perm !== "default";
    els["notif-enable-btn"].addEventListener("click", async () => {
      await Reminders.requestPermission();
      els["notif-banner"].hidden = true;
      Reminders.rescheduleAll(state.data.tasks);
    });
  }

  async function boot() {
    cacheEls();
    Storage.onSyncStatus = (status) => {
      state.syncStatus = status;
      renderSyncStrip();
    };

    const { data, status } = await Storage.init();
    state.data = data;
    state.syncStatus = status;
    sweepArchive(state.data);

    wireQuickAdd();
    wireDragDrop();
    wireViews();
    wireSearch();
    wireCardKeys();
    wireTheme();
    wireProjects();
    wireModal();
    wireReconnect();
    wireDataControls();
    wireNotifications();

    render();
    Reminders.rescheduleAll(state.data.tasks);
    setInterval(() => mutate(() => {}), SWEEP_INTERVAL_MS);

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("service-worker.js").catch(() => {});
    }
  }

  document.addEventListener("DOMContentLoaded", boot);

  // Minimal surface for guide.js — it needs to switch views to show the
  // archive rail without duplicating the render/state logic above.
  window.Docket.App = {
    goToView(v) {
      state.view = v;
      render();
    },
    currentView: () => state.view,
  };
})();
