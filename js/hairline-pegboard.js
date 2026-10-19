/**
 * Pegboard: a free-standing pegboard, a grid of holes with eight bare pegs
 * in it and no card on any of them. The pegs near the pointer slide out
 * toward you, each on its own spring, falling off with distance; at rest they
 * stand out unevenly. The slider is the reach, in board units.
 *
 * The pattern: a continuous field, as Terrain, on an upright plane. The
 * pointer is projected onto the board's face, which never moves.
 */
const {
  Cam, circ, clamp, facing, fit, hull, poly, prism, proj, put, ringAt, rings, solid, spring, stepS,
  disposer, mk, pointer, register,
} = HL;

const BW = 112, BH = 86, BT = 4, Z0 = 4, PITCH = 16, HR = 1.6, PR = 3.2, LMIN = 7, LMAX = 32, TIP = 6;
const COLS = 6, ROWS = 5;
const PEGS = [[0, 3], [1, 1], [2, 4], [2, 2], [3, 0], [4, 3], [5, 1], [5, 4]];
const hx = (i) => 16 + i * PITCH, hz = (j) => Z0 + 11 + j * PITCH;

/** Out at u reaches from the pointer: 1, easing to a floor of .12 at the reach and beyond. */
const falloff = (u) => (u >= 1 ? 0.12 : 0.12 + 0.88 * (1 - u * u) * (1 - u * u));

function mount({ stage, svg, read }, value) {
  const bag = disposer();
  let reach = value;

  const C = Cam(45, 0.5, 1.95);
  fit(C, [[0, -14, 0], [BW, 14, 0], [0, -BT, Z0 + BH], [BW, 0, Z0 + BH], [hx(0), LMAX, hz(3) + TIP], [hx(5), LMAX, hz(4) + TIP], [hx(5), LMAX, hz(1)]], 200, 166);
  const P = proj(C), front = facing(C);

  // A ring in the board's face (y), as screen points.
  const disc = (x, y, z, r, n = 12) => Array.from({ length: n }, (_, k) => P(x + r * Math.cos((2 * Math.PI * k) / n), y, z + r * Math.sin((2 * Math.PI * k) / n)));

  const g = mk("g", {}, svg);
  for (const x of [16, BW - 16]) {
    const [fr, fi] = rings(x - 4, -14, x + 4, 14, 4, 1.2);
    put(solid(g), prism(P, front, fr, fi, 0, Z0));
  }
  const [br, bi] = rings(0, -BT, BW, 0, 2, 0.8);
  put(solid(g), prism(P, front, br, bi, Z0, Z0 + BH));
  const holes = [];
  for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) holes.push(poly(disc(hx(i), 0, hz(j), HR)));
  mk("path", { d: holes.join(""), class: "nf lo" }, g);

  // Pegs, painted from the farthest: lower and further left first, as the camera sees them.
  const pegs = PEGS.map(([i, j]) => {
    const u = i / (COLS - 1), v = j / (ROWS - 1);
    const l0 = LMIN + 17 * Math.exp(-((u - 0.8) ** 2 + (v - 0.75) ** 2) / 0.05) + 6 * Math.exp(-((u - 0.2) ** 2 + (v - 0.3) ** 2) / 0.05);
    return { i, j, x: hx(i), z: hz(j), l0, sp: spring(l0, { eps: 0.04 }), drawn: NaN };
  }).sort((a, b) => 0.612 * a.x + 0.5 * a.z - (0.612 * b.x + 0.5 * b.z));
  // Each peg is a hook: a rod out of its hole and a short upturn at the tip, which is nearer, so it goes after.
  for (const p of pegs) { p.body = mk("path", {}, g); p.cap = mk("path", { class: "nf lo" }, g); p.tip = mk("path", {}, g); }

  function drawPeg(p) {
    const l = p.sp.x;
    if (l === p.drawn) return;
    p.drawn = l;
    p.body.setAttribute("d", poly(hull(disc(p.x, 0, p.z, PR).concat(disc(p.x, l, p.z, PR)))));
    p.cap.setAttribute("d", poly(disc(p.x, l, p.z, PR - 0.9)));
    const ring = circ(PR - 0.4, 12).map((q) => ({ ...q, u: q.u + p.x, v: q.v + l - PR }));
    p.tip.setAttribute("d", poly(hull(ringAt(P, ring, p.z).concat(ringAt(P, ring, p.z + TIP)))));
    const lit = l > LMAX * 0.5;
    for (const el of [p.body, p.tip]) { el.classList.toggle("hi", lit); el.classList.toggle("sil", !lit); }
  }

  const B = register(stage, (dt) => {
    let m = false;
    for (const p of pegs) { if (stepS(p.sp, dt)) m = true; drawPeg(p); }
    return m;
  });
  bag.add(B.unregister);

  // The board's face, y = 0: a screen point back to (x, z) on it.
  const o = P(0, 0, 0), ex = P(1, 0, 0), ez = P(0, 0, 1);
  const a = [ex[0] - o[0], ex[1] - o[1]], c = [ez[0] - o[0], ez[1] - o[1]], det = a[0] * c[1] - a[1] * c[0];
  const onFace = ([sx, sy]) => { const dx = sx - o[0], dy = sy - o[1]; return [(dx * c[1] - dy * c[0]) / det, (a[0] * dy - a[1] * dx) / det]; };

  let over = null;
  function retarget() {
    let near = null, best = Infinity;
    for (const p of pegs) {
      if (!over) { p.sp.t = p.l0; continue; }
      const d = Math.hypot(p.x - over[0], p.z - over[1]);
      p.sp.t = clamp(LMAX * falloff(d / reach), LMIN, LMAX);
      if (d < best) { best = d; near = p; }
    }
    read.textContent = near ? `peg ${near.i + 1}·${near.j + 1} · 0` : "rest";
    B.wake();
  }

  bag.add(pointer(stage, {
    move: (p) => { const [x, z] = onFace(p); over = x > -10 && x < BW + 10 && z > Z0 - 10 && z < Z0 + BH + 10 ? [x, z] : null; retarget(); },
    leave: () => { over = null; retarget(); },
  }));
  bag.add(() => svg.replaceChildren());

  return {
    set: (v) => { reach = v; if (over) retarget(); },
    destroy: bag.dispose,
  };
}

hairline({
  name: "pegboard",
  means: "A pegboard with no cards on its pegs: the pegs near the pointer slide out toward you, less the further they are.",
  rules: [1, 3, 5, 6],
  range: [26, 40, 60],
  mount,
});
