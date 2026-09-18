// DOCKET · TURSO SYNC
// · A second, independent sync target: one JSON blob in one Turso row,
//   reached with plain fetch() against the Hrana-over-HTTP endpoint
//   (`{url}/v2/pipeline`) — no client library, no CDN. Verified against a
//   real database (see PLAN-turso.md A1) that the endpoint sends a wildcard
//   CORS header on both the preflight and the real request.
// · Same instance shape as vendor/sync.js where it overlaps (init, save,
//   flush, watch, refresh, forget, status, info) so storage.js can drive both
//   remotes the same way, but vendor/sync.js itself is untouched — it is
//   file-system-shaped and vendored from Hub, not a place to generalise.
// · Credential is {url, token} in localStorage["docket.turso.v1"] only —
//   never in docket.json, never in an export.
// · Public namespace: window.Docket.TursoSync
"use strict";

window.Docket = window.Docket || {};

(function () {
  const CRED_KEY = "docket.turso.v1";
  const DEVICE_KEY = "sync.deviceId"; // shared with vendor/sync.js — one id per machine, not per remote

  function deviceId() {
    try {
      return localStorage.getItem(DEVICE_KEY) || "device";
    } catch {
      return "device";
    }
  }

  function loadCreds() {
    try {
      const raw = localStorage.getItem(CRED_KEY);
      if (!raw) return null;
      const c = JSON.parse(raw);
      return c && c.url && c.token ? c : null;
    } catch {
      return null;
    }
  }

  function saveCreds(url, token) {
    localStorage.setItem(CRED_KEY, JSON.stringify({ url: url.trim(), token: token.trim() }));
  }

  function clearCreds() {
    localStorage.removeItem(CRED_KEY);
  }

  // Docket asks you to paste the libsql:// host Turso shows you — this is
  // what it actually calls: the Hrana-over-HTTP pipeline endpoint.
  function pipelineUrl(dbUrl) {
    return dbUrl.trim().replace(/^libsql:/, "https:").replace(/\/+$/, "") + "/v2/pipeline";
  }

  function create(opts) {
    const merge = opts.merge; // required, same reconcile() as the folder path
    const parse = opts.parse || ((t) => JSON.parse(t));
    const serialize = opts.serialize || ((d) => JSON.stringify(d));
    const onStatus = opts.onStatus || (() => {});
    const debounceMs = opts.writeDebounceMs != null ? opts.writeDebounceMs : 400;

    let status = "no-db";
    let writeTimer = null;
    let lastWriteAt = null;
    let lastReadAt = null;
    let lastError = null;
    let ensured = false; // CREATE TABLE IF NOT EXISTS run once per connect, not once per write

    function setStatus(s) {
      if (s === status) return;
      status = s;
      try {
        onStatus(s);
      } catch {}
    }

    // One HTTP call, N statements, in order — Hrana's pipeline request.
    async function pipeline(creds, stmts) {
      const res = await fetch(pipelineUrl(creds.url), {
        method: "POST",
        headers: {
          Authorization: "Bearer " + creds.token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          requests: [...stmts.map((stmt) => ({ type: "execute", stmt })), { type: "close" }],
        }),
      });
      if (!res.ok) throw new Error("turso http " + res.status);
      const body = await res.json();
      const results = body.results || [];
      for (const r of results) {
        if (r.type === "error") throw new Error(r.error?.message || "turso query error");
      }
      return results;
    }

    async function ensureTable(creds) {
      if (ensured) return;
      await pipeline(creds, [
        {
          sql: "CREATE TABLE IF NOT EXISTS docket_doc (id INTEGER PRIMARY KEY CHECK (id=1), data TEXT NOT NULL, device_id TEXT, written_at TEXT)",
        },
      ]);
      ensured = true;
    }

    async function readRow(creds) {
      const results = await pipeline(creds, [
        { sql: "SELECT data, device_id, written_at FROM docket_doc WHERE id=1" },
      ]);
      const rows = results[0]?.response?.result?.rows || [];
      if (!rows.length) return null;
      lastReadAt = new Date().toISOString();
      const [dataCell, deviceCell, writtenCell] = rows[0];
      try {
        const data = parse(dataCell.value);
        return { data, deviceId: deviceCell.value, writtenAt: writtenCell.value };
      } catch (err) {
        lastError = String(err.message || err);
        throw err;
      }
    }

    async function writeRow(creds, data) {
      await pipeline(creds, [
        {
          sql: "INSERT INTO docket_doc (id, data, device_id, written_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data, device_id=excluded.device_id, written_at=excluded.written_at",
          args: [
            { type: "text", value: serialize(data) },
            { type: "text", value: deviceId() },
            { type: "text", value: new Date().toISOString() },
          ],
        },
      ]);
      lastWriteAt = new Date().toISOString();
    }

    // ---- connect ------------------------------------------------------

    function configured() {
      return !!loadCreds();
    }

    async function connect(url, token) {
      const creds = { url, token };
      try {
        await ensureTable(creds);
      } catch (err) {
        lastError = String(err.message || err);
        throw err; // let the modal show the error — nothing saved on a bad url/token
      }
      saveCreds(url, token);
      setStatus("synced");
      return true;
    }

    function forget() {
      clearCreds();
      ensured = false;
      setStatus("no-db");
    }

    // ---- write ----------------------------------------------------------
    // Same shape as vendor/sync.js's save()/flush(): debounce the expensive
    // write, never the localStorage mirror (that lives in storage.js, not
    // here — this module never touches the mirror).

    function save(data) {
      const creds = loadCreds();
      if (!creds) return;
      if (writeTimer) clearTimeout(writeTimer);
      writeTimer = setTimeout(() => {
        writeTimer = null;
        writeNow(data);
      }, debounceMs);
    }

    async function writeNow(data) {
      const creds = loadCreds();
      if (!creds) {
        setStatus("no-db");
        return false;
      }
      try {
        await ensureTable(creds);
        await writeRow(creds, data);
        lastError = null;
        setStatus("synced");
        return true;
      } catch (err) {
        lastError = String(err.message || err);
        // A write failure never claims synced and never touches the folder's
        // status — the two remotes fail independently (plan A3/A4).
        setStatus("disconnected");
        return false;
      }
    }

    function flush(data) {
      if (writeTimer) {
        clearTimeout(writeTimer);
        writeTimer = null;
      }
      return writeNow(data);
    }

    // ---- init / refresh ---------------------------------------------------

    async function init(getLocal) {
      const creds = loadCreds();
      if (!creds) return { status: "no-db", data: null, merged: false };
      try {
        await ensureTable(creds);
        const row = await readRow(creds);
        setStatus("synced");
        if (!row) return { status: "synced", data: null, merged: false };
        const local = getLocal ? getLocal() : null;
        const merged = local ? merge(row.data, local) : row.data;
        return { status: "synced", data: merged, merged: true, from: row.deviceId || null };
      } catch (err) {
        lastError = String(err.message || err);
        setStatus("disconnected");
        return { status: "disconnected", data: null, merged: false, error: lastError };
      }
    }

    async function refresh(getLocal, apply) {
      const creds = loadCreds();
      if (!creds) return false;
      try {
        const row = await readRow(creds);
        if (!row) return false;
        const local = getLocal();
        const merged = merge(row.data, local);
        const changed = JSON.stringify(merged) !== JSON.stringify(local);
        if (changed) apply(merged);
        setStatus("synced");
        return changed;
      } catch (err) {
        lastError = String(err.message || err);
        setStatus("disconnected");
        return false;
      }
    }

    // No polling timer — same focus/visibility trigger as vendor/sync.js's
    // watch(), and for the same reason (see its comment): a poll costs
    // battery for a gap that only matters when you switch machines, which
    // focus already covers.
    let watching = false;
    function watch(getLocal, apply, isBusy) {
      if (watching) return;
      watching = true;
      const run = () => {
        if (document.visibilityState !== "visible") return;
        if (isBusy && isBusy()) return;
        refresh(getLocal, apply);
      };
      document.addEventListener("visibilitychange", run);
      window.addEventListener("focus", run);
    }

    return {
      configured,
      connect,
      forget,
      init,
      save,
      flush,
      refresh,
      watch,
      status: () => status,
      info: () => ({
        status,
        lastWriteAt,
        lastReadAt,
        lastError,
        url: loadCreds()?.url || null,
      }),
    };
  }

  window.Docket.TursoSync = { create, loadCreds, saveCreds, clearCreds };
})();
