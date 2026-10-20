/**
 * Glance: the corner dock. A todo board on two feet with a sticky pad, and a
 * mini board on a stand that mirrors its four rows. The rows hold the four
 * newest To do tasks the board column shows, oldest at the top. A task added
 * peels a note off the pad onto the next row; the mini board fills the same
 * row a beat later and takes the one bright mark. The pointer only reads: the
 * read-out names the row, a press on a filled row opens that task.
 *
 * The figure never invents a note. Its data comes from app.js, which writes
 * nothing but a count and a replay flag:
 *   in   "docket:todos" on the stage, detail { count, replay, instant }
 *   out  "docket:open"  from the stage, detail = row index, bubbling
 *
 * Motion is on springs, not the Hairline 700ms tween: an add arriving while
 * the last one is still in the air retargets from where the note is.
 */
// Classic scripts share one global scope, and hairline-pegboard.js already
// declares Cam, BW and the rest at its top level; the IIFE keeps these private.
const glanceMount = (() => {
  const {
    Cam, clamp, fillet, fit, lerp, poly, prism, proj, rad, rings, rrect, seg, facing, spring, stepS,
    disposer, mk, pointer, put, register, solid,
  } = HL;

  const BW = 112, BH = 78, BT = 3, FZ = 5, ROWS = [58, 42, 26, 10], NW = 44, NH = 12, NU = 10;
  const ROT = [-2.5, 1.6, -1.2, 2.2], PAD = [84, 60, 3.6], ARC = 12, NY = 1.2;
  const MX = 86, MY = 26, MW = 30, MH = 38, MT = 2.2, MZ = 4, MROW = (i) => MH - 10 - i * 7;
  // STEP staggers rows outward from the first one that changes (rule 02); BACK
  // is how long a full board's fourth note is away from its row when a fifth
  // task arrives. The beat between a note landing and the mini board seeing it
  // is the figure's value (range below); the host passes the middle one, 300ms.
  const STEP = 60, BACK = 420;

  /** A face's (u, v) outline, mapped into the world at depth y from x0 and z0. */
  const onFace = (P, pts, x0, y, z0) => pts.map((p) => P(x0 + p[0], y, z0 + p[1]));
  const uv = (ring) => ring.map((q) => [q.u, q.v]);

  /** A thin upright plate: its back (dim, for the thickness), its face, and its frame crease. Returns the face. */
  function plate(P, g, w, h, r, inset, x0, y, t, z0) {
    const out = fillet([[0, 0], [w, 0], [w, h], [0, h]], [r, r, r, r]);
    const inn = fillet([[inset, inset], [w - inset, inset], [w - inset, h - inset], [inset, h - inset]], [r - 1, r - 1, r - 1, r - 1]);
    mk("path", { d: poly(onFace(P, out, x0, y - t, z0)), class: "lo" }, g);
    const face = mk("path", { d: poly(onFace(P, out, x0, y, z0)), class: "sil" }, g);
    mk("path", { d: poly(onFace(P, inn, x0, y, z0)), class: "nf lo" }, g);
    return face;
  }

  /** A note, local (a, b) in 0..NW × 0..NH, centred at (u, v) on the board, rot degrees in the face, lifted to depth y. */
  function noteAt(P, u, v, y, rot) {
    const c = Math.cos(rad(rot)), s = Math.sin(rad(rot));
    const w = (a, b) => P(u + (a - NW / 2) * c - (b - NH / 2) * s, y, FZ + v + (a - NW / 2) * s + (b - NH / 2) * c);
    const shape = fillet([[0, 0], [NW, 0], [NW, NH], [0, NH]], [1.6, 1.6, 1.6, 1.6]);
    return {
      face: poly(shape.map((p) => w(p[0], p[1]))),
      box: poly(uv(rrect(3.5, 3, 9.5, 9, 1.5, 3)).map((p) => w(p[0], p[1]))),
      line: seg(w(14, 6), w(NW - 6, 6)) + seg(w(14, 3.5), w(NW - 16, 3.5)),
    };
  }

  function mount({ stage, svg, read }, value) {
    const bag = disposer();
    let lag = value;

    // Fitted with a note at the top of its arc, so nothing leaves the frame in any pose.
    const C = Cam(45, 0.5, 2.0);
    fit(C, [[0, -10, 0], [BW, 8, 0], [0, -BT, FZ + BH], [BW, 0, FZ + BH], [MX - 3, MY - 6, 0], [MX + MW + 3, MY + 6, 0],
      [MX + MW, MY, MZ + MH], [50, ARC + 2, FZ + 60]], 200, 166);
    const P = proj(C), front = facing(C);
    const g = mk("g", {}, svg);

    // the board's feet, then the board, its ruled rows, and the pad stuck at its top right
    for (const x of [8, BW - 20]) {
      const [ring, inner] = rings(x, -10, x + 12, 8, 3, 1);
      put(solid(g), prism(P, front, ring, inner, 0, FZ));
    }
    plate(P, g, BW, BH, 4, 4, 0, 0, BT, FZ);
    mk("path", { d: ROWS.map((v) => seg(P(NU, 0.2, FZ + v - 1.5), P(NU + NW, 0.2, FZ + v - 1.5))).join(""), class: "nf lo" }, g);
    for (let k = 0; k < 3; k++) mk("path", { d: noteAt(P, PAD[0], PAD[1] - (3 - k) * 0.7, 0.6 + k, 0).face }, g);

    // Already-held tasks are on their rows from the first frame: a page load is not an add.
    let count = clamp(Number(stage.dataset.count) || 0, 0, 4), over = -1, queue = [];
    const notesG = mk("g", {}, g), notes = [];
    for (let i = 0; i < 4; i++) {
      const grp = mk("g", {}, notesG), on = i < count ? 1 : 0;
      notes.push({
        grp, face: mk("path", { class: "sil" }, grp), box: mk("path", { class: "nf lo" }, grp), line: mk("path", { class: "nf lo" }, grp),
        t: spring(on), m: spring(on), last: null,
      });
    }

    // the mini board: a stand, the tablet, its four rules, and the rows it has seen
    const [sr, si] = rings(MX - 3, MY - 6, MX + MW + 3, MY + 6, 4, 1.2);
    put(solid(g), prism(P, front, sr, si, 0, MZ + 1));
    const tablet = plate(P, g, MW, MH, 4, 2.4, MX, MY, MT, MZ);
    const mface = (pts) => poly(pts.map((p) => P(MX + p[0], MY + 0.2, MZ + p[1])));
    mk("path", { d: ROWS.map((_, i) => seg(P(MX + 5, MY + 0.2, MZ + MROW(i) + 2), P(MX + MW - 5, MY + 0.2, MZ + MROW(i) + 2))).join(""), class: "nf lo" }, g);
    const mini = ROWS.map(() => mk("path", {}, g));

    function draw(i) {
      const n = notes[i], t = n.t.x, f = clamp(n.m.x, 0, 1), key = t.toFixed(4) + f.toFixed(4);
      if (key === n.last) return;
      n.last = key;
      const q = noteAt(P, lerp(PAD[0], NU + NW / 2, t), lerp(PAD[1], ROWS[i] + NH / 2, t),
        lerp(PAD[2], NY, t) + Math.sin(Math.PI * clamp(t, 0, 1)) * ARC, ROT[i] * t);
      n.face.setAttribute("d", q.face); n.box.setAttribute("d", q.box); n.line.setAttribute("d", q.line);
      mini[i].setAttribute("d", f < 0.02 ? "" : mface(uv(rrect(4, MROW(i), 4 + (MW - 8) * f, MROW(i) + 4, 1.6, 3))));
    }

    const B = register(stage, (dt, now) => {
      let moving = queue.length > 0;
      queue = queue.filter(([sp, at, to]) => (now >= at ? ((sp.t = to), false) : true));
      notes.forEach((n, i) => { if (stepS(n.t, dt) | stepS(n.m, dt)) moving = true; draw(i); });
      return moving;
    });
    bag.add(B.unregister);

    /** The one bright mark: the hovered filled row's mini twin, else the newest row's, else the empty tablet. */
    function bright() {
      const s = over >= 0 && over < count ? over : count - 1;
      mini.forEach((el, i) => el.setAttribute("class", i === s ? "hi" : ""));
      tablet.setAttribute("class", s < 0 ? "sil hi" : "sil");
    }

    /** Queues spring sp to head for `to` at time `at`; replaces anything queued for it before. */
    const aim = (sp, to, at) => queue.push([sp, at, to]);
    const drop = (sp) => (queue = queue.filter((q) => q[0] !== sp));

    /** Moves the board to n tasks. Rows that change go staggered from the first that changes; replay re-adds a full board's last row. */
    function show(n, replay, instant) {
      const now = performance.now(), was = count;
      count = clamp(n, 0, 4);
      // The board's first render is the tasks already held, not an add: land them where they belong.
      if (instant) {
        queue = [];
        notes.forEach((r, i) => { r.t.x = r.t.t = r.m.x = r.m.t = i < count ? 1 : 0; r.t.v = r.m.v = 0; draw(i); });
        bright();
        return;
      }
      const from = count > was ? was : was - 1;
      notes.forEach((r, i) => {
        const to = i < count ? 1 : 0;
        if (replay && i === 3 && count === 4 && was === 4) {
          drop(r.t); drop(r.m);
          notesG.appendChild(r.grp);
          aim(r.t, 0, now); aim(r.m, 0, now + lag); aim(r.t, 1, now + BACK); aim(r.m, 1, now + BACK + lag);
          return;
        }
        if (r.t.t === to && !queue.some((q) => q[0] === r.t)) return;
        drop(r.t); drop(r.m);
        // a note on the move paints last, so it passes in front of the rows it crosses
        notesG.appendChild(r.grp);
        const delay = Math.abs(i - from) * STEP;
        aim(r.t, to, now + delay); aim(r.m, to, now + delay + lag);
      });
      bright();
      B.wake();
    }

    // the face's own axes on screen, to read the pointer back as (u, v) on a plane that never moves
    const o = P(0, 0, FZ), pu = P(1, 0, FZ), pv = P(0, 0, FZ + 1);
    const eu = [pu[0] - o[0], pu[1] - o[1]], ev = [pv[0] - o[0], pv[1] - o[1]], det = eu[0] * ev[1] - eu[1] * ev[0];
    /** The row under the point, or -1 off the board's rows. */
    function hit([x, y]) {
      const qx = x - o[0], qy = y - o[1];
      const u = (qx * ev[1] - qy * ev[0]) / det, v = (eu[0] * qy - eu[1] * qx) / det;
      if (u < 4 || u > NU + NW + 4) return -1;
      return ROWS.findIndex((r) => v >= r - 2 && v <= r + NH + 2);
    }

    function hover(a) {
      if (a === over) return;
      over = a;
      const more = Number(stage.dataset.count) > 4 && a === 3 ? "+" : "";
      read.textContent = a < 0 ? "rest" : a < count ? "todo " + (a + 1) + more : "empty";
      bright();
    }

    notes.forEach((_, i) => draw(i));
    bright();
    bag.on(stage, "docket:todos", (e) => { show(e.detail.count, e.detail.replay, e.detail.instant); hover(-1); });
    bag.add(pointer(stage, {
      move: (p) => hover(hit(p)),
      down: (p) => { const a = hit(p); if (a >= 0 && a < count) stage.dispatchEvent(new CustomEvent("docket:open", { detail: a, bubbles: true })); },
      leave: () => hover(-1),
    }));
    bag.add(() => svg.replaceChildren());

    return { set: (v) => { lag = v; }, destroy: bag.dispose };
  }

  return mount;
})();

hairline({
  name: "glance",
  means: "The four newest To do tasks as notes on a board; the mini board beside it sees each new one a beat later.",
  rules: [1, 2, 4, 10],
  range: [0, 300, 700],
  mount: glanceMount,
});
