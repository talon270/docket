// DOCKET · STORAGE
// · Three copies of the truth: live file (File System Access) → localStorage
//   mirror → rolling timestamped backups next to the file. Guard: never lose
//   a task, so the mirror is written independently on every mutation, not as
//   a cache of the file — it stays current even if the file write fails.
// · Handles, permissions, file IO, backups, conflict detection and the
//   focus-refresh live in vendor/sync.js, shared with the other apps. What
//   stays here is what only Docket knows: the mirror, reconcile(), and the
//   manual export/import path.
// · Turso (js/turso.js) is a second, independent remote — folder and
//   database each connect, sync and fail on their own. A database write
//   failure never touches folder status, and vice versa (see PLAN-turso.md).
// · Public surface: window.Docket.Storage
"use strict";

window.Docket = window.Docket || {};

(function () {
  const { SCHEMA_VERSION, makeFile, migrate } = window.Docket.Schema;
  const MIRROR_KEY = "docket.v1";

  // ---- mirror -------------------------------------------------------------

  function saveMirror(data) {
    localStorage.setItem(MIRROR_KEY, JSON.stringify(data));
  }

  function loadMirror() {
    const raw = localStorage.getItem(MIRROR_KEY);
    if (!raw) return null;
    try {
      return migrate(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  // ---- reconcile: most recent updatedAt per task/project wins -------------
  //
  // Docket's half of the merge, and the reason merge() is not in sync.js:
  // only this file knows that a Docket document is two id-keyed lists.

  function reconcile(a, b) {
    // A lone copy still goes through the filter below: a hand-edited file can
    // hold a task alongside its own newer tombstone.
    a = a || makeFile();
    b = b || makeFile();
    const merge = (listA, listB, when) => {
      const byId = new Map();
      for (const item of listA || []) byId.set(item.id, item);
      for (const item of listB || []) {
        const existing = byId.get(item.id);
        if (!existing || when(item) > when(existing)) byId.set(item.id, item);
      }
      return [...byId.values()];
    };
    const edited = (x) => x.updatedAt || x.createdAt;
    // Tombstones ride through every merge, newest `at` per id. A merge that
    // dropped them would forget a delete the first time two copies met.
    const deleted = merge(a.deleted, b.deleted, (e) => e.at);
    // A delete is otherwise just an absence, and a union of ids fills every
    // absence from whichever copy still has the item (A5). An item survives
    // its tombstone only if it was edited after it — which is how Undo, and
    // an edit on a device that never saw the delete, win it back. Filtering
    // here, not in a renderer, means every path in (boot, adopt, focus
    // refresh, Turso, import, another tab) gets it and state.data never
    // holds a tombstoned item.
    // ponytail: the list only grows, ~60 bytes per delete. Pruning after N
    // days would let a device offline for longer than N resurrect its copies,
    // so it stays unpruned until the size actually matters.
    const tomb = new Map(deleted.map((e) => [e.id, e.at]));
    const alive = (x) => !tomb.has(x.id) || edited(x) > tomb.get(x.id);
    return {
      schemaVersion: SCHEMA_VERSION,
      projects: merge(a.projects, b.projects, edited).filter(alive),
      tasks: merge(a.tasks, b.tasks, edited).filter(alive),
      deleted,
    };
  }

  // Merged output is compared with what was read before it is written back:
  // a write that changes nothing still costs a backup (A7).
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // Valid JSON that isn't a Docket document — `null`, an array — must fail
  // like a syntax error. migrate() hands back null for it, and sync.js reads
  // a null as "empty file" and would write the board over it.
  function parse(text) {
    const data = migrate(JSON.parse(text));
    if (!data) throw new Error("not a Docket file");
    return data;
  }

  // ---- the shared sync layer ----------------------------------------------

  const sync = window.Sync.create({
    appId: "docket",
    fileName: "docket.json",
    dbName: "docket-handles",
    backupPrefix: "docket.backup-",
    // 400ms rather than the shared default: the quick-add bar is built for
    // capturing a task per keystroke, so the window between two adds is
    // genuinely short and a slower debounce would feel like lag on the strip.
    writeDebounceMs: 400,
    merge: reconcile,
    parse,
    onStatus: (s) => window.Docket.Storage.onSyncStatus?.(toAppStatus(s)),
  });

  const dbSync = window.Docket.TursoSync.create({
    merge: reconcile,
    parse,
    writeDebounceMs: 400,
    onStatus: (s) => window.Docket.Storage.onDbStatus?.(s),
  });

  // sync.js speaks in folders; Docket's UI has always spoken in files. Map
  // rather than rename, so the strip keeps saying what the user already
  // learned it means. "corrupt" is passed through as itself — a file that
  // will not parse is not the same problem as one that is disconnected, and
  // showing them with one label would hide the worse of the two.
  function toAppStatus(s) {
    if (s === "no-folder") return "no-file";
    return s;
  }

  // ---- connect ------------------------------------------------------------

  // True while the folder's file is live but hasn't been read successfully:
  // from the moment a connect or reconnect starts until adopt() reads it,
  // and from a boot that found it unparseable until a later adopt() parses
  // it. Nothing writes the file while it's set. Set before the picker opens,
  // not after, because sync.js swaps the handle in before connect() returns,
  // and any save in that gap would carry the board that never saw the file.
  let fileUnread = false;

  // A cancelled or failed connect leaves the old handle in place, so the
  // gate goes back to what it was.
  function acquire(connect) {
    const was = fileUnread;
    fileUnread = true;
    return connect().catch((err) => {
      fileUnread = was;
      throw err;
    });
  }

  function connectExistingFile() {
    return acquire(() => sync.connect({ create: false }));
  }

  function createNewFile() {
    return acquire(() => sync.connect({ create: true }));
  }

  async function requestReconnect() {
    return toAppStatus(await acquire(() => sync.reconnect()));
  }

  // Every path that acquires a folder awaits this before the file is
  // written: read, merge, mirror, then write only if the merge added
  // something. On a new laptop the file is the only copy, so a connect that
  // wrote first (A1) replaced it with an empty board.
  //
  // getLocal, not a value: the focus-refresh that fires when the picker
  // closes can replace the app's board while the read is in flight, and the
  // merge has to see that board, not the one from before the await. Nothing
  // is awaited between the merge and the return, so no edit can land in the
  // pre-merge board after it was read.
  async function adopt(getLocal) {
    const report = (s) => window.Docket.Storage.onSyncStatus?.(s);
    let onDisk;
    try {
      onDisk = await sync.readFile();
    } catch (err) {
      // Same rule as a corrupt file at boot: leave it as evidence, keep the
      // gate shut, and say so on the strip.
      console.warn("[docket] file will not parse — staying on the browser copy", err);
      fileUnread = true;
      report("corrupt");
      return getLocal();
    }
    const merged = reconcile(onDisk, getLocal());
    saveMirror(merged);
    fileUnread = false;
    if (!same(merged, onDisk)) sync.flush(merged);
    // sync.js only reports a change of its own status, and it was already
    // "synced" while the app showed "corrupt" — so say it here.
    report(toAppStatus(sync.status()));
    return merged;
  }

  // ---- autosave -----------------------------------------------------------

  // Mirror write is synchronous and unconditional on every call — it is the
  // "never lose a task" guard, so it cannot ride the same debounce as the
  // file write (a reload inside the debounce window would otherwise lose
  // whatever hadn't reached localStorage yet). Only the file write, which is
  // the more expensive of the two, is batched.
  function autosave(data) {
    saveMirror(data);
    if (!sync.hasFile()) {
      // A handle that lost its permission is still "disconnected", and the
      // red Reconnect banner is keyed to that word. Reporting "mirror-only"
      // here hid it on the first edit (A9).
      if (sync.status() !== "disconnected") window.Docket.Storage.onSyncStatus?.("mirror-only");
    } else if (!fileUnread) sync.save(data);
    if (dbSync.configured()) dbSync.save(data);
  }

  // Pulls Turso in against the live board and pushes the result back. Used
  // at boot and right after a live "Connect database" — same merge, so a
  // database that already has another device's data behaves identically
  // whether you connected at launch or mid-session.
  //
  // apply() runs before any write is awaited: the flush is a network round
  // trip, and a board handed back after it would drop whatever was captured
  // during it. Nothing is awaited between dbSync.init()'s getLocal() and the
  // apply, so no edit can land in between.
  async function mergeDb(getLocal, apply) {
    const dbR = await dbSync.init(getLocal);
    window.Docket.Storage.onDbStatus?.(dbR.status);
    if (dbR.status !== "synced") return getLocal();
    const local = getLocal();
    const data = dbR.data || local;
    if (!same(data, local)) {
      saveMirror(data);
      apply(data);
      // The folder gets what the database brought, behind the same gate as
      // autosave(): a file that hasn't been read is never written.
      if (sync.hasFile() && !fileUnread) sync.save(data);
    }
    await dbSync.flush(data);
    return data;
  }

  // The mirror, migrated, for the first render. Persisted immediately:
  // without this the mirror keeps its pre-migration form until the first
  // edit, so opening and closing the app would leave an old-schema copy on
  // disk indefinitely.
  function loadLocal() {
    const data = loadMirror() || makeFile();
    saveMirror(data);
    return data;
  }

  // Runs after the board is already on screen from loadLocal(), so it never
  // holds up capture (A11): the folder and the database each merge against
  // the live board and hand their result to apply() as it arrives, the
  // folder without waiting on the network.
  async function init(getLocal, apply) {
    const report = (s) => window.Docket.Storage.onSyncStatus?.(s);
    // Shut from before the handle is restored until the file has been read:
    // sync.init() swaps the handle in first, and an edit's debounced save in
    // that gap would carry a board that never saw the file (A1).
    fileUnread = true;
    const r = await sync.init();

    if (r.status === "corrupt") {
      // Keep running on the mirror and say so. Writing over the file would
      // destroy the only evidence of what went wrong — and so would the
      // first edit's autosave, which is what the gate is for (A6). The
      // database still merges below: its row is not the file's problem.
      console.warn("[docket] file will not parse — staying on the browser copy", r.error);
      report("corrupt");
    } else {
      fileUnread = false;
      if (r.status === "synced") {
        const data = reconcile(r.data, getLocal());
        saveMirror(data);
        apply(data);
        // Only when the merge brought something the file lacks. Every page
        // load used to write, and sync.js forgets its backup spacing on
        // reload, so ten loads pushed out ten backups of one moment (A7).
        if (!same(data, r.data)) await sync.flush(data);
      }
      report(toAppStatus(sync.status()));
    }

    // Turso is independent of the folder outcome — a folder that is
    // disconnected, absent or corrupt must never block the database merge.
    const data = await mergeDb(getLocal, apply);
    return { data, status: r.status === "corrupt" ? "corrupt" : toAppStatus(sync.status()) };
  }

  // ---- refresh on focus ---------------------------------------------------
  //
  // A tab left open on this machine has no idea another machine wrote the
  // file. Without this its next autosave writes stale state over fresh, which
  // is the exact failure reconcile() exists to prevent — and reconcile only
  // ran at startup until now.

  function watch(getLocal, apply, isBusy) {
    sync.watch(getLocal, (merged) => {
      saveMirror(merged);
      apply(merged);
    }, isBusy);
    dbSync.watch(getLocal, (merged) => {
      saveMirror(merged);
      apply(merged);
    }, isBusy);
  }

  // ---- manual export / import ----------------------------------------------
  // Plain Blob download + <input type=file> read — no File System Access
  // permission needed, works in any browser. This is the backup/restore path;
  // "connect existing" / "create new" (above) is the live-source path.

  function exportDownload(data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .replace("T", "-")
      .slice(0, 19);
    const a = document.createElement("a");
    a.href = url;
    a.download = `docket-export-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function importFromFile(file) {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.tasks) || !Array.isArray(parsed.projects)) {
      throw new Error("not a valid Docket export");
    }
    // An export taken before v2 is a valid file — migrate it on the way in
    // rather than letting undefined fields reach the render code.
    return migrate(parsed);
  }

  // Connecting mid-session runs the same folder-independent merge boot() runs
  // at init() — a database that already has another device's data behaves
  // the same whether you connected at launch or from the credentials modal.
  async function connectDb(url, token, getLocal, apply) {
    await dbSync.connect(url, token); // throws on a bad url/token — the modal shows it
    return mergeDb(getLocal, apply || (() => {}));
  }

  function disconnectDb() {
    dbSync.forget();
  }

  window.Docket.Storage = {
    init,
    loadLocal,
    autosave,
    adopt,
    watch,
    connectExistingFile,
    createNewFile,
    requestReconnect,
    exportDownload,
    importFromFile,
    reconcile,
    connectDb,
    disconnectDb,
    dbConfigured: () => dbSync.configured(),
    dbInfo: () => dbSync.info(),
    // Exposed for the Hub and for tests: a refresh that can be asked for
    // rather than only triggered by focus.
    refresh: (getLocal, apply) =>
      sync.refresh(getLocal, (merged) => {
        saveMirror(merged);
        apply(merged);
      }),
    // Behind the same gate as autosave(): a forced write is still a write.
    flush: (data) => (fileUnread ? Promise.resolve(false) : sync.flush(data)),
    hasFileHandle: () => sync.hasFile(),
    hasDirHandle: () => sync.hasDir(),
    deviceId: () => sync.deviceId(),
    info: () => sync.info(),
    listConflicts: () => sync.listConflicts(),
    onSyncStatus: null, // set by app.js
    onDbStatus: null, // set by app.js
  };
})();
