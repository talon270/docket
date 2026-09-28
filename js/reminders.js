// DOCKET · REMINDERS
// · Notification permission is asked once, on an explicit user action, and
//   explained inline — never requested silently on load.
// · Only tasks with a dueTime get a due-time notification (date-only tasks
//   have nothing to fire "at" — a date-only glance is covered by the board's
//   priority sort, by design, per PLAN-docket.md B5).
// · setTimeout-scheduled, in-memory only: reminders reset on reload, so
//   app.js's mutate() and its periodic sweep both call rescheduleAll() to
//   re-arm from the current task list without needing one.
// · Fires through the service worker's showNotification where one is
//   registered (required on Android), falling back to the Notification
//   constructor otherwise.
"use strict";

window.Docket = window.Docket || {};

(function () {
  const timers = new Map(); // taskId -> [timeoutId, timeoutId]
  // setTimeout stores its delay as a signed 32-bit int; anything past this
  // overflows and fires almost immediately instead of never (A12, measured:
  // a due time 30 days out fired both notifications within 0.5s of Save).
  // The periodic reschedule in app.js re-arms it once the real due time
  // comes within this range.
  const MAX_DELAY_MS = 2147483647;

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

  // Chrome requires notifications to route through a service worker
  // registration once one exists — `new Notification()` throws "Illegal
  // constructor" on Android with a worker registered — so that path is
  // always tried first, and the constructor is the fallback for a browser
  // with no worker at all. getRegistration(), not .ready: .ready never
  // settles when nothing registered (file://, a failed register), and the
  // reminder would vanish without a word.
  function fire(title) {
    const plain = () => new Notification(title);
    if (!("serviceWorker" in navigator)) return plain();
    navigator.serviceWorker
      .getRegistration()
      .then((registration) => (registration ? registration.showNotification(title) : plain()))
      .catch(plain);
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

    if (warnAt > now && warnAt - now <= MAX_DELAY_MS) {
      ids.push(setTimeout(() => fire(`DUE IN 30 MIN — ${task.title}`), warnAt - now));
    }
    if (fireAt > now && fireAt - now <= MAX_DELAY_MS) {
      ids.push(setTimeout(() => fire(`DUE NOW — ${task.title}`), fireAt - now));
    }
    if (ids.length) timers.set(task.id, ids);
  }

  // Clears every timer this module holds before rescheduling, not just the
  // ones for tasks in the list handed in — schedule() alone only cancels the
  // one task it's given, so a task deleted (or finished) since the last call
  // would otherwise keep its stale timer and fire for a task that's gone.
  function rescheduleAll(tasks) {
    for (const ids of timers.values()) ids.forEach(clearTimeout);
    timers.clear();
    for (const t of tasks) schedule(t);
  }

  window.Docket.Reminders = { permissionState, requestPermission, schedule, cancel, rescheduleAll };
})();
