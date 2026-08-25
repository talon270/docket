// DOCKET · REMINDERS
// · Notification permission is asked once, on an explicit user action, and
//   explained inline — never requested silently on load.
// · Only tasks with a dueTime get a due-time notification (date-only tasks
//   have nothing to fire "at" — a date-only glance is covered by the board's
//   priority sort, by design, per PLAN-docket.md B5).
// · setTimeout-scheduled, in-memory only: reminders reset on reload, which is
//   correct for v1 — no service-worker-backed background scheduling yet.
"use strict";

window.Docket = window.Docket || {};

(function () {
  const timers = new Map(); // taskId -> [timeoutId, timeoutId]

  function permissionState() {
    if (!("Notification" in window)) return "unsupported";
    return Notification.permission;
  }

  async function requestPermission() {
    if (!("Notification" in window)) return "unsupported";
    return Notification.requestPermission();
  }

  function cancel(taskId) {
    const ids = timers.get(taskId);
    if (ids) {
      ids.forEach(clearTimeout);
      timers.delete(taskId);
    }
  }

  function schedule(task) {
    cancel(task.id);
    if (task.status === "done" || !task.dueDate || !task.dueTime) return;
    if (permissionState() !== "granted") return;

    const due = new Date(`${task.dueDate}T${task.dueTime}:00`);
    const fireAt = due.getTime();
    const warnAt = fireAt - 30 * 60 * 1000;
    const now = Date.now();
    const ids = [];

    if (warnAt > now) {
      ids.push(
        setTimeout(() => {
          new Notification(`DUE IN 30 MIN — ${task.title}`);
        }, warnAt - now)
      );
    }
    if (fireAt > now) {
      ids.push(
        setTimeout(() => {
          new Notification(`DUE NOW — ${task.title}`);
        }, fireAt - now)
      );
    }
    if (ids.length) timers.set(task.id, ids);
  }

  function rescheduleAll(tasks) {
    for (const t of tasks) schedule(t);
  }

  window.Docket.Reminders = { permissionState, requestPermission, schedule, cancel, rescheduleAll };
})();
