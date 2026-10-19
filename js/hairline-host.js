/* ====================================================================
   HAIRLINE HOST · the page's half of an empty-state figure
   · loads after hairline-kernel.js (window.HL) and before the figure
   · the figure file ends in hairline({...}), which registers it and
     mounts it into any placeholder already on the page
   · hairline.scan(root) mounts every [data-hairline-figure="name"]
     placeholder under root that is not mounted yet
   · each scan first destroys figures whose placeholder has left the
     page, so a view that re-renders its empty state never leaks a loop
   · the read-out shows what the pointer is over and hides at "rest"
   Public: window.hairline(figure), window.hairline.scan(root)
   This file is the same in every app that uses a figure; the kernel is
   @lucasmarkes/hairline's, copied unchanged.
   ==================================================================== */
(() => {
  "use strict";

  const figures = {};
  let live = [];

  // A figure loaded after the first render (an inline module runs after
  // classic scripts) mounts into any placeholder already waiting for it.
  const hairline = (figure) => { figures[figure.name] = figure; hairline.scan(); };

  hairline.scan = (root) => {
    live = live.filter((m) => m.stage.isConnected || (m.destroy(), false));
    // Without the kernel or the figure the placeholder stays empty and the
    // empty state's own words still say what is missing.
    if (!window.HL) return;
    for (const stage of (root || document).querySelectorAll("[data-hairline-figure]:not([data-hairline])")) {
      const figure = figures[stage.dataset.hairlineFigure];
      if (!figure) continue;
      HL.inject(document);
      stage.setAttribute("data-hairline", figure.name);
      // Decorative here: the empty state's own words say what is missing,
      // and a label would be read out again inside an aria-live status.
      stage.setAttribute("aria-hidden", "true");
      const svg = HL.mk("svg", { viewBox: "0 0 400 320", "aria-hidden": "true" }, stage);
      const tag = document.createElement("span");
      tag.className = "hl-read";
      stage.append(tag);
      let text = "rest";
      const read = {
        get textContent() { return text; },
        set textContent(v) { text = v == null ? "" : String(v); tag.textContent = text === "rest" ? "" : text; },
      };
      const handle = figure.mount({ stage, svg, read }, figure.range[1]);
      live.push({ stage, destroy: handle.destroy });
    }
  };

  window.hairline = hairline;
})();
