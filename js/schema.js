// DOCKET · SCHEMA
// · Whole-file JSON shape for the live file + localStorage mirror
// · SCHEMA_VERSION bumps travel with a migration in loadMirror()/readFile()
// · Factories only — no storage logic here (that's storage.js)
"use strict";

window.Docket = window.Docket || {};

(function () {
  // v2 adds notes, recurrence and order. Nothing was removed or reshaped, so
  // migrate() only has to fill defaults — a v1 file loses nothing.
  const SCHEMA_VERSION = 2;

  function uuid() {
    return crypto.randomUUID();
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function makeTask(overrides) {
    const now = nowIso();
    return Object.assign(
      {
        id: uuid(),
        title: "",
        projectId: null,
        dueDate: null,
        dueTime: null,
        priority: "med",
        status: "todo",
        subtasks: [],
        notes: "",
        recurrence: null, // { every: 'day'|'week'|'month', interval: number }
        order: null,      // null = fall back to the priority/due-date sort
        doneAt: null,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      },
      overrides
    );
  }

  // Fills fields added after a file was written. Runs on every read of the
  // file and of the localStorage mirror, so a v1 file opened in v2 is
  // upgraded in place rather than partially read.
  function migrate(data) {
    if (!data || typeof data !== "object") return null;
    const tasks = (data.tasks || []).map((t) => ({
      notes: "",
      recurrence: null,
      order: null,
      subtasks: [],
      ...t,
    }));
    return {
      schemaVersion: SCHEMA_VERSION,
      projects: data.projects || [],
      tasks,
    };
  }

  function makeProject(overrides) {
    return Object.assign(
      {
        id: uuid(),
        name: "",
        color: "#E61919",
        createdAt: nowIso(),
      },
      overrides
    );
  }

  function makeFile() {
    return { schemaVersion: SCHEMA_VERSION, projects: [], tasks: [] };
  }

  window.Docket.Schema = {
    SCHEMA_VERSION,
    uuid,
    nowIso,
    makeTask,
    makeProject,
    makeFile,
    migrate,
  };
})();
