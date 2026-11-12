/**
 * INZ Video Zoom: PotPlayer-style mouse zoom and pan for the scene player.
 *
 *   - Ctrl + drag right and down: zoom into the rectangle, fitted by its larger side;
 *     any other direction resets zoom and position.
 *   - Alt + drag: move the video freely, off screen too.
 *
 * Works on the DOM like inzLightbox: capture listeners on window run before
 * video.js's own, and the <video> is placed through CSS variables on the player.
 * Position is kept as a fraction of the player box, so translate() percentages
 * carry it through fullscreen and resizes unchanged.
 */

(function () {
  // s = 1 is Stash's own fit; x, y are fractions of the player box
  interface View {
    s: number;
    x: number;
    y: number;
  }

  interface Gesture {
    mode: "rect" | "pan";
    x0: number;
    y0: number;
    v0: View;
    moved: boolean;
  }

  const SLOP = 4;
  // a right-down drag thinner than this is ignored rather than zoomed absurdly far
  const MIN_RECT = 8;
  const MAX_SCALE = 64;
  const IDENTITY: View = { s: 1, x: 0, y: 0 };
  // gestures do not start on the player's own controls
  const CONTROLS = ".vjs-control-bar, .vjs-menu, .vjs-modal-dialog, .vjs-big-play-button, .vjs-button, button";

  const found = document.getElementsByClassName("video-js");
  let player: HTMLElement | null = null;
  let view: View = IDENTITY;
  let sceneKey: string | null = null;
  let gesture: Gesture | null = null;
  let overlay: HTMLElement | null = null;
  let suppressClick = false;
  // Alt released after an Alt gesture would open the browser menu
  let swallowAlt = false;
  let hover = false;

  function video(): HTMLVideoElement | null {
    return player?.querySelector<HTMLVideoElement>("video.vjs-tech") ?? null;
  }

  // videojs-vr renders into a canvas next to the tech; zooming the hidden video is pointless
  function usable(v: HTMLVideoElement | null): v is HTMLVideoElement {
    return !!v && v.videoWidth > 0 && !player?.querySelector(":scope > canvas");
  }

  // /scene/<id>/stream..., the same for every stream of one scene
  function keyOf(v: HTMLVideoElement): string {
    const src = v.currentSrc || v.src;
    const m = /\/scene\/(\d+)\//.exec(src);
    return m ? m[1] : src;
  }

  function apply(v: View): void {
    view = v;
    if (!player) return;
    const on = v.s !== 1 || v.x !== 0 || v.y !== 0;
    player.classList.toggle("inzvz-on", on);
    const st = player.style;
    if (!on) {
      st.removeProperty("--inzvz-x");
      st.removeProperty("--inzvz-y");
      st.removeProperty("--inzvz-s");
      return;
    }
    st.setProperty("--inzvz-x", `${v.x * 100}%`);
    st.setProperty("--inzvz-y", `${v.y * 100}%`);
    st.setProperty("--inzvz-s", `${v.s}`);
  }

  /** Fit rectangle r (player pixels) into the box, centred, on top of the current view. */
  function zoomToRect(r: { l: number; t: number; w: number; h: number }, W: number, H: number): void {
    const s = Math.min(MAX_SCALE, view.s * Math.min(W / r.w, H / r.h));
    // the element point under the rectangle's centre goes to the box centre
    const px = (r.l + r.w / 2 - view.x * W) / view.s;
    const py = (r.t + r.h / 2 - view.y * H) / view.s;
    apply({ s, x: (W / 2 - px * s) / W, y: (H / 2 - py * s) / H });
  }

  /* ---------------------------------------------------------------- *
   * Rectangle overlay
   * ---------------------------------------------------------------- */

  function drawRect(l: number, t: number, w: number, h: number, zoom: boolean): void {
    if (!player) return;
    if (!overlay || !overlay.isConnected) {
      overlay = document.createElement("div");
      overlay.className = "inzvz-rect";
      player.appendChild(overlay);
    }
    overlay.classList.toggle("inzvz-rect-reset", !zoom);
    const st = overlay.style;
    st.left = `${l}px`;
    st.top = `${t}px`;
    st.width = `${w}px`;
    st.height = `${h}px`;
  }

  function removeRect(): void {
    overlay?.remove();
    overlay = null;
  }

  /* ---------------------------------------------------------------- *
   * Input
   * ---------------------------------------------------------------- */

  function endGesture(): void {
    gesture = null;
    removeRect();
    player?.classList.remove("inzvz-drawing", "inzvz-grabbing");
  }

  function setHoverMods(e: MouseEvent | KeyboardEvent | null): void {
    const p = player;
    if (!p) return;
    p.classList.toggle("inzvz-ctrl", !!e && hover && e.ctrlKey && !e.altKey);
    p.classList.toggle("inzvz-alt", !!e && hover && e.altKey && !e.ctrlKey);
  }

  function onMouseDown(e: MouseEvent): void {
    const p = player;
    if (!p || e.button !== 0 || e.shiftKey || e.metaKey || e.ctrlKey === e.altKey) return;
    const t = e.target;
    if (!(t instanceof Element) || !p.contains(t) || t.closest(CONTROLS)) return;
    if (!usable(video())) return;
    // no text selection, no native drag; video.js sees nothing of the gesture
    e.preventDefault();
    e.stopPropagation();
    const mode = e.ctrlKey ? "rect" : "pan";
    if (mode === "pan") swallowAlt = true;
    gesture = { mode, x0: e.clientX, y0: e.clientY, v0: view, moved: false };
  }

  function onMouseMove(e: MouseEvent): void {
    hover = !!player && e.target instanceof Node && player.contains(e.target);
    setHoverMods(e);
    const g = gesture;
    const p = player;
    if (!g || !p) return;
    if (!(e.buttons & 1)) {
      // released outside the window
      endGesture();
      return;
    }
    e.stopPropagation();
    const dx = e.clientX - g.x0;
    const dy = e.clientY - g.y0;
    if (!g.moved && Math.hypot(dx, dy) > SLOP) {
      g.moved = true;
      p.classList.add(g.mode === "rect" ? "inzvz-drawing" : "inzvz-grabbing");
    }
    if (!g.moved) return;
    if (g.mode === "pan") {
      apply({ s: g.v0.s, x: g.v0.x + dx / p.clientWidth, y: g.v0.y + dy / p.clientHeight });
      return;
    }
    const r = p.getBoundingClientRect();
    drawRect(Math.min(g.x0, e.clientX) - r.left, Math.min(g.y0, e.clientY) - r.top, Math.abs(dx), Math.abs(dy), dx > 0 && dy > 0);
  }

  function onMouseUp(e: MouseEvent): void {
    const g = gesture;
    const p = player;
    if (!g || e.button !== 0) return;
    endGesture();
    if (!g.moved || !p) return;
    e.stopPropagation();
    // the click that follows must not reach video.js's play/pause toggle
    suppressClick = true;
    window.setTimeout(() => (suppressClick = false), 0);
    if (g.mode !== "rect") return;
    const dx = e.clientX - g.x0;
    const dy = e.clientY - g.y0;
    if (dx > 0 && dy > 0) {
      if (dx < MIN_RECT || dy < MIN_RECT) return;
      const r = p.getBoundingClientRect();
      zoomToRect({ l: g.x0 - r.left, t: g.y0 - r.top, w: dx, h: dy }, p.clientWidth, p.clientHeight);
    } else {
      apply(IDENTITY);
    }
  }

  function onClick(e: MouseEvent): void {
    if (!suppressClick) return;
    suppressClick = false;
    e.preventDefault();
    e.stopPropagation();
  }

  function onKey(e: KeyboardEvent): void {
    setHoverMods(e);
    if (e.type === "keyup" && e.key === "Alt" && swallowAlt) {
      swallowAlt = false;
      e.preventDefault();
    }
  }

  function onBlur(): void {
    endGesture();
    setHoverMods(null);
  }

  // media events do not bubble, but capture on window still sees them
  function onLoadStart(e: Event): void {
    const v = video();
    if (e.target !== v || !v) return;
    const key = keyOf(v);
    if (key !== sceneKey) {
      sceneKey = key;
      apply(IDENTITY);
    }
  }

  /* ---------------------------------------------------------------- *
   * Lifecycle
   * ---------------------------------------------------------------- */

  const LISTENERS: [string, (e: any) => void][] = [
    ["mousedown", onMouseDown],
    ["mousemove", onMouseMove],
    ["mouseup", onMouseUp],
    ["click", onClick],
    ["keydown", onKey],
    ["keyup", onKey],
    ["loadstart", onLoadStart],
  ];
  const LISTEN = { capture: true, passive: false };

  function attach(el: HTMLElement): void {
    player = el;
    view = IDENTITY;
    const v = video();
    sceneKey = v && (v.currentSrc || v.src) ? keyOf(v) : null;
    for (const [type, fn] of LISTENERS) window.addEventListener(type, fn, LISTEN);
    window.addEventListener("blur", onBlur);
  }

  function detach(): void {
    endGesture();
    for (const [type, fn] of LISTENERS) window.removeEventListener(type, fn, LISTEN);
    window.removeEventListener("blur", onBlur);
    player = null;
    hover = false;
    swallowAlt = false;
  }

  function onDomChange(): void {
    let el: HTMLElement | null = null;
    for (const c of Array.from(found)) {
      if (c instanceof HTMLElement && c.closest(".VideoPlayer")) {
        el = c;
        break;
      }
    }
    if (el === player) return;
    if (player) detach();
    if (el) attach(el);
  }

  new MutationObserver(onDomChange).observe(document.body, { childList: true, subtree: true });
  onDomChange();
})();
