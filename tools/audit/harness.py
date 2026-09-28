"""Plumbing for the Docket audit checks (checks.py).

Serves a Docket tree over http://127.0.0.1 — a secure context, so the service
worker, OPFS and notifications behave as they do on GitHub Pages — and gives
the checks three stand-ins for the outside world:

  · FakeTurso      an in-process database speaking the subset of the Hrana
                   pipeline js/turso.js uses; two browser contexts routed at
                   one instance behave like two devices on one database
  · OPFS_PICKER    showDirectoryPicker backed by the Origin Private File
                   System, so vendor/sync.js runs its real read, write, backup
                   and prune code against a real FileSystemDirectoryHandle
  · Env.profile()  an on-disk browser profile for every folder check —
                   Chromium's incognito contexts crash the browser on
                   navigation once a page has used file-handle permissions
"""
from __future__ import annotations

import functools
import http.server
import json
import re
import shutil
import tempfile
import threading
from pathlib import Path

DOCKET = Path(__file__).resolve().parents[2]


# ---- server -------------------------------------------------------------------

class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


class _Cached(http.server.SimpleHTTPRequestHandler):
    """GitHub Pages sends Cache-Control: max-age=600 on every file."""
    requested: list[str] = []

    def end_headers(self):
        self.send_header("Cache-Control", "max-age=600")
        super().end_headers()

    def log_message(self, fmt, *a):
        _Cached.requested.append(self.path)


def serve(root: Path, cached: bool = False):
    handler = functools.partial(_Cached if cached else _Quiet, directory=str(root))
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{srv.server_address[1]}/", srv


def copy_site(root: Path) -> Path:
    """A throwaway copy of the app, for checks that have to 'deploy' over it."""
    dest = Path(tempfile.mkdtemp(prefix="docket-site-"))
    shutil.copytree(root, dest, dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns(".git", "tools", ".claude", ".impeccable", "*.backup-*", "__pycache__"))
    return dest


# ---- page-side stubs ------------------------------------------------------------

ERROR_TRAP = """
window.__errs = [];
window.addEventListener('error', e => window.__errs.push(String(e.error && e.error.stack || e.message)));
window.addEventListener('unhandledrejection', e => window.__errs.push('REJECTION: ' + String(e.reason && e.reason.stack || e.reason)));
"""

OPFS_PICKER = """
window.showDirectoryPicker = async () => {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('picked', { create: true });
};
"""

# Permission lost at boot, re-granted by the Reconnect click — what a browser
# restart looks like to sync.js.
PERM_PROMPT = """
window.__perm = 'prompt';
FileSystemHandle.prototype.queryPermission = async function () { return window.__perm; };
FileSystemHandle.prototype.requestPermission = async function () { window.__perm = 'granted'; return 'granted'; };
"""

# Records every notification, whichever way the app fires it.
NOTIF_TRAP = """
window.__notes = [];
window.Notification = function (title, o) { window.__notes.push(String(title) + (o && o.body ? ' ' + o.body : '')); return {}; };
window.Notification.permission = 'granted';
window.Notification.requestPermission = async () => 'granted';
if (window.ServiceWorkerRegistration) {
  ServiceWorkerRegistration.prototype.showNotification = function (title, o) { window.__notes.push(String(title) + (o && o.body ? ' ' + o.body : '')); return Promise.resolve(); };
}
"""

NO_FOLDER_ACCESS = "delete Window.prototype.showDirectoryPicker; delete window.showDirectoryPicker;"


# ---- fake database ---------------------------------------------------------------

class FakeTurso:
    """One Turso database. `hold` parks requests unanswered (a slow or hung
    network); `down` answers 503 (unreachable)."""

    def __init__(self, token: str = "good-token"):
        self.token = token
        self.row: dict | None = None
        self.table = False
        self.writes = 0
        self.log: list[str] = []
        self.hold = False
        self.down = False
        self.held: list = []

    def handle(self, route, request):
        if request.method == "OPTIONS":
            return route.fulfill(status=200, headers={"access-control-allow-origin": "*",
                                                     "access-control-allow-headers": "authorization, content-type"})
        if self.hold:
            self.held.append((route, request))
            return None
        if self.down:
            return route.fulfill(status=503, headers={"access-control-allow-origin": "*"}, body="unavailable")
        if request.headers.get("authorization", "") != "Bearer " + self.token:
            self.log.append("401")
            return route.fulfill(status=401, headers={"access-control-allow-origin": "*"}, body="unauthorized")
        body = json.loads(request.post_data or "{}")
        results = []
        for req in body.get("requests", []):
            if req["type"] == "close":
                results.append({"type": "ok", "response": {"type": "close"}})
                continue
            sql = req["stmt"]["sql"].strip()
            args = req["stmt"].get("args", [])
            rows = []
            if sql.upper().startswith("CREATE TABLE"):
                self.table = True
                self.log.append("CREATE")
            elif sql.upper().startswith("SELECT"):
                self.log.append("SELECT")
                if not self.table:
                    results.append({"type": "error", "error": {"message": "no such table: docket_doc"}})
                    continue
                if self.row:
                    rows = [[{"type": "text", "value": self.row["data"]},
                             {"type": "text", "value": self.row["device_id"]},
                             {"type": "text", "value": self.row["written_at"]}]]
            elif sql.upper().startswith("INSERT"):
                self.log.append("INSERT")
                if not self.table:
                    results.append({"type": "error", "error": {"message": "no such table: docket_doc"}})
                    continue
                self.row = {"data": args[0]["value"], "device_id": args[1]["value"], "written_at": args[2]["value"]}
                self.writes += 1
            results.append({"type": "ok", "response": {"type": "execute", "result": {
                "cols": [], "rows": rows, "affected_row_count": 0}}})
        return route.fulfill(status=200, headers={"access-control-allow-origin": "*", "content-type": "application/json"},
                             body=json.dumps({"baton": None, "base_url": None, "results": results}))

    def release(self):
        self.hold = False
        while self.held:
            r, q = self.held.pop(0)
            self.handle(r, q)

    def tasks(self) -> list[dict]:
        return json.loads(self.row["data"]).get("tasks", []) if self.row else []


DB_URL = "libsql://fake.turso.io"
DB_ROUTE = "https://fake.turso.io/v2/pipeline"


# ---- browsers ---------------------------------------------------------------------

class Env:
    def __init__(self, pw, root: Path = DOCKET):
        self.pw = pw
        self.root = root
        self.browser = pw.chromium.launch()
        self.url, self.srv = serve(root)
        self._dirs: list[str] = []

    def ctx(self, *, opfs: bool = False, viewport=(1500, 950), sw: str = "block", **kw):
        """An incognito context: one device, no folder that survives a reload."""
        c = self.browser.new_context(viewport={"width": viewport[0], "height": viewport[1]}, service_workers=sw, **kw)
        c.add_init_script(ERROR_TRAP)
        if opfs:
            c.add_init_script(OPFS_PICKER)
        return c

    def profile(self, *, viewport=(1500, 950), sw: str = "block", **kw):
        """An on-disk profile with the OPFS picker: use for every folder check."""
        d = tempfile.mkdtemp(prefix="docket-audit-")
        self._dirs.append(d)
        c = self.pw.chromium.launch_persistent_context(d, headless=True, service_workers=sw,
                                                       viewport={"width": viewport[0], "height": viewport[1]}, **kw)
        c.add_init_script(ERROR_TRAP)
        c.add_init_script(OPFS_PICKER)
        pg = c.pages[0] if c.pages else c.new_page()
        return c, pg

    def close(self):
        try:
            self.browser.close()
        except Exception:
            pass
        self.srv.shutdown()
        for d in self._dirs:
            shutil.rmtree(d, ignore_errors=True)


# ---- page helpers --------------------------------------------------------------------

def boot(pg, url: str, wait_ms: int = 800):
    pg.goto(url)
    pg.wait_for_timeout(wait_ms)


def mirror(pg) -> dict:
    return pg.evaluate("JSON.parse(localStorage.getItem('docket.v1') || 'null')") or {}


def titles(pg) -> list[str]:
    return [t.get("title") for t in mirror(pg).get("tasks", [])]


def board_titles(pg, scope: str = ".board") -> list[str]:
    return pg.locator(f"{scope} .card .card-title").all_inner_texts()


def card(pg, title: str, scope: str = ".board"):
    exact = re.compile("^" + re.escape(title) + "$")
    return pg.locator(f"{scope} .card").filter(has=pg.locator(".card-title", has_text=exact))


def quick_add(pg, title: str, close: bool = True):
    pg.click("#quick-add-input")
    pg.fill("#quick-add-input", title)
    pg.press("#quick-add-input", "Enter")
    pg.wait_for_timeout(150)
    if close:
        pg.click("#card-modal-close")
        pg.wait_for_timeout(120)


def open_card(pg, title: str):
    card(pg, title).first.click()
    pg.wait_for_timeout(150)


def connect_folder(pg):
    pg.click("#new-file-btn")
    pg.wait_for_timeout(700)


def connect_db(pg, token: str = "good-token", url: str = DB_URL):
    if pg.is_visible("#open-db-modal-btn"):
        pg.click("#open-db-modal-btn")
    else:
        pg.click("#db-strip")
    pg.fill("#db-url-input", url)
    pg.fill("#db-token-input", token)
    pg.click("#db-connect-btn")
    pg.wait_for_timeout(600)


def focus_event(pg):
    pg.evaluate("window.dispatchEvent(new Event('focus'))")
    pg.wait_for_timeout(400)


def import_json(pg, obj):
    pg.set_input_files("#import-file-input", files=[{"name": "import.json", "mimeType": "application/json",
                                                     "buffer": json.dumps(obj).encode()}])
    pg.wait_for_timeout(500)


def errors(pg) -> list[str]:
    return [e.splitlines()[0] for e in (pg.evaluate("window.__errs || []") or [])]


def seed_script(tasks: list[dict], projects: list[dict] = (), version: int = 3, extra: dict | None = None) -> str:
    """localStorage['docket.v1'] set once, before the app's own scripts run."""
    data = {"schemaVersion": version, "projects": list(projects), "tasks": tasks, **(extra or {})}
    return ("if (location.protocol.startsWith('http') && !localStorage.getItem('docket.v1')) "
            "localStorage.setItem('docket.v1', %s);" % json.dumps(json.dumps(data)))


TASK = {"projectId": None, "dueDate": None, "dueTime": None, "priority": "med", "status": "todo", "subtasks": [],
        "notes": "", "recurrence": None, "order": None, "doneAt": None, "archivedAt": None,
        "createdAt": "2026-09-01T10:00:00.000Z", "updatedAt": "2026-09-01T10:00:00.000Z"}


def task(**kw) -> dict:
    return {**TASK, **kw}


def task_file(n: int) -> str:
    return json.dumps({"schemaVersion": 3, "projects": [],
                       "tasks": [task(id=f"old-{i}", title=f"Existing task {i}") for i in range(n)]})


# ---- OPFS ------------------------------------------------------------------------------

READ_OPFS = """async (name) => {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle('picked', { create: true });
  try { return await (await (await dir.getFileHandle(name)).getFile()).text(); } catch (e) { return null; }
}"""

WRITE_OPFS = """async ([name, text]) => {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle('picked', { create: true });
  const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await w.write(text); await w.close(); return true;
}"""

LIST_BACKUPS = """async () => {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle('picked', { create: true });
  let b; try { b = await dir.getDirectoryHandle('backups'); } catch (e) { return []; }
  const out = [];
  for await (const [name, h] of b.entries()) out.push([name, await (await h.getFile()).text()]);
  return out.sort();
}"""


def opfs_read(pg, name: str = "docket.json"):
    return pg.evaluate(READ_OPFS, name)


def opfs_write(pg, text: str, name: str = "docket.json"):
    return pg.evaluate(WRITE_OPFS, [name, text])


def opfs_tasks(pg) -> list[dict]:
    text = opfs_read(pg)
    try:
        return json.loads(text).get("tasks", []) if text else []
    except ValueError:
        return []


def backups(pg) -> list:
    return pg.evaluate(LIST_BACKUPS)
