// DOCKET · STORAGE
// · Three copies of the truth: live file (File System Access) → localStorage
//   mirror → rolling timestamped backups next to the file. Guard: never lose
//   a task, so the mirror is written independently on every mutation, not as
//   a cache of the file — it stays current even if the file write fails.
// · Public surface: window.Docket.Storage
"use strict";

window.Docket = window.Docket || {};

(function () {
  const { SCHEMA_VERSION, makeFile, migrate } = window.Docket.Schema;
  const MIRROR_KEY = "docket.v1";
  const DB_NAME = "docket-handles";
  const DB_STORE = "handles";
  const HANDLE_KEY = "file";
  const BACKUP_KEEP = 10;

  let fileHandle = null;
  let dirHandle = null;
  let writeTimer = null;

  // ---- IndexedDB handle persistence -------------------------------------

  function openHandleDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function saveHandle(handle) {
    const db = await openHandleDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).put(handle, HANDLE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function loadHandle() {
    const db = await openHandleDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readonly");
      const req = tx.objectStore(DB_STORE).get(HANDLE_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

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

  // ---- file read/write ----------------------------------------------------

  async function readFile(handle) {
    const file = await handle.getFile();
    const text = await file.text();
    if (!text.trim()) return makeFile();
    return migrate(JSON.parse(text));
  }

  async function writeFile(handle, data) {
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(data, null, 2));
    await writable.close();
  }

  // ---- reconcile: most recent updatedAt per task/project wins -------------

  function reconcile(a, b) {
    if (!a) return b || makeFile();
    if (!b) return a;
    const merge = (listA, listB) => {
      const byId = new Map();
      for (const item of listA) byId.set(item.id, item);
      for (const item of listB) {
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

  // ---- backups --------------------------------------------------------------

  async function writeBackup(data) {
    if (!dirHandle) return;
    try {
      const backups = await dirHandle.getDirectoryHandle("backups", { create: true });
      const stamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .replace("T", "-")
        .slice(0, 19);
      const backupHandle = await backups.getFileHandle(`docket.backup-${stamp}.json`, { create: true });
      await writeFile(backupHandle, data);

      const names = [];
      for await (const [name] of backups.entries()) names.push(name);
      names.sort();
      const excess = names.length - BACKUP_KEEP;
      for (let i = 0; i < excess; i++) await backups.removeEntry(names[i]);
    } catch (err) {
      console.warn("[docket] backup write failed", err);
    }
  }

  // ---- connect / autosave ---------------------------------------------------

  async function connectExistingFile() {
    const [handle] = await window.showOpenFilePicker({
      types: [{ description: "Docket file", accept: { "application/json": [".json"] } }],
    });
    fileHandle = handle;
    dirHandle = null; // directory handle not exposed by showOpenFilePicker; backups skipped until createNewFile flow
    await saveHandle(handle);
    return handle;
  }

  async function createNewFile() {
    const handle = await window.showSaveFilePicker({
      suggestedName: "docket.json",
      types: [{ description: "Docket file", accept: { "application/json": [".json"] } }],
    });
    fileHandle = handle;
    await saveHandle(handle);
    return handle;
  }

  function debounce(fn, ms) {
    return (...args) => {
      clearTimeout(writeTimer);
      writeTimer = setTimeout(() => fn(...args), ms);
    };
  }

  const writeFileDebounced = debounce(async (data) => {
    if (fileHandle) {
      try {
        await writeFile(fileHandle, data);
        await writeBackup(data);
        window.Docket.Storage.onSyncStatus?.("synced");
      } catch (err) {
        console.warn("[docket] file write failed", err);
        window.Docket.Storage.onSyncStatus?.("disconnected");
      }
    } else {
      window.Docket.Storage.onSyncStatus?.("mirror-only");
    }
  }, 400);

  // Mirror write is synchronous and unconditional on every call — it is the
  // "never lose a task" guard, so it cannot ride the same debounce as the
  // file write (a reload inside the debounce window would otherwise lose
  // whatever hadn't reached localStorage yet). Only the file write, which is
  // the more expensive of the two, is batched.
  function autosave(data) {
    saveMirror(data);
    writeFileDebounced(data);
  }

  async function init() {
    const handle = await loadHandle().catch(() => null);
    if (!handle) {
      // Persist the migrated shape immediately. Without this the mirror keeps
      // its pre-migration form until the first edit, so opening and closing
      // the app would leave an old-schema copy on disk indefinitely.
      const data = loadMirror() || makeFile();
      saveMirror(data);
      return { data, status: "no-file" };
    }
    fileHandle = handle;
    const perm = await handle.queryPermission({ mode: "readwrite" }).catch(() => "denied");
    if (perm !== "granted") {
      const data = loadMirror() || makeFile();
      saveMirror(data);
      return { data, status: "disconnected" };
    }
    const fileData = await readFile(handle).catch(() => null);
    const mirrorData = loadMirror();
    const reconciled = reconcile(fileData, mirrorData);
    saveMirror(reconciled);
    await writeFile(handle, reconciled).catch(() => {});
    return { data: reconciled, status: "synced" };
  }

  async function requestReconnect() {
    const handle = await loadHandle().catch(() => null);
    if (!handle) return "no-file";
    const perm = await handle.requestPermission({ mode: "readwrite" }).catch(() => "denied");
    if (perm !== "granted") return "disconnected";
    fileHandle = handle;
    return "synced";
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

  window.Docket.Storage = {
    init,
    autosave,
    connectExistingFile,
    createNewFile,
    requestReconnect,
    exportDownload,
    importFromFile,
    reconcile,
    hasFileHandle: () => !!fileHandle,
    onSyncStatus: null, // set by app.js
  };
})();
