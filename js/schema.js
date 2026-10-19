// DOCKET · SCHEMA
// · Whole-file JSON shape for the live file + localStorage mirror
// · SCHEMA_VERSION bumps travel with their migration in migrate()
// · migrate() is also the trust boundary: every read is type-checked here
// · Factories and validation only — no storage logic here (that's storage.js)
"use strict";

window.Docket = window.Docket || {};

(function () {
  // v2 adds notes, recurrence and order. v3 adds project.description.
  // v4 adds a top-level `deleted` list ({ id, at } tombstones) and
  // recurrence.day, the day-of-month a monthly repeat is anchored to — taken
  // from the task's due date on the way in. v4 is also where migrate() starts
  // validating: every field is checked for type, so a hand-edited or hostile
  // file can neither crash render() nor carry markup into innerHTML.
  // Nothing was removed or reshaped at any step — a v1, v2 or v3 file loses
  // nothing, and a field that fails its check falls back to its default
  // rather than taking the whole task with it.
  const SCHEMA_VERSION = 4;

  const DEFAULT_COLOR = "#E61919";
  // The oldest possible timestamp. A task whose updatedAt is missing or
  // garbled gets this, never "now": updatedAt decides the merge, and an
  // invented fresh one would let a broken copy overwrite a real edit.
  const EPOCH = "1970-01-01T00:00:00.000Z";
  const PRIORITIES = ["high", "med", "low"];
  const STATUSES = ["todo", "doing", "done"];
  const REPEATS = ["day", "week", "month"];

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
        recurrence: null, // { every: 'day'|'week'|'month', interval: 1–99, day?: 1–31 }
        order: null,      // null = fall back to the priority/due-date sort
        doneAt: null,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      },
      overrides
    );
  }

  // ---- validation ---------------------------------------------------------
  //
  // migrate() is the one door every copy of the data comes in through — the
  // file, the localStorage mirror, Import and the Turso row — so the checks
  // live here once instead of in every render path.

  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const isId = (v) => typeof v === "string" && v !== "";
  // A number in a hand-edited title is still the user's title; anything
  // that isn't a scalar has no text worth keeping.
  const str = (v) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
  const iso = (v) =>
    typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) && !isNaN(Date.parse(v)) ? v : null;
  const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);
  const dayOfMonth = (v) => (Number.isInteger(v) && v >= 1 && v <= 31 ? v : null);

  function cleanRecurrence(r, dueDate) {
    if (!isObj(r) || !REPEATS.includes(r.every)) return null;
    const n = Math.trunc(Number(r.interval));
    const out = { every: r.every, interval: n >= 1 ? Math.min(99, n) : 1 };
    const day = dayOfMonth(r.day) ?? (r.every === "month" && dueDate ? dayOfMonth(Number(dueDate.slice(8))) : null);
    if (day) out.day = day;
    return out;
  }

  function cleanTask(t) {
    const dueDate = typeof t.dueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t.dueDate) ? t.dueDate : null;
    const createdAt = iso(t.createdAt) || iso(t.updatedAt);
    return {
      ...t,
      title: str(t.title),
      notes: str(t.notes),
      projectId: isId(t.projectId) ? t.projectId : null,
      priority: oneOf(t.priority, PRIORITIES, "med"),
      status: oneOf(t.status, STATUSES, "todo"),
      dueDate,
      dueTime: typeof t.dueTime === "string" && /^\d{2}:\d{2}$/.test(t.dueTime) ? t.dueTime : null,
      // A subtask's id is local to its card, so one missing an id gets a new
      // one rather than being dropped with its title.
      subtasks: (Array.isArray(t.subtasks) ? t.subtasks : []).filter(isObj).map((s) => ({
        ...s,
        id: isId(s.id) ? s.id : uuid(),
        title: str(s.title),
        done: s.done === true,
      })),
      recurrence: cleanRecurrence(t.recurrence, dueDate),
      order: typeof t.order === "number" && isFinite(t.order) ? t.order : null,
      doneAt: iso(t.doneAt),
      archivedAt: iso(t.archivedAt),
      // null, not EPOCH: the archive rail reads createdAt as a start time and
      // already reports tasks that lack one, where a 1970 start would be a lie.
      createdAt,
      updatedAt: iso(t.updatedAt) || createdAt || EPOCH,
    };
  }

  function cleanProject(p) {
    const out = {
      ...p,
      name: str(p.name),
      description: str(p.description),
      color: typeof p.color === "string" && /^#[0-9a-fA-F]{6}$/.test(p.color) ? p.color : DEFAULT_COLOR,
      createdAt: iso(p.createdAt) || iso(p.updatedAt) || EPOCH,
    };
    if (!iso(p.updatedAt)) delete out.updatedAt;
    return out;
  }

  // Runs on every read of the file, the mirror, an import and the database,
  // so a v1 file opened in v4 is upgraded in place rather than partially
  // read. Only an item with no usable id is dropped — without one it can't be
  // merged, edited or deleted, so it could never be anything but a ghost.
  function migrate(data) {
    if (!isObj(data)) return null;
    const list = (v) => (Array.isArray(v) ? v : []).filter((x) => isObj(x) && isId(x.id));
    return {
      schemaVersion: SCHEMA_VERSION,
      projects: list(data.projects).map(cleanProject),
      tasks: list(data.tasks).map(cleanTask),
      deleted: list(data.deleted).filter((e) => iso(e.at)),
    };
  }

  function makeProject(overrides) {
    return Object.assign(
      {
        id: uuid(),
        name: "",
        description: "",
        color: DEFAULT_COLOR,
        createdAt: nowIso(),
      },
      overrides
    );
  }

  function makeFile() {
    return { schemaVersion: SCHEMA_VERSION, projects: [], tasks: [], deleted: [] };
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
