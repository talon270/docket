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
    data: { schemaVersion: 1, projects: [], tasks: [] },
    view: "board", // 'board' | 'archive'
    activeProjectId: "all",
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
      "project-popover", "project-popover-list", "new-project-name", "new-project-color",
      "card-modal", "card-modal-body", "notif-banner", "notif-enable-btn",
      "export-btn", "import-btn", "import-file-input", "toast",
    ].forEach((id) => (els[id] = $(id)));
  }

  let toastTimer = null;
  function showToast(message, isError) {
    const el = els["toast"];
    el.textContent = message;
    el.classList.toggle("toast-error", !!isError);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 4000);
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

  function visibleTasks() {
    return state.data.tasks.filter((t) => {
      if (t.archivedAt) return false;
      if (state.activeProjectId !== "all" && t.projectId !== state.activeProjectId) return false;
      return true;
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

  function cardEl(task) {
    const card = document.createElement("div");
    card.className = "card";
    card.draggable = true;
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
      </div>
      <div class="card-title">${escapeHtml(task.title)}</div>
      <div class="card-meta">
        ${task.dueDate ? `<span class="${overdue ? "overdue" : ""}">${task.dueDate}${task.dueTime ? " · " + task.dueTime : ""}</span>` : ""}
        ${task.subtasks.length ? `<span>${doneSubtasks}/${task.subtasks.length} done</span>` : ""}
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
  function renderColumn(bodyEl, countEl, status) {
    bodyEl.innerHTML = "";
    const tasks = visibleTasks()
      .filter((t) => t.status === status)
      .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || (a.dueDate || "9999").localeCompare(b.dueDate || "9999"));

    countEl.textContent = String(tasks.length).padStart(2, "0");

    if (!tasks.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.innerHTML = `${EMPTY_COPY[status].big}<small>${EMPTY_COPY[status].small}</small>`;
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
    const archived = state.data.tasks
      .filter((t) => t.archivedAt)
      .sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));

    renderArchiveRail(archived);

    if (!archived.length) {
      list.innerHTML = `<div class="empty-state">Archive is empty<small>Done cards move here 7 days after completion</small></div>`;
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

  function renderArchiveRail(archived) {
    const rail = document.getElementById("archive-rail");
    if (!archived.length) {
      rail.innerHTML = `
        <div class="rail-title">Throughput</div>
        <div class="rail-empty">Nothing archived yet. Cards move here automatically 7 days after they are marked done, and these figures fill in from their own timestamps.</div>
      `;
      return;
    }

    const s = archiveStats(archived);
    const maxProj = Math.max(...s.byProject.map((p) => p[1]));

    rail.innerHTML = `
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

  function renderProjectPopover() {
    const list = els["project-popover-list"];
    list.innerHTML = "";
    state.data.projects.forEach((p) => {
      const row = document.createElement("div");
      row.className = "popover-row";
      row.innerHTML = `
        <span class="swatch" style="background:${p.color}"></span>
        <span class="popover-name">${escapeHtml(p.name)}</span>
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
    els["view-archive-btn"].classList.toggle("active", state.view === "archive");
    els["board"].hidden = state.view !== "board";
    document.getElementById("archive-view").hidden = state.view !== "archive";

    renderProjectTabs();
    renderSyncStrip();
    renderTelemetry();
    if (state.view === "board") renderBoard();
    else renderArchive();
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

    body.querySelector("#f-save").addEventListener("click", () => {
      mutate((d) => {
        const t = d.tasks.find((x) => x.id === taskId);
        t.title = body.querySelector("#f-title").value.trim() || t.title;
        t.projectId = body.querySelector("#f-project").value || null;
        t.priority = body.querySelector("#f-priority").value;
        t.dueDate = body.querySelector("#f-date").value || null;
        t.dueTime = body.querySelector("#f-time").value || null;
        t.subtasks = localSubtasks.filter((s) => s.title.trim());
        t.updatedAt = nowIso();
        Reminders.schedule(t);
      });
      closeModal();
    });
    body.querySelector("#f-delete").addEventListener("click", () => {
      mutate((d) => {
        d.tasks = d.tasks.filter((x) => x.id !== taskId);
      });
      Reminders.cancel(taskId);
      closeModal();
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
    renderProjectPopover();
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
      if (e.key === "Escape") closeModal();
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
        mutate((d) => {
          const t = d.tasks.find((x) => x.id === id);
          if (!t) return;
          t.status = status;
          t.updatedAt = nowIso();
          t.doneAt = status === "done" ? nowIso() : null;
        });
      });
    });
  }

  function wireViews() {
    els["view-board-btn"].addEventListener("click", () => {
      state.view = "board";
      render();
    });
    els["view-archive-btn"].addEventListener("click", () => {
      state.view = "archive";
      render();
    });
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

  function wireProjects() {
    els["new-project-btn"].addEventListener("click", () => {
      els["project-popover"].hidden = !els["project-popover"].hidden;
      renderProjectPopover();
    });
    document.getElementById("project-popover-add").addEventListener("click", () => {
      const name = els["new-project-name"].value.trim();
      if (!name) return;
      const color = els["new-project-color"].value;
      mutate((d) => {
        d.projects.push(makeProject({ name, color }));
      });
      els["new-project-name"].value = "";
      renderProjectPopover();
    });
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
})();
