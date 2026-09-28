"""Docket audit checks — one per finding in PLAN-audit.md.

Each check drives the real app in headless Chromium with clicks, keys and
drags, and asserts the FIXED behaviour. PASS means the fix held under the same
scenario Part A measured; FAIL prints what was measured instead. Before a
package lands its checks FAIL; after, they PASS. A check that passes before
any change means the finding no longer reproduces — report that, don't assume.

Usage:  python3 tools/audit/checks.py [ID ...] [--root DIR] [--list]
        python3 tools/audit/checks.py A1 A6 SMOKE      (IDs are case-blind)
        python3 tools/audit/checks.py P2               (every check in a package)
Needs:  pip install playwright && playwright install chromium
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import (DB_ROUTE, DB_URL, DOCKET, NO_FOLDER_ACCESS, NOTIF_TRAP, PERM_PROMPT, Env,  # noqa: E402
                     FakeTurso, backups, board_titles, boot, card, connect_db, connect_folder, copy_site,
                     errors, focus_event, import_json, mirror, opfs_read, opfs_tasks, opfs_write, open_card,
                     quick_add, seed_script, serve, task, task_file, titles)

TODAY = dt.date.today()
T0 = "2026-09-01T10:00:00.000Z"
Result = tuple[str, bool, str]


def iso(d: dt.datetime) -> str:
    return d.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def col(pg, status: str) -> list[str]:
    return pg.locator(f"#body-{status} .card .card-title").all_inner_texts()


def status_of(pg, title: str) -> str | None:
    return next((t.get("status") for t in mirror(pg).get("tasks", []) if t.get("title") == title), None)


def two_devices(env, db: FakeTurso):
    a, b = env.ctx(), env.ctx()
    for c in (a, b):
        c.route(DB_ROUTE, db.handle)
    return a, b


# ======================================================================== P1

def check_a2(env) -> list[Result]:
    out = []
    c = env.ctx(); pg = c.new_page(); boot(pg, env.url)
    title = 'Read "Dune" by Friday'
    quick_add(pg, title, close=False)
    shown = pg.input_value("#f-title")
    pg.click("#f-save"); pg.wait_for_timeout(150)
    stored = titles(pg)
    out.append(("title with a double quote survives Save", shown == title and title in stored,
                f"panel showed {shown!r}, stored {stored}"))
    quick_add(pg, "Pack", close=False)
    pg.click("#f-add-subtask")
    pg.fill(".sub-title >> nth=0", 'The 12" ruler'); pg.press(".sub-title >> nth=0", "Tab")
    pg.click("#f-save"); pg.wait_for_timeout(120)
    open_card(pg, "Pack")
    shown = pg.input_value(".sub-title >> nth=0")
    pg.click("#f-save"); pg.wait_for_timeout(120)
    out.append(("subtask with a double quote shows in full", shown == 'The 12" ruler', f"field showed {shown!r}"))
    evil = 'x" style="animation:fade-in 1s" onanimationstart="window.__pwned=(window.__pwned||0)+1'
    quick_add(pg, evil)
    open_card(pg, evil); pg.wait_for_timeout(300)
    n = pg.evaluate("window.__pwned || 0")
    out.append(("a title cannot carry an event handler", n == 0, f"handler ran {n}x on opening the card"))
    c.close()
    return out


def check_a10(env) -> list[Result]:
    out = []
    pw = 'window.__pwned=(window.__pwned||0)+1'
    c = env.ctx(); pg = c.new_page(); boot(pg, env.url)
    import_json(pg, {"schemaVersion": 3,
                     "projects": [{"id": "p", "name": "Shared list", "description": "", "createdAt": T0,
                                   "color": f'red"><img src=x onerror="{pw}">'}],
                     "tasks": [task(id="t", title="Looks harmless", projectId="p",
                                    priority=f'<img src=x onerror="{pw}">',
                                    dueDate=f'"><img src=x onerror="{pw}">')]})
    n1 = pg.evaluate("window.__pwned || 0")
    pg.reload(); pg.wait_for_timeout(800)
    n2 = pg.evaluate("window.__pwned || 0")
    kept = "Looks harmless" in board_titles(pg)
    out.append(("markup in an imported colour, priority and date runs nothing", n1 == 0 and n2 == 0 and kept,
                f"script ran {n1}x on import, {n2}x on reload; task still on the board: {kept}"))
    c.close()

    c = env.ctx(); pg = c.new_page(); boot(pg, env.url)
    quick_add(pg, "My own task")
    import_json(pg, {"schemaVersion": 3, "projects": [], "tasks": [task(id="bad", title="Hand-edited", subtasks=None)]})
    pg.reload(); pg.wait_for_timeout(800)
    errs = errors(pg)
    drawn = pg.locator("#body-done .empty-state, #body-done .card").count() > 0
    mine = "My own task" in board_titles(pg)
    out.append(("one task with subtasks:null leaves the board working", not errs and drawn and mine,
                f"errors after reload {errs[:1]}, Done column drawn {drawn}, own task shown {mine}"))
    c.close()

    legacy_v1 = [
        {"id": "l1", "title": "Old plain", "projectId": "op", "dueDate": None, "dueTime": None, "priority": "high",
         "status": "todo", "subtasks": [], "doneAt": None, "archivedAt": None, "createdAt": T0, "updatedAt": T0},
        {"id": "l2", "title": "Old with a time", "projectId": None, "dueDate": "2026-10-02", "dueTime": "09:30",
         "priority": "med", "status": "doing", "subtasks": [], "doneAt": None, "archivedAt": None, "createdAt": T0, "updatedAt": T0},
        {"id": "l3", "title": "Old with subtasks", "projectId": None, "dueDate": None, "dueTime": None, "priority": "low",
         "status": "todo", "subtasks": [{"id": "s", "title": "Step", "done": True}], "doneAt": None, "archivedAt": None,
         "createdAt": T0, "updatedAt": T0}]
    old_project = {"id": "op", "name": "Old project", "color": "#2F81F7", "createdAt": T0}
    shapes = {
        1: legacy_v1,
        2: [{**t, "notes": "n", "recurrence": None, "order": None} for t in legacy_v1],
        3: [task(**t, notes="n") for t in legacy_v1],
    }
    for v, tasks in shapes.items():
        c = env.ctx()
        proj = old_project if v < 3 else {**old_project, "description": ""}
        c.add_init_script(seed_script(tasks, [proj], version=v))
        pg = c.new_page(); boot(pg, env.url)
        shown = sorted(board_titles(pg)); errs = errors(pg)
        ok = shown == sorted(t["title"] for t in tasks) and not errs and pg.locator(".tab", has_text="Old project").count() == 1
        out.append((f"a v{v} mirror loads every task and project", ok, f"cards {shown}, errors {errs[:1]}"))
        c.close()
    c = env.ctx(); pg = c.new_page(); boot(pg, env.url)
    import_json(pg, {"schemaVersion": 1, "projects": [old_project], "tasks": legacy_v1})
    shown = sorted(board_titles(pg))
    out.append(("a v1 export imports every task", shown == sorted(t["title"] for t in legacy_v1), f"cards {shown}"))
    c.close()
    return out


# ======================================================================== P2

def check_a1(env) -> list[Result]:
    out = []
    for label, delay in (("no focus event", None), ("focus at +0 ms", 0), ("focus at +100 ms", 100)):
        c, pg = env.profile(); boot(pg, env.url)
        opfs_write(pg, task_file(5))
        if delay is not None:
            pg.evaluate("""(d) => { const o = window.showDirectoryPicker; window.showDirectoryPicker = async () => {
                const h = await o(); setTimeout(() => window.dispatchEvent(new Event('focus')), d); return h; }; }""", delay)
        pg.click("#connect-file-btn"); pg.wait_for_timeout(1500)
        disk, cards = len(opfs_tasks(pg)), len(board_titles(pg))
        out.append((f"Use existing folder, {label}", disk >= 5 and cards == 5, f"file 5 -> {disk} tasks, board {cards} cards"))
        c.close()

    c, pg = env.profile(); boot(pg, env.url)
    opfs_write(pg, task_file(5))
    pg.click("#new-file-btn"); pg.wait_for_timeout(1500)
    disk, cards = len(opfs_tasks(pg)), len(board_titles(pg))
    out.append(("Set up folder over an existing docket.json", disk >= 5 and cards == 5, f"file 5 -> {disk} tasks, board {cards} cards"))
    c.close()

    c, pg = env.profile(); boot(pg, env.url)
    connect_folder(pg)
    quick_add(pg, "A: written before the restart"); pg.wait_for_timeout(800)
    c.add_init_script(PERM_PROMPT)
    pg.reload(); pg.wait_for_timeout(1000)
    disk = json.loads(opfs_read(pg))
    other = dict(disk["tasks"][0])
    other.update(id="from-laptop", title="B: added on the other machine", createdAt="2026-09-24T09:00:00.000Z",
                 updatedAt="2026-09-24T09:00:00.000Z")
    disk["tasks"].append(other)
    opfs_write(pg, json.dumps(disk))
    pg.click("#reconnect-btn"); pg.wait_for_timeout(700)
    on_board = "B: added on the other machine" in board_titles(pg)
    quick_add(pg, "C: first edit after Reconnect"); pg.wait_for_timeout(900)
    after = sorted(t["title"][:1] for t in opfs_tasks(pg))
    out.append(("Reconnect reads what another machine wrote meanwhile", on_board and "B" in after,
                f"B on the board after Reconnect: {on_board}; file after the first edit {after}"))
    c.close()

    db = FakeTurso(); a, b = two_devices(env, db)
    pa = a.new_page(); boot(pa, env.url); connect_db(pa); quick_add(pa, "Shared task"); pa.wait_for_timeout(700)
    pb = b.new_page(); boot(pb, env.url); connect_db(pb); quick_add(pb, "Added on the phone"); pb.wait_for_timeout(700)
    db.down = True
    pa.reload(); pa.wait_for_timeout(1000)
    db.down = False
    quick_add(pa, "Laptop edit once the network is back"); pa.wait_for_timeout(1000)
    held = [t["title"] for t in db.tasks()]
    out.append(("a device that booted offline doesn't overwrite the database", "Added on the phone" in held, f"database holds {held}"))
    a.close(); b.close()
    return out


def check_a6(env) -> list[Result]:
    c, pg = env.profile(); boot(pg, env.url)
    connect_folder(pg); quick_add(pg, "Keep me"); pg.wait_for_timeout(800)
    corrupt = '{"schemaVersion":3,"projects":[],"tasks":[{"id":"z","title":"Only in the file, written by the laptop"'
    opfs_write(pg, corrupt)
    pg.reload(); pg.wait_for_timeout(1000)
    quick_add(pg, "First edit after load"); pg.wait_for_timeout(900)
    same = opfs_read(pg) == corrupt
    strip = pg.inner_text("#sync-strip")
    c.close()
    return [("a corrupt file survives an edit and the strip says so", same and "unreadable" in strip.lower(),
             f"file untouched: {same}; strip {strip!r}")]


def check_a7(env) -> list[Result]:
    out = []
    c, pg = env.profile(); boot(pg, env.url)
    connect_folder(pg); quick_add(pg, "One real edit"); pg.wait_for_timeout(800)
    n0 = len(backups(pg))
    for _ in range(11):
        pg.reload(); pg.wait_for_timeout(900)
    n1 = len(backups(pg))
    out.append(("11 reloads add at most one backup", n1 - n0 <= 1, f"backups {n0} -> {n1}"))
    c.close()

    c, pg = env.profile()
    c.clock.install()
    boot(pg, env.url)
    pg.click("#new-file-btn"); pg.clock.run_for(1000); pg.wait_for_timeout(600)
    quick_add(pg, "Monday's plan"); pg.clock.run_for(1000); pg.wait_for_timeout(600)
    n0 = len(backups(pg))
    for _ in range(11):
        pg.clock.run_for(10 * 60 * 1000 + 1000); pg.wait_for_timeout(500)
    n1 = len(backups(pg))
    out.append(("110 idle minutes add no backup", n1 == n0, f"backups {n0} -> {n1}"))
    c.close()
    return out


def check_a8(env) -> list[Result]:
    c, pg = env.profile(); boot(pg, env.url)
    opfs_write(pg, task_file(5))
    pg.evaluate("""async () => {
      const root = await navigator.storage.getDirectory();
      const f = await (await root.getDirectoryHandle('picked')).getFileHandle('docket.json');
      await new Promise((res, rej) => { const r = indexedDB.open('docket-handles', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('handles');
        r.onsuccess = () => { const tx = r.result.transaction('handles', 'readwrite'); tx.objectStore('handles').put(f, 'file');
          tx.oncomplete = res; tx.onerror = rej; }; });
    }""")
    pg.reload(); pg.wait_for_timeout(1000)
    rail = pg.inner_text(".status-rail")
    told = "backups are off" in rail.lower()
    c.close()
    return [("a file-only profile is told backups are off", told, f"status rail reads {rail.strip()[:120]!r}")]


def check_a9(env) -> list[Result]:
    c, pg = env.profile(); boot(pg, env.url)
    connect_folder(pg)
    c.add_init_script(PERM_PROMPT)
    pg.reload(); pg.wait_for_timeout(1000)
    quick_add(pg, "Edit while disconnected"); pg.wait_for_timeout(800)
    strip, red = pg.inner_text("#sync-strip"), pg.is_visible("#reconnect-banner")
    c.close()
    return [("the red Reconnect banner outlasts an edit", red and "disconnected" in strip.lower(),
             f"strip {strip!r}, red banner showing {red}")]


def check_a18(env) -> list[Result]:
    out = []
    c = env.ctx(); c.add_init_script(NO_FOLDER_ACCESS)
    pg = c.new_page(); boot(pg, env.url)
    hidden = not pg.is_visible("#connect-file-btn") and not pg.is_visible("#new-file-btn")
    says = "desktop chrome" in pg.inner_text(".status-rail").lower()
    out.append(("without File System Access the folder buttons say why", hidden and says,
                f"buttons hidden {hidden}, rail mentions desktop Chrome {says}"))
    c.close()
    c, pg = env.profile(); boot(pg, env.url)
    pg.click("#connect-file-btn"); pg.wait_for_timeout(600)
    toast = pg.inner_text("#toast") if pg.is_visible("#toast") else ""
    out.append(("a folder without docket.json says so", "docket.json" in toast, f"toast {toast!r}"))
    c.close()
    return out


# ======================================================================== P3

def check_a3(env) -> list[Result]:
    c = env.ctx()
    a = c.new_page(); boot(a, env.url)
    b = c.new_page(); boot(b, env.url)
    quick_add(a, "Captured in tab A"); a.wait_for_timeout(300)
    quick_add(b, "Captured in tab B"); b.wait_for_timeout(300)
    fresh = c.new_page(); boot(fresh, env.url)
    held = titles(fresh)
    c.close()
    return [("two tabs keep both tasks", "Captured in tab A" in held and "Captured in tab B" in held, f"a fresh load holds {held}")]


def check_a5(env) -> list[Result]:
    out = []
    db = FakeTurso(); a, b = two_devices(env, db)
    pa = a.new_page(); boot(pa, env.url); connect_db(pa)
    quick_add(pa, "Task X"); quick_add(pa, "Task Y"); pa.wait_for_timeout(700)
    pb = b.new_page(); boot(pb, env.url); connect_db(pb)
    open_card(pa, "Task X"); pa.click("#f-delete"); pa.wait_for_timeout(800)
    focus_event(pb); quick_add(pb, "Task Z"); pb.wait_for_timeout(800)
    focus_event(pa); focus_event(pb)
    on_a, on_b = board_titles(pa), board_titles(pb)
    out.append(("a delete sticks across two devices", "Task X" not in on_a and "Task X" not in on_b,
                f"A shows {on_a}, B shows {on_b}"))
    a.close(); b.close()

    c, pg = env.profile(); boot(pg, env.url)
    connect_folder(pg); quick_add(pg, "Delete me"); quick_add(pg, "Keep me"); pg.wait_for_timeout(800)
    open_card(pg, "Delete me"); pg.click("#f-delete"); pg.wait_for_timeout(100)
    pg.reload(); pg.wait_for_timeout(1000)
    shown = board_titles(pg)
    out.append(("a reload 100 ms after a delete keeps it deleted", "Delete me" not in shown, f"board after reload {shown}"))
    c.close()
    return out


def check_a20(env) -> list[Result]:
    out = []
    c = env.ctx(); pg = c.new_page(); boot(pg, env.url)
    pg.click("#new-project-btn"); pg.fill("#new-project-name", "Ashoka"); pg.click("#project-modal-add"); pg.click("#project-modal-close")
    pg.locator(".tab", has_text="Ashoka").click()
    for t in ("Essay draft", "Reading log", "Problem set 3"):
        quick_add(pg, t)
    pg.click("#new-project-btn"); pg.click(".project-row .btn-icon"); pg.wait_for_timeout(200)
    undo = pg.is_visible("#toast .toast-action")
    pg.click("#project-modal-close"); pg.wait_for_timeout(200)
    shown, active = len(board_titles(pg)), [t.strip().upper() for t in pg.locator(".tab.active").all_inner_texts()]
    out.append(("deleting the filtered project shows every card under ALL", shown == 3 and active == ["ALL"],
                f"cards {shown} of 3, active tab {active}"))
    restored, members = False, []
    if undo:
        pg.click("#toast .toast-action"); pg.wait_for_timeout(250)
        restored = pg.locator(".tab", has_text="Ashoka").count() == 1
        members = [t.get("projectId") for t in mirror(pg).get("tasks", [])]
    out.append(("Undo after DEL restores the project and its tasks", undo and restored and len(members) == 3 and all(members),
                f"undo offered {undo}, project back {restored}, projectIds {members}"))
    c.close()
    return out


# ======================================================================== P4

def check_a11(env) -> list[Result]:
    out = []
    db = FakeTurso(); db.table = True; db.hold = True
    c = env.ctx(); c.route(DB_ROUTE, db.handle)
    c.add_init_script(seed_script([task(id="e", title="Existing task")]))
    c.add_init_script("if (location.protocol.startsWith('http')) localStorage.setItem('docket.turso.v1', "
                      f"JSON.stringify({{url: '{DB_URL}', token: 'good-token'}}));")
    pg = c.new_page(); pg.goto(env.url); pg.wait_for_timeout(1000)
    cards = len(board_titles(pg))
    pg.fill("#quick-add-input", "Typed during boot"); pg.press("#quick-add-input", "Enter"); pg.wait_for_timeout(250)
    opened, captured = pg.is_visible("#card-modal"), "Typed during boot" in titles(pg)
    out.append(("with the database hung, the board renders and quick-add captures", cards >= 1 and opened and captured,
                f"{cards} of 1 cards at 1.0 s; panel opened {opened}; task stored {captured}"))
    db.release(); pg.wait_for_timeout(300)
    c.close()

    ref = None
    for label, with_db in (("no database", False), ("database hung", True)):
        db = FakeTurso(); db.table = True; db.hold = with_db
        c = env.ctx(color_scheme="dark"); c.route(DB_ROUTE, db.handle)
        creds = (f"localStorage.setItem('docket.turso.v1', JSON.stringify({{url: '{DB_URL}', token: 'good-token'}}));"
                 if with_db else "")
        c.add_init_script("if (location.protocol.startsWith('http')) { localStorage.setItem('docket.theme', 'light'); " + creds +
                          " document.addEventListener('DOMContentLoaded', () => requestAnimationFrame(() => {"
                          " window.__firstFrame = getComputedStyle(document.body).backgroundColor; })); }")
        pg = c.new_page(); pg.goto(env.url); pg.wait_for_timeout(1200)
        first, now = pg.evaluate("window.__firstFrame"), pg.evaluate("getComputedStyle(document.body).backgroundColor")
        if ref is None:
            ref = now  # the settled Light background, no database in the way
        out.append((f"stored Light on a Dark system paints Light first ({label})", first == ref and now == ref,
                    f"first frame {first}, at 1.2 s {now}, Light is {ref}"))
        db.release(); pg.wait_for_timeout(200)
        c.close()
    return out


def check_a13(env) -> list[Result]:
    out = []
    db = FakeTurso(); c = env.ctx(); c.route(DB_ROUTE, db.handle)
    pg = c.new_page(); boot(pg, env.url); connect_db(pg)
    connect_db(pg, token="good-tokem")
    token = json.loads(pg.evaluate("localStorage.getItem('docket.turso.v1')") or "{}").get("token")
    err = pg.is_visible("#db-modal-error")
    toast = pg.inner_text("#toast") if pg.is_visible("#toast") else ""
    out.append(("a typo in a second connect is caught and keeps the old token",
                err and token == "good-token" and "connected to database" not in toast.lower(),
                f"inline error {err}, stored token {token!r}, toast {toast!r}"))
    c.close()

    db1, db2 = FakeTurso(), FakeTurso(token="t2")
    c = env.ctx(); c.route(DB_ROUTE, db1.handle); c.route("https://new.turso.io/v2/pipeline", db2.handle)
    pg = c.new_page(); boot(pg, env.url); connect_db(pg)
    quick_add(pg, "Moving house"); pg.wait_for_timeout(700)
    connect_db(pg, token="t2", url="libsql://new.turso.io")
    quick_add(pg, "Another edit"); pg.wait_for_timeout(900)
    out.append(("switching to a fresh database creates its table and writes", db2.table and db2.writes >= 1,
                f"requests {db2.log}, rows written {db2.writes}"))
    c.close()

    c = env.ctx(); seen: list[str] = []

    def spy(route, request):
        if request.method == "POST":
            seen.append(request.url)
        route.continue_()
    c.route("**/*", spy)
    pg = c.new_page(); boot(pg, env.url)
    connect_db(pg, url="my-db-org.turso.io")
    local = [u.replace(env.url, "<docket>/") for u in seen if u.startswith(env.url)]
    err = pg.is_visible("#db-modal-error")
    out.append(("a URL without a scheme is rejected before any request", not local and err,
                f"POSTs to the page's own origin {local}, inline error {err}"))
    c.close()
    return out


# ======================================================================== P5

def check_a12(env) -> list[Result]:
    out = []
    origin = env.url.rstrip("/")
    c = env.ctx(sw="allow"); c.grant_permissions(["notifications"], origin=origin); c.add_init_script(NOTIF_TRAP)
    pg = c.new_page(); boot(pg, env.url, 1500)
    far = (TODAY + dt.timedelta(days=30)).isoformat()
    quick_add(pg, "End-of-semester paper", close=False)
    pg.fill("#f-date", far); pg.fill("#f-time", "10:00"); pg.click("#f-save"); pg.wait_for_timeout(800)
    n1 = pg.evaluate("window.__notes.length")
    pg.reload(); pg.wait_for_timeout(1500)
    n2 = pg.evaluate("window.__notes.length")
    out.append(("a due time 30 days out fires nothing now", n1 == 0 and n2 == 0, f"{n1} on Save, {n2} on reload"))
    c.close()

    c = env.ctx(sw="allow"); c.grant_permissions(["notifications"], origin=origin); c.add_init_script(NOTIF_TRAP)
    c.clock.install()
    pg = c.new_page(); boot(pg, env.url, 1500)
    now = dt.datetime.fromtimestamp(pg.evaluate("Date.now()") / 1000)
    # 32, not 31: the time field truncates to HH:MM, so at +31 the warning
    # landed 0–60 s out and, near a minute boundary, fired before the finishing
    # keys were pressed. At +32 it is 60–120 s out, inside run_for(2 min).
    due = now + dt.timedelta(minutes=32)
    for name, repeat in (("Control", None), ("Submit form", None), ("Drag done", None), ("Water plants", "day")):
        quick_add(pg, name, close=False)
        pg.fill("#f-date", due.date().isoformat()); pg.fill("#f-time", due.strftime("%H:%M"))
        if repeat:
            pg.select_option("#f-repeat-every", repeat)
        pg.click("#f-save"); pg.wait_for_timeout(150)
    card(pg, "Submit form").first.focus(); pg.keyboard.press("3"); pg.wait_for_timeout(150)
    card(pg, "Water plants", "#body-todo").first.focus(); pg.keyboard.press("3"); pg.wait_for_timeout(150)
    card(pg, "Drag done").first.drag_to(pg.locator("#col-done .column-body")); pg.wait_for_timeout(150)
    pg.clock.run_for(2 * 60 * 1000); pg.wait_for_timeout(600)
    early = pg.evaluate("window.__notes")
    got = lambda notes, name: any(name in n for n in notes)  # noqa: E731
    out.append(("an unfinished task's warning fires (control)", got(early, "Control"), f"notifications {early}"))
    out.append(("finishing by key or drag cancels the reminder",
                not got(early, "Submit form") and not got(early, "Drag done") and not got(early, "Water plants"),
                f"notifications {early}"))
    pg.clock.run_for(24 * 60 * 60 * 1000); pg.wait_for_timeout(800)
    later = pg.evaluate("window.__notes")
    # The next occurrence's own 30-minute warning, not the finished one's left-over timers.
    warn = lambda notes: sum(1 for n in notes if "30 MIN" in n and "Water plants" in n)  # noqa: E731
    out.append(("the next occurrence of a repeat is armed without a reload", warn(later) - warn(early) >= 1,
                f"Water plants warnings: {warn(early)} in the first 2 min, {warn(later)} after 24 h"))
    c.close()
    return out


def check_c7(env) -> list[Result]:
    default = "Object.defineProperty(Notification, 'permission', { get: () => 'default' });"
    c = env.ctx(); c.add_init_script(default)
    pg = c.new_page(); boot(pg, env.url)
    empty = pg.is_visible("#notif-banner")
    c.close()
    c = env.ctx(); c.add_init_script(default)
    c.add_init_script(seed_script([task(id="t", title="Lab", dueDate=(TODAY + dt.timedelta(days=2)).isoformat(), dueTime="10:00")]))
    pg = c.new_page(); boot(pg, env.url)
    timed = pg.is_visible("#notif-banner")
    c.close()
    return [("the notification banner waits for a due time", not empty and timed,
             f"banner with no tasks {empty}, with a timed task {timed}")]


# ======================================================================== P6

def check_a4(env) -> list[Result]:
    db = FakeTurso(); a, b = two_devices(env, db)
    pa = a.new_page(); boot(pa, env.url); connect_db(pa)
    for t in ("Essay", "Lab report", "Reading"):
        quick_add(pa, t)
    pa.wait_for_timeout(700)
    pb = b.new_page(); boot(pb, env.url); connect_db(pb)
    note = "Room 204, bring the TA's rubric"
    open_card(pb, "Lab report"); pb.fill("#f-notes", note); pb.click("#f-save"); pb.wait_for_timeout(800)
    top = card(pa, "Essay", "#body-todo").bounding_box()["y"] - pa.locator("#col-todo").bounding_box()["y"]
    card(pa, "Reading", "#body-todo").drag_to(pa.locator("#col-todo"), target_position={"x": 40, "y": top + 5})
    pa.wait_for_timeout(800)
    focus_event(pb)
    in_db = next((t.get("notes") for t in db.tasks() if t.get("title") == "Lab report"), None)
    on_b = next((t.get("notes") for t in mirror(pb).get("tasks", []) if t.get("title") == "Lab report"), None)
    a.close(); b.close()
    return [("a drag on one device keeps another device's edit", in_db == note and on_b == note,
             f"notes in the database {in_db!r}, on B {on_b!r}")]


def check_a14(env) -> list[Result]:
    c = env.ctx()
    now = dt.datetime.now(dt.timezone.utc)
    c.add_init_script(seed_script([task(id="t1", title="Finished last week", status="done", doneAt=iso(now - dt.timedelta(days=8)),
                                        createdAt=iso(now - dt.timedelta(days=9)), updatedAt=iso(now - dt.timedelta(days=8)))]))
    pg = c.new_page(); boot(pg, env.url)
    pg.click("#view-archive-btn"); pg.wait_for_timeout(150)
    pg.click(".btn-restore"); pg.wait_for_timeout(200)
    rows = pg.locator(".archive-row").count()
    pg.click("#view-board-btn"); pg.wait_for_timeout(150)
    shown = board_titles(pg)
    c.close()
    return [("Restore puts the card back on the board", "Finished last week" in shown and rows == 0,
             f"archive rows after Restore {rows}, board {shown}")]


def check_a15(env) -> list[Result]:
    c = env.ctx()
    c.add_init_script(seed_script([task(id="w", title="Water plants", dueDate=TODAY.isoformat(), recurrence={"every": "day", "interval": 1})]))
    pg = c.new_page(); boot(pg, env.url)
    card(pg, "Water plants").first.focus()
    for k in ("3", "2", "3"):
        pg.keyboard.press(k); pg.wait_for_timeout(100)
    open_ = [t.get("dueDate") for t in mirror(pg).get("tasks", []) if t.get("title") == "Water plants" and t.get("status") != "done"]
    c.close()
    return [("done, back, done leaves one next occurrence", len(open_) == 1, f"open occurrences {open_}")]


def check_a22(env) -> list[Result]:
    out = []
    c = env.ctx()
    c.add_init_script(seed_script([task(id="a", title="A low", priority="low", status="doing"),
                                   task(id="b", title="B high", priority="high", status="doing"),
                                   task(id="c", title="C", status="todo"), task(id="d", title="D", status="todo")]))
    pg = c.new_page(); boot(pg, env.url)
    top = card(pg, "C", "#body-todo").bounding_box()["y"] - pg.locator("#col-todo").bounding_box()["y"]
    card(pg, "D", "#body-todo").drag_to(pg.locator("#col-todo"), target_position={"x": 40, "y": top + 5}); pg.wait_for_timeout(150)
    card(pg, "C", "#body-todo").focus(); pg.keyboard.press("2"); pg.wait_for_timeout(150)
    doing = col(pg, "doing")
    out.append(("a card moved by key keeps the column's priority sort", doing == ["B high", "C", "A low"], f"In progress {doing}"))
    c.close()

    p1 = {"id": "p1", "name": "Ashoka", "description": "", "color": "#2F81F7", "createdAt": T0}
    p2 = {"id": "p2", "name": "Home", "description": "", "color": "#3BA55D", "createdAt": T0}
    c = env.ctx()
    c.add_init_script(seed_script([task(id="x", title="X home", projectId="p2"), task(id="y", title="Y home", projectId="p2"),
                                   task(id="a", title="A ashoka", projectId="p1"), task(id="c", title="C ashoka", projectId="p1")], [p1, p2]))
    pg = c.new_page(); boot(pg, env.url)
    pg.locator(".tab", has_text="Ashoka").click(); pg.wait_for_timeout(150)
    box, colbox = card(pg, "C ashoka", "#body-todo").bounding_box(), pg.locator("#col-todo").bounding_box()
    card(pg, "A ashoka", "#body-todo").drag_to(pg.locator("#col-todo"),
                                               target_position={"x": 40, "y": box["y"] + box["height"] - colbox["y"] + 20})
    pg.wait_for_timeout(150)
    shown = col(pg, "todo")
    out.append(("a drag inside a filtered column lands where dropped", shown == ["C ashoka", "A ashoka"], f"filtered column {shown}"))
    c.close()
    return out


def check_a24(env) -> list[Result]:
    out = []
    c = env.ctx()
    c.add_init_script(seed_script([task(id="m", title="Pay rent", dueDate="2027-01-31", recurrence={"every": "month", "interval": 1})]))
    pg = c.new_page(); boot(pg, env.url)
    chain = ["2027-01-31"]
    for _ in range(3):
        card(pg, "Pay rent", "#body-todo").first.focus(); pg.keyboard.press("3"); pg.wait_for_timeout(120)
        nxt = [t.get("dueDate") for t in mirror(pg).get("tasks", []) if t.get("status") != "done"]
        chain.append(nxt[0] if nxt else None)
    out.append(("monthly from the 31st keeps its anchor", chain == ["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30"],
                " -> ".join(str(x) for x in chain)))
    c.close()
    late = (TODAY - dt.timedelta(days=10)).isoformat()
    c = env.ctx()
    c.add_init_script(seed_script([task(id="p", title="Take vitamin", dueDate=late, recurrence={"every": "day", "interval": 1})]))
    pg = c.new_page(); boot(pg, env.url)
    card(pg, "Take vitamin").first.focus(); pg.keyboard.press("3"); pg.wait_for_timeout(120)
    nxt = [t.get("dueDate") for t in mirror(pg).get("tasks", []) if t.get("status") != "done"]
    ok = bool(nxt) and nxt[0] > TODAY.isoformat()
    out.append(("a late daily task completes into a future one", ok, f"due {late}, completed {TODAY}, next due {nxt}"))
    c.close()
    return out


def check_a25(env) -> list[Result]:
    now = dt.datetime.now(dt.timezone.utc)
    wed = now - dt.timedelta(days=(now.weekday() - 2) % 7)  # Tue+Wed share a week under any convention
    done = [wed - dt.timedelta(weeks=k, days=d) for k in (3, 4, 5) for d in (0, 1)]
    c = env.ctx()
    c.add_init_script(seed_script([task(id=f"d{i}", title=f"Finished {i}", status="done", doneAt=iso(d),
                                        createdAt=iso(d - dt.timedelta(days=2)), updatedAt=iso(d)) for i, d in enumerate(done)]))
    pg = c.new_page(); boot(pg, env.url)
    pg.click("#view-archive-btn"); pg.wait_for_timeout(150)
    rail = pg.inner_text("#archive-rail").replace("\n", " ")
    c.close()
    return [("Busiest week counts the weeks work was finished in", "across 3 weeks" in rail.lower(),
             f"rail reads {rail[rail.upper().find('BUSIEST'):][:90]!r}")]


def check_c3(env) -> list[Result]:
    c = env.ctx()
    c.add_init_script(seed_script([task(id="o", title="Morning lab", dueDate=TODAY.isoformat(), dueTime="00:01")]))
    pg = c.new_page(); boot(pg, env.url)
    pg.click("#view-agenda-btn"); pg.wait_for_timeout(150)
    group = pg.evaluate("""() => { for (const g of document.querySelectorAll('.agenda-group'))
        if ([...g.querySelectorAll('.agenda-title')].some(t => t.textContent === 'Morning lab')) return g.querySelector('.agenda-label').textContent;
        return null; }""")
    c.close()
    return [("a task past its time today files under Overdue", (group or "").lower() == "overdue", f"agenda group {group!r}")]


# ======================================================================== P7

def check_a16(env) -> list[Result]:
    out = []
    c = env.ctx(); pg = c.new_page(); boot(pg, env.url)
    for t in ("One", "Two", "Three"):
        quick_add(pg, t)
    card(pg, "Three").click(); pg.wait_for_timeout(150)
    inside = pg.evaluate("!!document.activeElement.closest('#card-modal')")
    out.append(("opening a card puts focus in its panel", inside,
                f"focus on {pg.evaluate('document.activeElement.id || document.activeElement.className')!r}"))
    card(pg, "Three").focus(); pg.keyboard.press("3"); pg.wait_for_timeout(150)
    st = status_of(pg, "Three")
    card(pg, "Three").focus(); pg.keyboard.press("n"); pg.wait_for_timeout(100)
    ae = pg.evaluate("document.activeElement.id")
    out.append(("board keys do nothing while the panel is open", st == "todo" and ae != "quick-add-input",
                f"status after 3: {st}; focus after N: {ae!r}"))
    pg.keyboard.press("Escape"); pg.wait_for_timeout(150)
    pg.click("#open-db-modal-btn"); pg.keyboard.press("Escape"); pg.wait_for_timeout(150)
    closed = not pg.is_visible("#db-modal")
    out.append(("Escape closes the database modal", closed, f"database modal open after Escape: {not closed}"))
    c.close()
    return out


def check_a19(env) -> list[Result]:
    out = []
    c = env.ctx(); pg = c.new_page(); boot(pg, env.url)
    quick_add(pg, "Econ assignment", close=False)
    note = "Q3 uses the 2019 dataset, cite Wooldridge ch. 7"
    for i, how in enumerate(("Escape", "backdrop click", "x button")):
        if not pg.is_visible("#card-modal"):
            open_card(pg, "Econ assignment")
        pg.fill("#f-notes", f"{note} #{i}"); pg.fill("#f-date", "2026-10-01")
        if how == "Escape":
            pg.keyboard.press("Escape")
        elif how == "backdrop click":
            pg.mouse.click(5, 400)
        else:
            pg.click("#card-modal-close")
        pg.wait_for_timeout(200)
        t = next((t for t in mirror(pg).get("tasks", []) if t.get("title") == "Econ assignment"), {})
        out.append((f"typed notes survive closing by {how}", t.get("notes") == f"{note} #{i}" and t.get("dueDate") == "2026-10-01",
                    f"notes {t.get('notes')!r}, due {t.get('dueDate')}"))
    c.close()
    return out


def check_c1(env) -> list[Result]:
    out = []
    c = env.ctx()
    c.add_init_script(seed_script([task(id="s", title="Lab report", subtasks=[{"id": "s1", "title": "Method", "done": False},
                                                                             {"id": "s2", "title": "Results", "done": False}])]))
    pg = c.new_page(); boot(pg, env.url)
    open_card(pg, "Lab report")
    pg.locator("#f-subtasks").locator("xpath=..").click(position={"x": 4, "y": 4}); pg.wait_for_timeout(100)
    ticked = pg.is_checked(".sub-done >> nth=0")
    out.append(("clicking the SUBTASKS heading ticks nothing", not ticked, f"first subtask ticked {ticked}"))
    pg.keyboard.press("Escape"); pg.wait_for_timeout(150)
    pg.click("#new-project-btn"); pg.click(".swatch-btn >> nth=5")
    before = pg.input_value("#new-project-color")
    pg.locator(".colour-row").locator("xpath=..").click(position={"x": 4, "y": 4}); pg.wait_for_timeout(100)
    after = pg.input_value("#new-project-color")
    out.append(("clicking the COLOUR heading keeps the colour", before == after, f"{before} -> {after}"))
    c.close()
    return out


# ======================================================================== P8

def check_a17(env) -> list[Result]:
    out = []
    c = env.ctx(sw="allow"); pg = c.new_page()
    pg.goto(env.url); pg.evaluate("navigator.serviceWorker.ready"); pg.wait_for_timeout(1500)
    hosts = sorted(set(pg.evaluate("performance.getEntriesByType('resource').map(e => new URL(e.name).host)"
                                   ".filter(h => !h.startsWith('127.0.0.1'))")))
    out.append(("a normal load contacts no third-party host", not hosts, f"hosts {hosts}"))
    c.set_offline(True); pg.reload(); pg.wait_for_timeout(1500)
    loaded = pg.evaluate("[...document.fonts].some(f => f.family.replace(/\"/g, '') === 'Archivo Black' && f.status === 'loaded')")
    shell = pg.is_visible("#quick-add-input")
    out.append(("offline, the shell and Archivo Black both load", loaded and shell, f"shell {shell}, Archivo Black {loaded}"))
    c.close()
    return out


def check_a21(env) -> list[Result]:
    site = copy_site(env.root)
    url, srv = serve(site, cached=True)
    c = env.browser.new_context(service_workers="allow"); pg = c.new_page()
    pg.goto(url); pg.evaluate("navigator.serviceWorker.ready"); pg.wait_for_timeout(1000)
    app = site / "js/app.js"; app.write_text(app.read_text() + "\nwindow.__ver = 2;\n")
    sw = site / "service-worker.js"
    sw.write_text(re.sub(r'(const CACHE = ")([^"]+)(")', r'\1\2-next\3', sw.read_text(), count=1))
    pg.goto(url); pg.wait_for_timeout(2500)
    pg.goto(url); pg.wait_for_timeout(1000)
    new = pg.evaluate("window.__ver === 2")
    c.close(); srv.shutdown()
    return [("a deploy inside the 10-minute cache window reaches the page", new, f"page runs the deployed app.js: {new}")]


def check_a23(env) -> list[Result]:
    c = env.browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, service_workers="block")
    c.add_init_script(NO_FOLDER_ACCESS)
    c.add_init_script(seed_script([task(id="t", title="Problem set 3")],
                                  [{"id": f"p{i}", "name": n, "description": "", "color": "#2F81F7", "createdAt": T0}
                                   for i, n in enumerate(("Ashoka", "Home", "Internship", "Health"))]))
    pg = c.new_page(); boot(pg, env.url)
    m = pg.evaluate("""() => { const b = (s) => document.querySelector(s).getBoundingClientRect();
        return { search: [Math.round(b('.search-box').left), Math.round(b('.search-box').right)], quick: Math.round(b('.quick-add').top),
                 hint: getComputedStyle(document.querySelector('.quick-add-hint')).display }; }""")
    c.close()
    on_screen = m["search"][0] >= 0 and m["search"][1] <= 390
    return [("at 390 px the search box is on-screen and quick-add sits in the top half",
             on_screen and m["quick"] < 422 and m["hint"] == "none",
             f"search box x {m['search']}, quick-add top {m['quick']} px, N hint display {m['hint']!r}")]


def check_c2(env) -> list[Result]:
    c = env.ctx(); pg = c.new_page(); boot(pg, env.url)
    for t in ("Alpha", "Beta"):
        quick_add(pg, t)
    pg.wait_for_timeout(500)
    card(pg, "Alpha").hover(); pg.wait_for_timeout(300)
    tf = pg.evaluate("getComputedStyle(document.querySelector('.card:hover')).transform")
    c.close()
    return [("hovering a card lifts it", "-3" in tf, f"hovered transform {tf!r}")]


CONTRAST = """() => {
  const lum = (c) => { const [r, g, b] = c.match(/[\\d.]+/g).map(Number).slice(0, 3).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const bgOf = (e) => { for (; e; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; if (c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c; } return 'rgb(255,255,255)'; };
  document.querySelector('#reconnect-banner').hidden = false;
  const t = document.querySelector('#toast'); t.hidden = false; t.className = 'toast toast-error'; t.textContent = 'IMPORT FAILED';
  const out = {};
  for (const [k, s] of [['alert banner', '#reconnect-banner span'], ['HIGH pill', '.pill-high'], ['error toast', '#toast']]) {
    const e = document.querySelector(s); if (!e) { out[k] = null; continue; }
    const a = lum(getComputedStyle(e).color), b = lum(bgOf(e));
    out[k] = +((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2);
  }
  return out;
}"""


def check_c4(env) -> list[Result]:
    out = []
    for scheme in ("light", "dark"):
        c = env.ctx(color_scheme=scheme)
        c.add_init_script(seed_script([task(id="h", title="Urgent", priority="high")]))
        pg = c.new_page(); boot(pg, env.url)
        r = pg.evaluate(CONTRAST)
        out.append((f"white-on-red text is at least 4.5:1 ({scheme})", all(v is not None and v >= 4.5 for v in r.values()), str(r)))
        c.close()
    return out


def check_c5(env) -> list[Result]:
    c = env.ctx(); pg = c.new_page(); boot(pg, env.url)
    f = pg.evaluate("['#sync-strip', '#db-strip'].map(s => { const c = getComputedStyle(document.querySelector(s)); return [c.fontSize, c.textTransform]; })")
    c.close()
    return [("the two status labels match", f[0] == f[1], f"folder strip {f[0]}, database strip {f[1]}")]


# ======================================================================== P9

def check_c6(env) -> list[Result]:
    c = env.browser.new_context(timezone_id="Asia/Kolkata", service_workers="block")
    c.clock.set_fixed_time("2026-09-24T01:30:00+05:30")
    pg = c.new_page(); pg.goto(env.url); pg.wait_for_timeout(800)
    with pg.expect_download() as dl:
        pg.click("#export-btn")
    name = dl.value.suggested_filename
    c.close()
    return [("the export filename uses local time", "2026-09-24-01-30" in name, f"01:30 IST exported as {name}")]


def check_n2(env) -> list[Result]:
    paths = ["js/storage.backup-20260825-210155.js", ".impeccable/hook.cache.json", ".claude/agents/x.md", "tools/audit/__pycache__/x.pyc"]
    missed = [p for p in paths if subprocess.run(["git", "-C", str(env.root), "check-ignore", "-q", p]).returncode != 0]
    return [("backups, tool caches and local agent files are ignored", not missed, f"not ignored: {missed}")]


def check_n3(env) -> list[Result]:
    text = (env.root / "README.md").read_text()
    return [("README no longer says MODE", "**MODE**" not in text, "found **MODE**" if "**MODE**" in text else "clean")]


def check_n5(env) -> list[Result]:
    c = env.ctx(); pg = c.new_page(); boot(pg, env.url)
    pg.click("#view-archive-btn"); pg.wait_for_timeout(100)
    pg.click("#guide-btn"); pg.wait_for_timeout(300)
    for _ in range(3):
        pg.click("#tour-next"); pg.wait_for_timeout(250)
    pg.click("#tour-skip"); pg.wait_for_timeout(200)
    view = pg.evaluate("window.Docket.App.currentView()")
    c.close()
    return [("the tour hands back the view it started on", view == "archive", f"started on archive, ended on {view}")]


# ======================================================================== all packages

def check_smoke(env) -> list[Result]:
    out = []
    projects = [{"id": f"p{i}", "name": n, "description": "", "color": col_, "createdAt": T0}
                for i, (n, col_) in enumerate([("Ashoka", "#2F81F7"), ("Home", "#3BA55D"), ("Internship", "#A371F7")])]
    now = dt.datetime.now(dt.timezone.utc)
    tasks = [task(id=f"t{i}", title=f"Task {i}", projectId=f"p{i % 3}", status=s, priority=p,
                  dueDate=(TODAY + dt.timedelta(days=i - 4)).isoformat() if i % 2 else None,
                  dueTime="09:00" if i % 4 == 1 else None, notes="see syllabus" if i % 3 == 0 else "",
                  subtasks=[{"id": f"s{i}", "title": "step", "done": bool(i % 2)}] if i % 5 == 0 else [],
                  recurrence={"every": "week", "interval": 1} if i == 6 else None)
             for i, (s, p) in enumerate([("todo", "high"), ("todo", "med"), ("todo", "low"), ("doing", "high"),
                                         ("doing", "med"), ("todo", "med"), ("todo", "low"), ("doing", "low")])]
    tasks.append(task(id="dn", title="Recently done", status="done", doneAt=iso(now - dt.timedelta(days=1))))
    tasks.append(task(id="ar", title="Long done", status="done", doneAt=iso(now - dt.timedelta(days=20)),
                      archivedAt=iso(now - dt.timedelta(days=13)), createdAt=iso(now - dt.timedelta(days=25))))
    for seeded in (False, True):
        for scheme in ("light", "dark"):
            for vp in ((1500, 950), (390, 844)):
                c = env.ctx(color_scheme=scheme, viewport=vp)
                if seeded:
                    c.add_init_script(seed_script(tasks, projects))
                pg = c.new_page(); boot(pg, env.url)
                for v in ("#view-agenda-btn", "#view-archive-btn", "#view-board-btn"):
                    pg.click(v); pg.wait_for_timeout(120)
                errs = errors(pg)
                cards = len(board_titles(pg))
                expect = 9 if seeded else 0
                label = f"{'seeded' if seeded else 'fresh'} profile, {scheme}, {vp[0]} px"
                out.append((label, not errs and cards == expect, f"errors {errs[:2]}, cards {cards} of {expect}"))
                c.close()
    return out


CHECKS = {
    "A1": ("P2", check_a1), "A2": ("P1", check_a2), "A3": ("P3", check_a3), "A4": ("P6", check_a4),
    "A5": ("P3", check_a5), "A6": ("P2", check_a6), "A7": ("P2", check_a7), "A8": ("P2", check_a8),
    "A9": ("P2", check_a9), "A10": ("P1", check_a10), "A11": ("P4", check_a11), "A12": ("P5", check_a12),
    "A13": ("P4", check_a13), "A14": ("P6", check_a14), "A15": ("P6", check_a15), "A16": ("P7", check_a16),
    "A17": ("P8", check_a17), "A18": ("P2", check_a18), "A19": ("P7", check_a19), "A20": ("P3", check_a20),
    "A21": ("P8", check_a21), "A22": ("P6", check_a22), "A23": ("P8", check_a23), "A24": ("P6", check_a24),
    "A25": ("P6", check_a25), "C1": ("P7", check_c1), "C2": ("P8", check_c2), "C3": ("P6", check_c3),
    "C4": ("P8", check_c4), "C5": ("P8", check_c5), "C6": ("P9", check_c6), "C7": ("P5", check_c7),
    "N2": ("P9", check_n2), "N3": ("P9", check_n3), "N5": ("P9", check_n5), "SMOKE": ("all", check_smoke),
}


def resolve(ids: list[str]) -> list[str]:
    if not ids:
        return list(CHECKS)
    out = []
    for raw in ids:
        k = raw.upper()
        if k in CHECKS:
            out.append(k)
        elif re.fullmatch(r"P\d+", k):
            out += [cid for cid, (pkg, _) in CHECKS.items() if pkg == k]
        else:
            raise SystemExit(f"unknown check {raw!r} — try --list")
    return list(dict.fromkeys(out))


def main() -> int:
    ap = argparse.ArgumentParser(description="Docket audit checks: PASS means the fixed behaviour held.")
    ap.add_argument("ids", nargs="*", help="check ids (A1, C4, SMOKE) or packages (P2); default: all")
    ap.add_argument("--root", type=Path, default=DOCKET, help="Docket tree to serve (default: this repo)")
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args()
    if args.list:
        for cid, (pkg, fn) in CHECKS.items():
            print(f"{cid:<6} {pkg:<4} {fn.__name__}")
        return 0
    from playwright.sync_api import sync_playwright
    failed = passed = 0
    with sync_playwright() as pw:
        env = Env(pw, args.root.resolve())
        try:
            for cid in resolve(args.ids):
                t0 = time.time()
                try:
                    results = CHECKS[cid][1](env)
                except Exception as e:  # a check that crashes is a failure with its reason printed
                    results = [("check crashed", False, f"{type(e).__name__}: {str(e).splitlines()[0][:160]}")]
                ok = all(r[1] for r in results)
                passed += ok
                failed += not ok
                print(f"{cid:<6} {'PASS' if ok else 'FAIL'}  ({time.time() - t0:.0f}s)", flush=True)
                for label, good, measured in results:
                    print(f"         {'ok ' if good else 'NO '} {label} — {measured}", flush=True)
        finally:
            env.close()
    print(f"\n{passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
