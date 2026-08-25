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
      "project-tabs", "quick-add-input", "sync-strip", "reconnect-banner",
      "view-board-btn", "view-archive-btn", "theme-toggle", "new-project-btn",
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

  function cardEl(task) {
    const card = document.createElement("div");
    card.className = "card";
    card.draggable = true;
    card.dataset.id = task.id;
    card.style.setProperty("--accent", (projectById(task.projectId) || {}).color || "var(--fg)");

    const doneSubtasks = task.subtasks.filter((s) => s.done).length;
    const proj = projectById(task.projectId);

    card.innerHTML = `
      <div class="card-top">
        <span class="pill pill-${task.priority}">${task.priority}</span>
        ${proj ? `<span class="pill pill-project" style="border-color:${proj.color}">${proj.name}</span>` : ""}
      </div>
      <div class="card-title">${escapeHtml(task.title)}</div>
      <div class="card-meta">
        ${task.dueDate ? `<span>DUE ${task.dueDate}${task.dueTime ? " " + task.dueTime : ""}</span>` : ""}
        ${task.subtasks.length ? `<span>[${doneSubtasks}/${task.subtasks.length}]</span>` : ""}
      </div>
    `;

    card.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", task.id);
      card.classList.add("dragging");
    });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
    card.addEventListener("click", () => openCardModal(task.id));

    return card;
  }

  function renderColumn(colEl, status) {
    colEl.innerHTML = "";
    const tasks = visibleTasks()
      .filter((t) => t.status === status)
      .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || (a.dueDate || "9999").localeCompare(b.dueDate || "9999"));
    if (!tasks.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "// EMPTY";
      colEl.appendChild(empty);
      return;
    }
    tasks.forEach((t) => colEl.appendChild(cardEl(t)));
  }

  function renderBoard() {
    renderColumn(els["col-todo"], "todo");
    renderColumn(els["col-doing"], "doing");
    renderColumn(els["col-done"], "done");
  }

  function renderArchive() {
    const list = els["archive-list"];
    list.innerHTML = "";
    const archived = state.data.tasks
      .filter((t) => t.archivedAt)
      .sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));

    if (!archived.length) {
      list.innerHTML = `<div class="empty-state">// NO ARCHIVED TASKS</div>`;
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
      section.innerHTML = `<div class="archive-week">[ ${week} ]</div>`;
      const rows = document.createElement("div");
      rows.className = "archive-rows";
      tasks.forEach((t) => {
        const row = document.createElement("div");
        row.className = "archive-row";
        row.innerHTML = `
          <span class="archive-title">${escapeHtml(t.title)}</span>
          <button class="btn-restore" data-id="${t.id}">RESTORE ///</button>
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
      synced: "FILE ● SYNCED",
      "mirror-only": "FILE ○ NOT CONNECTED — LOCAL ONLY",
      disconnected: "FILE ✕ DISCONNECTED — RECONNECT",
      "no-file": "FILE ○ NOT CONNECTED",
    };
    els["sync-strip"].textContent = `>>> ${labels[state.syncStatus]}`;
    els["sync-strip"].dataset.status = state.syncStatus;
    els["reconnect-banner"].hidden = state.syncStatus !== "disconnected";
    document.getElementById("no-file-banner").hidden = state.syncStatus === "synced";
  }

  function render() {
    els["view-board-btn"].classList.toggle("active", state.view === "board");
    els["view-archive-btn"].classList.toggle("active", state.view === "archive");
    els["board"].hidden = state.view !== "board";
    els["archive-list"].hidden = state.view !== "archive";

    renderProjectTabs();
    renderSyncStrip();
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
        <button type="button" id="f-add-subtask" class="btn-secondary">+ SUBTASK</button>
      </label>
      <div class="modal-actions">
        <button type="button" id="f-delete" class="btn-danger">DELETE ///</button>
        <button type="button" id="f-save" class="btn-primary">SAVE ///</button>
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

  function wireQuickAdd() {
    const input = els["quick-add-input"];
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const title = input.value.trim();
      if (!title) return;
      mutate((d) => {
        d.tasks.push(makeTask({ title }));
      });
      input.value = "";
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
      col.addEventListener("dragover", (e) => e.preventDefault());
      col.addEventListener("drop", (e) => {
        e.preventDefault();
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

  function wireTheme() {
    const stored = localStorage.getItem("docket.theme");
    if (stored) document.documentElement.dataset.theme = stored;
    els["theme-toggle"].addEventListener("click", () => {
      const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      localStorage.setItem("docket.theme", next);
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
