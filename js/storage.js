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
    if (!a) return b || makeFile();
    if (!b) return a;
    const merge = (listA, listB) => {
      const byId = new Map();
      for (const item of listA || []) byId.set(item.id, item);
      for (const item of listB || []) {
        const existing = byId.get(item.id);
        if (!existing || (item.updatedAt || item.createdAt) > (existing.updatedAt || existing.createdAt)) {
          byId.set(item.id, item);
        }
      }
      return [...byId.values()];
    };
    return {
      schemaVersion: SCHEMA_VERSION,
      projects: merge(a.projects, b.projects),
      tasks: merge(a.tasks, b.tasks),
    };
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
    parse: (text) => migrate(JSON.parse(text)),
    onStatus: (s) => window.Docket.Storage.onSyncStatus?.(toAppStatus(s)),
  });

  const dbSync = window.Docket.TursoSync.create({
    merge: reconcile,
    parse: (text) => migrate(JSON.parse(text)),
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

  function connectExistingFile() {
    return sync.connect({ create: false });
  }

  function createNewFile() {
    return sync.connect({ create: true });
  }

  async function requestReconnect() {
    return toAppStatus(await sync.reconnect());
  }

  // ---- autosave -----------------------------------------------------------

  // Mirror write is synchronous and unconditional on every call — it is the
  // "never lose a task" guard, so it cannot ride the same debounce as the
  // file write (a reload inside the debounce window would otherwise lose
  // whatever hadn't reached localStorage yet). Only the file write, which is
  // the more expensive of the two, is batched.
  function autosave(data) {
    saveMirror(data);
    if (sync.hasFile()) sync.save(data);
    else window.Docket.Storage.onSyncStatus?.("mirror-only");
    if (dbSync.configured()) dbSync.save(data);
  }

  // Pulls Turso in against whatever the folder/mirror settled on, and pushes
  // the result back to Turso. Used at boot and right after a live "Connect
  // database" — same merge, so a database that already has another device's
  // data behaves identically whether you connected at launch or mid-session.
  async function mergeDb(data) {
    const dbR = await dbSync.init(() => data);
    let merged = data;
    if (dbR.status === "synced") {
      if (dbR.data) {
        merged = dbR.data;
        saveMirror(merged);
      }
      await dbSync.flush(merged);
    }
    window.Docket.Storage.onDbStatus?.(dbR.status);
    return { data: merged, from: dbR.from || null };
  }

  async function init() {
    const r = await sync.init(() => loadMirror());

    if (r.status === "corrupt") {
      // Keep running on the mirror and say so. Writing over the file here
      // would destroy the only evidence of what went wrong.
      const data = loadMirror() || makeFile();
      saveMirror(data);
      console.warn("[docket] file will not parse — staying on the browser copy", r.error);
      return { data, status: "corrupt" };
    }

    let data;
    let folderStatus;
    if (r.status !== "synced") {
      // Persist the migrated shape immediately. Without this the mirror keeps
      // its pre-migration form until the first edit, so opening and closing
      // the app would leave an old-schema copy on disk indefinitely.
      data = loadMirror() || makeFile();
      saveMirror(data);
      folderStatus = toAppStatus(r.status);
    } else {
      data = r.data || loadMirror() || makeFile();
      saveMirror(data);
      await sync.writeNow(data);
      folderStatus = "synced";
    }

    // Turso is independent of the folder outcome — a folder that is
    // disconnected or absent must never block the database merge.
    const dbResult = await mergeDb(data);
    data = dbResult.data;
    if (folderStatus === "synced" && dbResult.from) await sync.writeNow(data);

    return { data, status: folderStatus, mergedFrom: r.from || dbResult.from || null };
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
  async function connectDb(url, token, getLocal) {
    await dbSync.connect(url, token); // throws on a bad url/token — the modal shows it
    const result = await mergeDb(getLocal());
    return result.data;
  }

  function disconnectDb() {
    dbSync.forget();
  }

  window.Docket.Storage = {
    init,
    autosave,
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
    flush: (data) => sync.flush(data),
    hasFileHandle: () => sync.hasFile(),
    hasDirHandle: () => sync.hasDir(),
    deviceId: () => sync.deviceId(),
    info: () => sync.info(),
    listConflicts: () => sync.listConflicts(),
    onSyncStatus: null, // set by app.js
    onDbStatus: null, // set by app.js
  };
})();
