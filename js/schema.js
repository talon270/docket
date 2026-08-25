// DOCKET · SCHEMA
// · Whole-file JSON shape for the live file + localStorage mirror
// · SCHEMA_VERSION bumps travel with a migration in loadMirror()/readFile()
// · Factories only — no storage logic here (that's storage.js)
"use strict";

window.Docket = window.Docket || {};

(function () {
  const SCHEMA_VERSION = 1;

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
        doneAt: null,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      },
      overrides
    );
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
  };
})();
