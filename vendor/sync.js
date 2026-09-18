/* VENDORED from Hub/shared/sync.js on 2026-08-26 — do not edit here.
   Edit the canonical copy and run: sh Hub/tools/sync-vendor.sh */
/* ==========================================================================
   SYNC · folder-backed multi-device sync

   The shared half of the sync design: everything that is true regardless of
   which app is using it. Vendored into each app by Hub/tools/sync-vendor.sh —
   never edited in place inside an app's vendor/ folder.

     · HANDLES        directory + file handle, persisted in IndexedDB
     · PERMISSIONS    query / request, once per browsing session
     · READ + WRITE   debounced, stamped with deviceId and writtenAt
     · BACKUPS        rolling, capped, and spaced in time
     · REFRESH        re-read and merge when the tab regains focus
     · CONFLICTS      find the sync tool's conflict files; never resolve them
     · DEVICE ID      stable per machine, deliberately never synced

   What is NOT here: merge(). Only the app knows that a running timer must not
   sync, or that "last done" is a maximum rather than a comparison. That was
   the hardest-won lesson in Study/PLAN-server-sync.md and it does not
   generalise. Each app supplies its own.

   Public namespace: window.Sync  —  Sync.create(options) -> instance
   ========================================================================== */
"use strict";

window.Sync = (function () {
  /* ======================================================================
     CONSTANTS
     ====================================================================== */

  /* Ten snapshots taken inside one burst of typing are ten copies of the same
     minute: they satisfy the counter, protect nothing, and evict the older
     states that would actually let you recover. Spacing is what makes the
     depth mean something — 10 × 5min of history at worst, days of it in
     normal use. */
  var BACKUP_KEEP = 10;
  var BACKUP_MIN_INTERVAL_MS = 5 * 60 * 1000;

  /* The file write is the expensive half; the app's own in-browser copy is
     the crash guard and must never ride this debounce. */
  var WRITE_DEBOUNCE_MS = 800;

  /* A device name is a label, not an identity — it exists so the Hub can say
     "last written by mac" instead of showing a bare timestamp. It lives in
     localStorage and NOT in the synced file: stored in the file, the first
     machine to write would export its id and every other machine would adopt
     it on first merge, making all three claim the same name. */
  var DEVICE_KEY = "sync.deviceId";

  /* Syncthing:  name.sync-conflict-20260825-140322-K3RT9QP.json
     Dropbox:    name (conflicted copy 2026-08-25).json
     Both are matched because the folder is the user's, and they may not be
     running what we recommended. */
  var CONFLICT_RE = /\.sync-conflict-(\d{8})-(\d{6})-([A-Z0-9]+)\.|\(conflicted copy[^)]*\)/i;

  /* ======================================================================
     DEVICE IDENTITY
     ====================================================================== */

  function guessPlatform() {
    var p = (navigator.userAgentData && navigator.userAgentData.platform) ||
            navigator.platform || "";
    if (/mac/i.test(p)) return "mac";
    if (/win/i.test(p)) return "windows";
    if (/linux|x11/i.test(p)) return "linux";
    return "device";
  }

  function deviceId() {
    var id = null;
    try { id = localStorage.getItem(DEVICE_KEY); } catch (e) {}
    if (id) return id;
    id = guessPlatform() + "-" + Math.random().toString(36).slice(2, 6);
    try { localStorage.setItem(DEVICE_KEY, id); } catch (e) {}
    return id;
  }

  function renameDevice(name) {
    var clean = String(name || "").trim().slice(0, 24);
    if (!clean) return deviceId();
    try { localStorage.setItem(DEVICE_KEY, clean); } catch (e) {}
    return clean;
  }

  /* ======================================================================
     HANDLE PERSISTENCE
     ---------------------------------------------------------------------
     File System Access handles survive a reload only if they are put in
     IndexedDB — localStorage cannot hold them. Chrome still asks the user to
     re-confirm once per browsing session; that is a click, not a re-pick,
     and there is no way to opt out of it.
     ====================================================================== */

  function openDB(dbName, store) {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function idbPut(dbName, store, key, value) {
    return openDB(dbName, store).then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(store, "readwrite");
        tx.objectStore(store).put(value, key);
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function idbGet(dbName, store, key) {
    return openDB(dbName, store).then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(store, "readonly");
        var req = tx.objectStore(store).get(key);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  /* ======================================================================
     THE INSTANCE
     ====================================================================== */

  function create(opts) {
    var appId = opts.appId;                       // "docket", "wellness-hub"
    var fileName = opts.fileName;                 // "docket.json"
    var dbName = opts.dbName || appId + "-sync";
    var store = "handles";
    var backupPrefix = opts.backupPrefix || appId + ".backup-";

    var merge = opts.merge;                       // required, app-specific
    var serialize = opts.serialize || function (d) { return JSON.stringify(d, null, 2); };
    var parse = opts.parse || function (t) { return JSON.parse(t); };
    var onStatus = opts.onStatus || function () {};
    var onRemoteChange = opts.onRemoteChange || function () {};

    var backupKeep = opts.backupKeep || BACKUP_KEEP;
    var backupInterval = opts.backupMinIntervalMs != null
      ? opts.backupMinIntervalMs : BACKUP_MIN_INTERVAL_MS;
    var debounceMs = opts.writeDebounceMs != null ? opts.writeDebounceMs : WRITE_DEBOUNCE_MS;

    var dirHandle = null;
    var fileHandle = null;
    var writeTimer = null;
    var lastBackupAt = 0;
    var lastWriteAt = null;
    var lastReadAt = null;
    var lastError = null;
    var status = "no-folder";

    function setStatus(s) {
      if (s === status) return;
      status = s;
      try { onStatus(s); } catch (e) {}
    }

    /* ---- connect ----------------------------------------------------- */

    /* One grant, both handles. A file picker hands back a file with no way to
       reach its parent folder, which is why backups need the directory picker
       rather than a second prompt. Fixing the filename is what lets three
       machines point at the same synced folder and land on the same file
       without being told which one. */
    function connect(options) {
      var create_ = !!(options && options.create);
      if (!window.showDirectoryPicker) {
        return Promise.reject(new Error("This browser has no File System Access. Chromium desktop only."));
      }
      return window.showDirectoryPicker({ mode: "readwrite", id: "sync-folder" })
        .then(function (dir) {
          return dir.getFileHandle(fileName, { create: create_ }).then(function (file) {
            dirHandle = dir;
            fileHandle = file;
            setStatus("synced");
            return Promise.all([
              idbPut(dbName, store, "dir", dir).catch(function () {}),
              idbPut(dbName, store, "file", file).catch(function () {})
            ]).then(function () { return file; });
          });
        });
    }

    function permission(handle, mode) {
      if (!handle) return Promise.resolve("denied");
      return handle.queryPermission({ mode: mode }).catch(function () { return "denied"; });
    }

    /* Restore both handles. A profile connected before this module existed
       may have a file handle and no directory handle: it keeps working, it
       simply cannot write backups until the folder is reconnected. hasDir()
       is what lets the UI say so, instead of failing quietly — which is
       exactly how the dead-backup bug survived unnoticed. */
    function restore() {
      return Promise.all([
        idbGet(dbName, store, "dir").catch(function () { return null; }),
        idbGet(dbName, store, "file").catch(function () { return null; })
      ]).then(function (pair) {
        var dir = pair[0], file = pair[1];
        if (!dir && !file) { setStatus("no-folder"); return "no-folder"; }
        return Promise.all([permission(dir, "readwrite"), permission(file, "readwrite")])
          .then(function (perms) {
            dirHandle = perms[0] === "granted" ? dir : null;
            fileHandle = perms[1] === "granted" ? file : null;
            if (!fileHandle) { setStatus("disconnected"); return "disconnected"; }
            setStatus("synced");
            return "synced";
          });
      });
    }

    /* Must be called from a user gesture — Chrome will not prompt otherwise.
       Both handles are re-granted in the same gesture, because a reconnect
       that restored only the file would leave backups silently off for the
       rest of the session. */
    function reconnect() {
      return Promise.all([
        idbGet(dbName, store, "dir").catch(function () { return null; }),
        idbGet(dbName, store, "file").catch(function () { return null; })
      ]).then(function (pair) {
        var dir = pair[0], file = pair[1];
        if (!dir && !file) { setStatus("no-folder"); return "no-folder"; }
        var asks = [];
        if (dir) asks.push(dir.requestPermission({ mode: "readwrite" }).catch(function () { return "denied"; }));
        else asks.push(Promise.resolve("denied"));
        if (file) asks.push(file.requestPermission({ mode: "readwrite" }).catch(function () { return "denied"; }));
        else asks.push(Promise.resolve("denied"));
        return Promise.all(asks).then(function (perms) {
          dirHandle = perms[0] === "granted" ? dir : null;
          fileHandle = perms[1] === "granted" ? file : null;
          if (!fileHandle && dirHandle) {
            // The folder is enough: re-derive the file from it.
            return dirHandle.getFileHandle(fileName, { create: true }).then(function (f) {
              fileHandle = f;
              return idbPut(dbName, store, "file", f).catch(function () {});
            }).then(function () { setStatus("synced"); return "synced"; });
          }
          setStatus(fileHandle ? "synced" : "disconnected");
          return fileHandle ? "synced" : "disconnected";
        });
      });
    }

    /* Drop both grants. Nothing on disk is touched — unlinking is about this
       browser forgetting the folder, never about removing the user's data. */
    function forget() {
      dirHandle = null;
      fileHandle = null;
      setStatus("no-folder");
      return Promise.all([
        idbPut(dbName, store, "dir", null).catch(function () {}),
        idbPut(dbName, store, "file", null).catch(function () {})
      ]).then(function () { return true; });
    }

    /* ---- read / write ------------------------------------------------ */

    function readFile() {
      if (!fileHandle) return Promise.resolve(null);
      return fileHandle.getFile()
        .then(function (f) { return f.text(); })
        .then(function (text) {
          lastReadAt = new Date().toISOString();
          if (!text || !text.trim()) return null;
          return parse(text);
        })
        .catch(function (err) {
          /* A parse failure must never be laundered into "no data". Returning
             null here would let the caller merge against nothing and then
             write that nothing back over a file that is merely corrupt. */
          lastError = String((err && err.message) || err);
          throw err;
        });
    }

    function writeNow(data) {
      if (!fileHandle) { setStatus("no-folder"); return Promise.resolve(false); }
      return permission(fileHandle, "readwrite").then(function (p) {
        if (p !== "granted") {
          /* Silent here is correct: prompting needs a user gesture we do not
             have. The app's banner is what surfaces it. */
          lastError = "permission-needed";
          setStatus("disconnected");
          return false;
        }
        var stamped = stamp(data);
        return fileHandle.createWritable()
          .then(function (w) {
            return w.write(serialize(stamped)).then(function () { return w.close(); });
          })
          .then(function () {
            lastWriteAt = new Date().toISOString();
            lastError = null;
            setStatus("synced");
            return writeBackup(stamped).then(function () { return true; });
          });
      }).catch(function (err) {
        lastError = String((err && err.message) || err);
        setStatus("disconnected");
        return false;
      });
    }

    function stamp(data) {
      var out = {};
      Object.keys(data || {}).forEach(function (k) { out[k] = data[k]; });
      out.deviceId = deviceId();
      out.writtenAt = new Date().toISOString();
      return out;
    }

    function save(data) {
      if (writeTimer) clearTimeout(writeTimer);
      writeTimer = setTimeout(function () {
        writeTimer = null;
        writeNow(data);
      }, debounceMs);
    }

    function flush(data) {
      if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
      return writeNow(data);
    }

    /* ---- backups ------------------------------------------------------ */

    function writeBackup(data) {
      if (!dirHandle) return Promise.resolve(false);
      var now = Date.now();
      if (lastBackupAt && now - lastBackupAt < backupInterval) return Promise.resolve(false);
      lastBackupAt = now;

      /* Milliseconds, not seconds: two writes inside the same second collide
         on the filename and silently overwrite each other. */
      var s = new Date(now).toISOString().replace(/[:.]/g, "-").replace("T", "-").slice(0, 23);

      return dirHandle.getDirectoryHandle("backups", { create: true })
        .then(function (dir) {
          return dir.getFileHandle(backupPrefix + s + ".json", { create: true })
            .then(function (h) { return h.createWritable(); })
            .then(function (w) {
              return w.write(serialize(data)).then(function () { return w.close(); });
            })
            .then(function () { return prune(dir); });
        })
        .then(function () { return true; })
        .catch(function (err) {
          console.warn("[sync:" + appId + "] backup failed", err);
          return false;
        });
    }

    /* Prune only our own backups. The folder is shared with the other apps,
       so a blind sort-and-delete would eat theirs. */
    function prune(dir) {
      var names = [];
      return (async function () {
        for await (var entry of dir.entries()) {
          if (entry[0].indexOf(backupPrefix) === 0) names.push(entry[0]);
        }
        names.sort();
        var excess = names.length - backupKeep;
        for (var i = 0; i < excess; i++) await dir.removeEntry(names[i]);
        return excess > 0 ? excess : 0;
      })();
    }

    /* ---- conflicts ---------------------------------------------------- */

    /* Found and reported, never resolved. The sync tool kept both sides
       because it could not decide; this module is in no better position. The
       Hub surfaces them and a person picks. */
    function listConflicts() {
      if (!dirHandle) return Promise.resolve([]);
      return (async function () {
        var out = [];
        for await (var entry of dirHandle.entries()) {
          var name = entry[0];
          if (entry[1].kind !== "file") continue;
          var m = name.match(CONFLICT_RE);
          if (!m) continue;
          var when = null;
          if (m[1] && m[2]) {
            when = m[1].slice(0, 4) + "-" + m[1].slice(4, 6) + "-" + m[1].slice(6, 8) +
                   "T" + m[2].slice(0, 2) + ":" + m[2].slice(2, 4) + ":" + m[2].slice(4, 6);
          }
          var size = 0;
          try { size = (await entry[1].getFile()).size; } catch (e) {}
          out.push({ name: name, at: when, device: m[3] || null, bytes: size });
        }
        return out.sort(function (a, b) { return (b.at || "").localeCompare(a.at || ""); });
      })();
    }

    function readConflict(name) {
      if (!dirHandle) return Promise.resolve(null);
      return dirHandle.getFileHandle(name)
        .then(function (h) { return h.getFile(); })
        .then(function (f) { return f.text(); })
        .then(function (t) { return parse(t); });
    }

    function dropConflict(name) {
      if (!dirHandle) return Promise.resolve(false);
      return dirHandle.removeEntry(name).then(function () { return true; })
        .catch(function () { return false; });
    }

    /* ---- refresh ------------------------------------------------------ */

    /* A tab that has been in the background does not know another machine
       wrote the file. Without this, its next save writes stale state over
       fresh — the whole reason merging exists.

       Focus rather than a poll: no timer, no battery cost, and it covers the
       case that actually produces the failure (you switched machines and came
       back). It does NOT cover a tab left visible on a second monitor; that
       gap is named in the plan rather than papered over. */
    function refresh(getLocal, apply) {
      if (!fileHandle) return Promise.resolve(false);
      return readFile().then(function (fileData) {
        if (!fileData) return false;
        var local = getLocal();
        var merged = merge(fileData, local);
        var changed = JSON.stringify(merged) !== JSON.stringify(local);
        if (changed) {
          apply(merged);
          try { onRemoteChange(merged, { from: fileData.deviceId || null, at: fileData.writtenAt || null }); } catch (e) {}
        }
        return changed;
      }).catch(function (err) {
        lastError = String((err && err.message) || err);
        return false;
      });
    }

    var watching = false;
    function watch(getLocal, apply, isBusy) {
      if (watching) return;
      watching = true;
      var run = function () {
        if (document.visibilityState !== "visible") return;
        /* Never merge under the user's cursor. A dialog open or a field
           focused means an edit is in flight; the refresh waits for the next
           focus rather than rewriting the form being typed into. */
        if (isBusy && isBusy()) return;
        refresh(getLocal, apply);
      };
      document.addEventListener("visibilitychange", run);
      window.addEventListener("focus", run);
    }

    /* ---- init --------------------------------------------------------- */

    function init(getLocal) {
      return restore().then(function (st) {
        if (st !== "synced") return { status: st, data: null, merged: false };
        return readFile().then(function (fileData) {
          if (!fileData) return { status: "synced", data: null, merged: false };
          var local = getLocal ? getLocal() : null;
          var merged = local ? merge(fileData, local) : fileData;
          return { status: "synced", data: merged, merged: true, from: fileData.deviceId || null };
        }).catch(function (err) {
          /* Corrupt file: report it and keep the app on its own copy. Writing
             over it would destroy the only evidence of what went wrong. */
          lastError = String((err && err.message) || err);
          return { status: "corrupt", data: null, merged: false, error: lastError };
        });
      });
    }

    return {
      appId: appId,
      deviceId: deviceId,
      renameDevice: renameDevice,
      init: init,
      connect: connect,
      forget: forget,
      reconnect: reconnect,
      readFile: readFile,
      save: save,
      flush: flush,
      writeNow: writeNow,
      refresh: refresh,
      watch: watch,
      listConflicts: listConflicts,
      readConflict: readConflict,
      dropConflict: dropConflict,
      hasFile: function () { return !!fileHandle; },
      hasDir: function () { return !!dirHandle; },
      status: function () { return status; },
      info: function () {
        return {
          appId: appId, fileName: fileName, deviceId: deviceId(),
          status: status, lastWriteAt: lastWriteAt, lastReadAt: lastReadAt,
          lastError: lastError, hasDir: !!dirHandle, hasFile: !!fileHandle
        };
      }
    };
  }

  /* ======================================================================
     FOLDER — a reader, with no file of its own

     The Hub does not sync anything; it reads what the other apps wrote. It
     still needs the same grant, the same IndexedDB persistence and the same
     once-per-session re-confirm, so that lives here rather than being written
     a second time in the Hub.
     ====================================================================== */
  function folder(opts) {
    opts = opts || {};
    var dbName = opts.dbName || "hub-handles";
    var store = "handles";
    var dir = null;

    function connect() {
      if (!window.showDirectoryPicker) {
        return Promise.reject(new Error("This browser has no File System Access. Chromium desktop only."));
      }
      return window.showDirectoryPicker({ mode: "readwrite", id: "sync-folder" })
        .then(function (h) {
          dir = h;
          return idbPut(dbName, store, "dir", h).catch(function () {}).then(function () { return h; });
        });
    }

    function restore() {
      return idbGet(dbName, store, "dir").catch(function () { return null; })
        .then(function (h) {
          if (!h) return null;
          return h.queryPermission({ mode: "read" }).catch(function () { return "denied"; })
            .then(function (p) { dir = p === "granted" ? h : null; return dir; });
        });
    }

    function reconnect() {
      return idbGet(dbName, store, "dir").catch(function () { return null; })
        .then(function (h) {
          if (!h) return null;
          return h.requestPermission({ mode: "readwrite" }).catch(function () { return "denied"; })
            .then(function (p) { dir = p === "granted" ? h : null; return dir; });
        });
    }

    /* Every file at the top level, with the numbers the Hub's status table
       needs. Size and mtime come from the File object, so a file that will not
       parse still reports honestly instead of vanishing from the listing. */
    function list() {
      if (!dir) return Promise.resolve([]);
      return (async function () {
        var out = [];
        for await (var e of dir.entries()) {
          if (e[1].kind !== "file") continue;
          var rec = { name: e[0], bytes: null, modified: null, conflict: CONFLICT_RE.test(e[0]) };
          try {
            var f = await e[1].getFile();
            rec.bytes = f.size;
            rec.modified = new Date(f.lastModified).toISOString();
          } catch (err) { rec.error = String(err && err.message || err); }
          out.push(rec);
        }
        return out.sort(function (a, b) { return a.name.localeCompare(b.name); });
      })();
    }

    /* Never throws on bad JSON — returns the parse error instead. A corrupt
       file is something the Hub exists to SHOW you, not something it should
       fall over on. */
    function read(name) {
      if (!dir) return Promise.resolve({ name: name, missing: true });
      return dir.getFileHandle(name)
        .then(function (h) { return h.getFile(); })
        .then(function (f) {
          return f.text().then(function (text) {
            var rec = { name: name, bytes: f.size, modified: new Date(f.lastModified).toISOString(), raw: text };
            try { rec.data = JSON.parse(text); rec.parsed = true; }
            catch (err) { rec.parsed = false; rec.error = String(err && err.message || err); }
            return rec;
          });
        })
        .catch(function () { return { name: name, missing: true }; });
    }

    function remove(name) {
      if (!dir) return Promise.resolve(false);
      return dir.removeEntry(name).then(function () { return true; })
        .catch(function () { return false; });
    }

    function writeText(name, text) {
      if (!dir) return Promise.resolve(false);
      return dir.getFileHandle(name, { create: true })
        .then(function (h) { return h.createWritable(); })
        .then(function (w) { return w.write(text).then(function () { return w.close(); }); })
        .then(function () { return true; })
        .catch(function () { return false; });
    }

    return {
      connect: connect, restore: restore, reconnect: reconnect,
      list: list, read: read, remove: remove, writeText: writeText,
      has: function () { return !!dir; },
      name: function () { return dir ? dir.name : null; }
    };
  }

  return {
    create: create,
    folder: folder,
    deviceId: deviceId,
    renameDevice: renameDevice,
    supported: function () { return typeof window.showDirectoryPicker === "function"; },
    CONFLICT_RE: CONFLICT_RE
  };
})();
