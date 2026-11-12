/**
 * INZ Video Zoom: PotPlayer-style mouse zoom and pan for the scene player, plus
 * MX Player-style fit mode and orientation buttons.
 *
 *   - Ctrl + drag right and down: zoom into the rectangle, fitted by its larger side;
 *     any other direction resets to the fit mode.
 *   - Alt + drag: move the video freely, off screen too.
 *   - Fit mode button: fit to screen -> crop -> 100% (one video pixel per screen pixel).
 *   - Orientation button (fullscreen, where the browser can lock it): landscape ->
 *     portrait -> auto-rotate.
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

  type FitMode = "fit" | "crop" | "native";
  type Orient = "landscape" | "portrait" | "auto";

  const SLOP = 4;
  // a right-down drag thinner than this is ignored rather than zoomed absurdly far
  const MIN_RECT = 8;
  // zoom stops at 8x8 screen pixels per video pixel: an 8K video at 64x of the fit
  // took the GPU driver down; low-res video still gets 4x of the fit
  const MAX_NATIVE = 8;
  const MIN_MAX_SCALE = 4;
  const MAX_SCALE = 64;
  const TOAST_MS = 900;
  const IDENTITY: View = { s: 1, x: 0, y: 0 };
  // gestures do not start on the player's own controls
  const CONTROLS = ".vjs-control-bar, .vjs-menu, .vjs-modal-dialog, .vjs-big-play-button, .vjs-button, button";
  const STORE_KEY = "inzVideoZoom";

  const FIT_MODES: FitMode[] = ["fit", "crop", "native"];
  const FIT_LABEL: Record<FitMode, [string, string]> = {
    fit: ["FIT", "Fit to screen"],
    crop: ["CROP", "Crop"],
    native: ["1:1", "100%"],
  };
  const ORIENT_NEXT: Record<Orient, Orient> = { landscape: "portrait", portrait: "auto", auto: "landscape" };
  const ORIENT_LABEL: Record<Orient, string> = { landscape: "Landscape", portrait: "Portrait", auto: "Auto-rotate" };
  const ROTATE_ICON =
    `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M16.48 2.52c3.27 1.55 5.61 4.72 5.97 8.48h1.5C23.44 4.84 18.29 0 12 0l-.66.03 3.81 3.81 1.33-1.32zm-6.25-.77a1.49 1.49 0 0 0-2.12 0L1.75 8.11a1.49 1.49 0 0 0 0 2.12l12.02 12.02c.59.59 1.54.59 2.12 0l6.36-6.36c.59-.59.59-1.54 0-2.12L10.23 1.75zm4.6 19.44L2.81 9.17l6.36-6.36 12.02 12.02-6.36 6.36zm-7.31.29C4.25 19.94 1.91 16.76 1.55 13H.05C.56 19.16 5.71 24 12 24l.66-.03-3.81-3.81-1.33 1.32z"/></svg>`;

  const found = document.getElementsByClassName("video-js");
  let player: HTMLElement | null = null;
  let view: View = IDENTITY;
  // a gesture moved the view off the fit mode's placement
  let custom = false;
  let sceneKey: string | null = null;
  let gesture: Gesture | null = null;
  let overlay: HTMLElement | null = null;
  let suppressClick = false;
  // Alt released after an Alt gesture would open the browser menu
  let swallowAlt = false;
  let hover = false;
  let toast: HTMLElement | null = null;
  let toastTimer: number | undefined;
  let resize: ResizeObserver | null = null;

  const saved = load();
  let fitMode: FitMode = FIT_MODES.includes(saved.fitMode as FitMode) ? (saved.fitMode as FitMode) : "fit";
  // null: Stash's own orientation handling, untouched
  let orient: Orient | null =
    typeof saved.orient === "string" && saved.orient in ORIENT_NEXT ? (saved.orient as Orient) : null;

  /* ---------------------------------------------------------------- *
   * Storage
   * ---------------------------------------------------------------- */

  function load(): { fitMode?: unknown; orient?: unknown } {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY) || "{}") ?? {};
    } catch {
      return {};
    }
  }

  function store(): void {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ fitMode, orient }));
    } catch {
      // private mode or blocked storage: the choice lasts for this page only
    }
  }

  /* ---------------------------------------------------------------- *
   * Lookups
   * ---------------------------------------------------------------- */

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

  function isFullscreen(): boolean {
    const el = document.fullscreenElement;
    return !!el && !!player && (el === player || el.contains(player));
  }

  /* ---------------------------------------------------------------- *
   * View
   * ---------------------------------------------------------------- */

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

  /** Scale showing one video pixel per device pixel; null until the video's size is known. */
  function nativeScale(): number | null {
    const v = video();
    const p = player;
    if (!p || !usable(v) || !p.clientWidth || !p.clientHeight) return null;
    return 1 / (Math.min(p.clientWidth / v.videoWidth, p.clientHeight / v.videoHeight) * devicePixelRatio);
  }

  function maxScale(): number {
    const n = nativeScale();
    return n === null ? MIN_MAX_SCALE : Math.min(MAX_SCALE, Math.max(MIN_MAX_SCALE, n * MAX_NATIVE));
  }

  /** The fit mode's placement, centred; Stash's fit until the video's size is known. */
  function modeView(): View {
    const v = video();
    const p = player;
    const n = nativeScale();
    if (fitMode === "fit" || !p || !v || n === null) return IDENTITY;
    const rw = p.clientWidth / v.videoWidth;
    const rh = p.clientHeight / v.videoHeight;
    // crop fills the box; native shows one video pixel per device pixel
    const s = fitMode === "crop" ? Math.max(rw, rh) / Math.min(rw, rh) : n;
    return { s, x: (1 - s) / 2, y: (1 - s) / 2 };
  }

  function resetView(): void {
    custom = false;
    apply(modeView());
  }

  /** Fit rectangle r (player pixels) into the box, centred, on top of the current view. */
  function zoomToRect(r: { l: number; t: number; w: number; h: number }, W: number, H: number): void {
    const want = view.s * Math.min(W / r.w, H / r.h);
    const max = Math.max(maxScale(), view.s);
    const s = Math.min(max, want);
    if (want > max) showToast(`Max zoom ${Math.round(s * 100)}%`);
    // the element point under the rectangle's centre goes to the box centre
    const px = (r.l + r.w / 2 - view.x * W) / view.s;
    const py = (r.t + r.h / 2 - view.y * H) / view.s;
    custom = true;
    apply({ s, x: (W / 2 - px * s) / W, y: (H / 2 - py * s) / H });
  }

  function onResize(): void {
    if (!custom) apply(modeView());
  }

  /* ---------------------------------------------------------------- *
   * Overlays
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

  function showToast(text: string): void {
    if (!player) return;
    if (!toast || !toast.isConnected) {
      toast = document.createElement("div");
      toast.className = "inzvz-toast";
      player.appendChild(toast);
    }
    toast.textContent = text;
    toast.classList.add("inzvz-show");
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast?.classList.remove("inzvz-show"), TOAST_MS);
  }

  /* ---------------------------------------------------------------- *
   * Control bar buttons
   * ---------------------------------------------------------------- */

  function orientSupported(): boolean {
    const so = screen.orientation as any;
    // desktop browsers have lock() but always refuse it
    return typeof so?.lock === "function" && matchMedia("(pointer: coarse)").matches;
  }

  function makeButton(cls: string, onPress: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `vjs-control vjs-button ${cls}`;
    b.innerHTML = `<span class="inzvz-icon" aria-hidden="true"></span><span class="vjs-control-text" aria-live="polite"></span>`;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      onPress();
    });
    return b;
  }

  function ensureButtons(): void {
    const bar = player?.querySelector(".vjs-control-bar");
    if (!bar || bar.querySelector(".inzvz-fit-button")) return;
    const before = bar.querySelector(".vjs-fullscreen-control");
    const fit = makeButton("inzvz-fit-button", cycleFit);
    bar.insertBefore(fit, before);
    if (orientSupported()) {
      const rot = makeButton("inzvz-orient-button", cycleOrient);
      rot.querySelector(".inzvz-icon")!.innerHTML = ROTATE_ICON;
      bar.insertBefore(rot, before);
    }
    labelButtons();
  }

  function labelButtons(): void {
    const fit = player?.querySelector(".inzvz-fit-button");
    if (fit) {
      const [short, long] = FIT_LABEL[fitMode];
      fit.querySelector(".inzvz-icon")!.textContent = short;
      fit.querySelector(".vjs-control-text")!.textContent = `Fit mode: ${long}`;
      fit.setAttribute("title", `Fit mode: ${long}`);
    }
    const rot = player?.querySelector(".inzvz-orient-button");
    if (rot) {
      const text = `Orientation: ${orient ? ORIENT_LABEL[orient] : "default"}`;
      rot.querySelector(".vjs-control-text")!.textContent = text;
      rot.setAttribute("title", text);
      rot.classList.toggle("inzvz-orient-set", !!orient);
    }
  }

  function cycleFit(): void {
    fitMode = FIT_MODES[(FIT_MODES.indexOf(fitMode) + 1) % FIT_MODES.length];
    store();
    labelButtons();
    resetView();
    const v = video();
    // 100% names the zoom it needs over Stash's fit: 200% for 4K on a 1080p screen
    const extra = fitMode === "native" && usable(v) ? ` (${Math.round(view.s * 100)}% zoom)` : "";
    showToast(FIT_LABEL[fitMode][1] + extra);
  }

  /* ---------------------------------------------------------------- *
   * Orientation
   * ---------------------------------------------------------------- */

  function cycleOrient(): void {
    const now = (screen.orientation?.type ?? "").startsWith("portrait") ? "portrait" : "landscape";
    orient = orient ? ORIENT_NEXT[orient] : now === "landscape" ? "portrait" : "landscape";
    store();
    labelButtons();
    showToast(ORIENT_LABEL[orient]);
    applyOrient(true);
  }

  function applyOrient(announceFailure = false): void {
    const so = screen.orientation as any;
    const want = orient;
    if (!want || !so || !isFullscreen()) return;
    if (want === "auto") {
      try {
        so.unlock();
      } catch {
        // nothing locked
      }
      return;
    }
    Promise.resolve()
      .then(() => so.lock(want))
      .catch(() => announceFailure && showToast("This browser cannot lock the orientation"));
  }

  // videojs-mobile-ui leaves fullscreen when the device turns to portrait and locks
  // landscape when it turns back; with an orientation picked here, its handler is held
  // off while in fullscreen. It assigns screen.orientation.onchange on every scene load,
  // so the property is replaced by one that keeps the handler and calls it when allowed.
  function guardOrientation(): void {
    const so = screen.orientation as any;
    if (!so || !orientSupported()) return;
    let handler: ((e: Event) => void) | null = typeof so.onchange === "function" ? so.onchange : null;
    try {
      so.onchange = null;
      Object.defineProperty(so, "onchange", {
        configurable: true,
        get: () => handler,
        set: (h: unknown) => {
          handler = typeof h === "function" ? (h as (e: Event) => void) : null;
        },
      });
    } catch {
      return;
    }
    so.addEventListener("change", (e: Event) => {
      if (orient && isFullscreen()) return;
      handler?.call(so, e);
    });
  }

  // after video.js's and mobile-ui's own fullscreenchange handlers, so this lock wins
  function onFullscreenChange(): void {
    if (isFullscreen()) window.setTimeout(() => applyOrient(), 0);
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
      custom = true;
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
      resetView();
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
      resetView();
    }
    // mobile-ui unlocks on "ended"; the next scene in fullscreen gets the lock back
    applyOrient();
  }

  // the fit mode needs the video's size, unknown at loadstart
  function onMetadata(e: Event): void {
    if (e.target === video() && !custom) apply(modeView());
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
    ["loadedmetadata", onMetadata],
  ];
  const LISTEN = { capture: true, passive: false };

  function attach(el: HTMLElement): void {
    player = el;
    view = IDENTITY;
    custom = false;
    const v = video();
    sceneKey = v && (v.currentSrc || v.src) ? keyOf(v) : null;
    for (const [type, fn] of LISTENERS) window.addEventListener(type, fn, LISTEN);
    window.addEventListener("blur", onBlur);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    resize = new ResizeObserver(onResize);
    resize.observe(el);
    ensureButtons();
    apply(modeView());
  }

  function detach(): void {
    endGesture();
    for (const [type, fn] of LISTENERS) window.removeEventListener(type, fn, LISTEN);
    window.removeEventListener("blur", onBlur);
    document.removeEventListener("fullscreenchange", onFullscreenChange);
    resize?.disconnect();
    resize = null;
    clearTimeout(toastTimer);
    toast = null;
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
    if (el === player) {
      // video.js builds the control bar after the element is in the page
      if (player) ensureButtons();
      return;
    }
    if (player) detach();
    if (el) attach(el);
  }

  guardOrientation();
  new MutationObserver(onDomChange).observe(document.body, { childList: true, subtree: true });
  onDomChange();
})();
