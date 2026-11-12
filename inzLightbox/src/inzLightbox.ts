/**
 * INZ Lightbox: zoom, pan, hotkeys and touch gestures for Stash's image lightbox.
 *
 * Stash's Lightbox and LightboxImage are not patchable, so this works on the DOM:
 *   - capture listeners on window run before React's root listeners and take wheel,
 *     mouse, pointer and touch input on the lightbox images away from Stash;
 *   - the current image's wrapper is positioned through CSS variables, which the
 *     stylesheet applies with !important over React's inline transform;
 *   - navigation goes back to Stash as synthetic ArrowLeft/ArrowRight keydowns, so
 *     paging, slideshow and chapters stay Stash's own.
 * Stash's lightbox options are read from its always-rendered hidden inline form.
 */

(function () {
  const L = InzLightbox;
  type View = InzLightbox.View;
  type Size = InzLightbox.Size;
  type Media = HTMLImageElement | HTMLVideoElement;

  const ZOOM_KEY_STEP = 1.15;
  const ZOOM_WHEEL_STEP = 1.1;
  // Stash's SCROLL_INFINITE_THRESHOLD: smaller deltas come from a trackpad or a
  // free-spinning wheel and are applied directly
  const WHEEL_SMOOTH_PX = 10;
  const WHEEL_GROUP_MS = 250;
  const WHEEL_ZOOM_FACTOR = 700;
  // ctrl+wheel is a trackpad pinch in Chromium
  const PINCH_WHEEL_FACTOR = 100;
  const WHEEL_PAN_STEP = 100;
  // exponential approach in log scale: ~95% of the way in ~140 ms
  const ZOOM_TAU = 45;
  const KEY_REPEAT_MS = 80;
  const CLICK_SLOP = 4;
  const CLICK_MS = 250;
  const TAP_SLOP = 10;
  const TAP_MS = 300;
  const TAP_BACK_SHARE = 0.3;
  const INDICATOR_MS = 800;
  const OPTION_SETTLE_MS = 50;

  interface Owned {
    box: HTMLElement;
    wrapper: HTMLElement;
    media: Media;
    key: string;
    nat: Size;
    size: Size;
    v: View;
    touched: boolean;
    fill?: { step: 1 | 2; prev: View };
    resize: ResizeObserver;
  }

  interface Point {
    x: number;
    y: number;
  }

  const found = document.getElementsByClassName("Lightbox");
  let lb: HTMLElement | null = null;
  let carousel: HTMLElement | null = null;
  let owned: Owned | null = null;
  const awaited = new WeakSet<Media>();
  // zoom relative to the default, carried to unvisited images when Stash keeps zoom on nav
  let carry = 1;
  let fullscreenTried = false;
  let fullscreenPending = false;

  let anim: { target: number; ax: number; ay: number; last: number; frame: number } | null = null;
  let wheelLast = -Infinity;
  let wheelGroupSmooth = false;
  let lastKeyZoom = 0;

  let drag: { owner: Owned | null; start: View | null; x0: number; y0: number; t0: number; moved: boolean } | null =
    null;
  let suppressClick = false;

  let touching = false;
  let touchBase: { owner: Owned; v0: View; p0: Point; d0: number } | null = null;
  let tap: { x: number; y: number; t: number; ok: boolean } | null = null;

  let indicator: HTMLElement | null = null;
  let indicatorText: Text | null = null;
  let indicatorTimer: number | undefined;
  let optionSeq = 0;

  /* ---------------------------------------------------------------- *
   * DOM lookups
   * ---------------------------------------------------------------- */

  function stashOptions() {
    const form = lb?.querySelector(".Lightbox-header-options-inline");
    // the selects carry no reliable id, their option values identify them
    const select = (value: string) =>
      form?.querySelector<HTMLOptionElement>(`option[value="${value}"]`)?.parentElement as
        | HTMLSelectElement
        | undefined;
    const check = (id: string) => form?.querySelector<HTMLInputElement>(`input#${id}`)?.checked ?? false;
    return {
      displayMode: (select("FIT_X")?.value || "FIT_XY") as InzLightbox.DisplayMode,
      scaleUp: check("scaleUp"),
      resetZoomOnNav: check("resetZoomOnNav"),
      panY: select("PAN_Y")?.value === "PAN_Y",
    };
  }

  function currentIndex(c: HTMLElement): number {
    // Stash sets left: -index * 100vw
    const left = parseFloat(c.style.left);
    return Number.isFinite(left) ? Math.max(0, Math.round(-left / 100)) : 0;
  }

  function mediaIn(slot: Element | undefined): Media | null {
    return (
      slot?.querySelector<Media>(
        ".Lightbox-carousel-image-wrapper > img, .Lightbox-carousel-image-wrapper > video"
      ) ?? null
    );
  }

  function naturalSize(m: Media): Size | null {
    if (m instanceof HTMLVideoElement) {
      return m.videoWidth > 0 ? { w: m.videoWidth, h: m.videoHeight } : null;
    }
    return m.complete && m.naturalWidth > 0 ? { w: m.naturalWidth, h: m.naturalHeight } : null;
  }

  function boxSize(el: HTMLElement): Size | null {
    const w = el.clientWidth;
    const h = el.clientHeight;
    return w > 0 && h > 0 ? { w, h } : null;
  }

  function imageKey(m: Media): string {
    const src = m.currentSrc || m.src;
    try {
      return new URL(src, location.href).pathname;
    } catch {
      return src;
    }
  }

  function local(o: Owned, cx: number, cy: number): Point {
    const r = o.box.getBoundingClientRect();
    return { x: cx - r.left, y: cy - r.top };
  }

  function isMediaTarget(t: EventTarget | null): boolean {
    return (
      t instanceof Element && (t.tagName === "IMG" || t.tagName === "VIDEO") && !!t.closest(".Lightbox-carousel")
    );
  }

  function within(t: EventTarget | null, selector: string): boolean {
    return t instanceof Element && !!lb?.contains(t) && !!t.closest(selector);
  }

  function isEditable(t: EventTarget | null): boolean {
    if (!(t instanceof HTMLElement)) return false;
    if (t.isContentEditable || t.tagName === "TEXTAREA" || t.tagName === "SELECT") return true;
    return t instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit", "reset"].includes(t.type);
  }

  /* ---------------------------------------------------------------- *
   * Ownership of the current image
   * ---------------------------------------------------------------- */

  function sync(): void {
    if (!lb) return;
    const c = lb.querySelector<HTMLElement>(".Lightbox-carousel");
    if (c !== carousel) {
      carouselObserver.disconnect();
      carousel = c;
      if (c) carouselObserver.observe(c, { attributes: true, attributeFilter: ["style"] });
    }
    injectOptions();

    const media = carousel ? mediaIn(carousel.children[currentIndex(carousel)]) : null;
    if (owned && owned.media === media && media.isConnected) return;
    release();
    if (media) take(media);
  }

  function take(media: Media): void {
    const nat = naturalSize(media);
    const wrapper = media.parentElement;
    const box = wrapper?.parentElement;
    if (!nat || !wrapper || !box) {
      if (!awaited.has(media)) {
        awaited.add(media);
        media.addEventListener(media instanceof HTMLVideoElement ? "loadedmetadata" : "load", () => sync(), {
          once: true,
        });
      }
      return;
    }
    const size = boxSize(box);
    if (!size) return;

    const key = imageKey(media);
    const saved = L.settings.remember ? L.recallView(key) : null;
    const resize = new ResizeObserver(onResize);
    const o: Owned = {
      box,
      wrapper,
      media,
      key,
      nat,
      size,
      v: saved ? L.clampView(L.fromNorm(saved, nat, size), nat, size) : startView(nat, size),
      touched: !!saved,
      resize,
    };
    owned = o;
    box.classList.add("inzlb-owned");
    apply(o, o.v);
    resize.observe(box);
  }

  // The released box keeps its class and variables, so the image slides out
  // as it was rather than snapping back to Stash's placement.
  function release(): void {
    stopAnim();
    const o = owned;
    if (!o) return;
    owned = null;
    o.resize.disconnect();
    const opts = stashOptions();
    carry = o.v.s / L.defaultScale(o.nat, o.size, opts.displayMode, opts.scaleUp);
    L.flushViews();
  }

  function startView(nat: Size, size: Size): View {
    const opts = stashOptions();
    let s = L.defaultScale(nat, size, opts.displayMode, opts.scaleUp);
    if (!opts.resetZoomOnNav) s = L.clampScale(s * carry, nat, size);
    return L.clampView(L.centered(s, nat, size), nat, size);
  }

  function apply(o: Owned, v: View): void {
    o.v = v;
    const st = o.wrapper.style;
    st.setProperty("--inzlb-x", `${v.x}px`);
    st.setProperty("--inzlb-y", `${v.y}px`);
    st.setProperty("--inzlb-s", `${v.s}`);
    o.box.classList.toggle("inzlb-pan", o.nat.w * v.s > o.size.w + 0.5 || o.nat.h * v.s > o.size.h + 0.5);
  }

  /** A user change: clamped, remembered, indicated. */
  function update(v: View, keepFill = false): void {
    const o = owned;
    if (!o) return;
    const prevS = o.v.s;
    apply(o, L.clampView(v, o.nat, o.size));
    o.touched = true;
    if (!keepFill) o.fill = undefined;
    if (L.settings.remember) L.rememberView(o.key, L.toNorm(o.v, o.nat, o.size));
    if (o.v.s !== prevS) showIndicator(o.v.s);
  }

  function zoomTo(s: number, ax: number, ay: number): void {
    const o = owned;
    if (!o) return;
    update(L.zoomAt(o.v, L.clampScale(s, o.nat, o.size), ax, ay));
  }

  function onResize(): void {
    const o = owned;
    if (!o) return;
    const size = boxSize(o.box);
    if (!size || (size.w === o.size.w && size.h === o.size.h)) return;
    const norm = L.toNorm(o.v, o.nat, o.size);
    o.size = size;
    apply(o, o.touched ? L.clampView(L.fromNorm(norm, o.nat, size), o.nat, size) : startView(o.nat, size));
  }

  /* ---------------------------------------------------------------- *
   * Smooth zoom
   * ---------------------------------------------------------------- */

  function animateZoom(factor: number, ax: number, ay: number): void {
    const o = owned;
    if (!o) return;
    if (!L.settings.smooth) {
      zoomTo(o.v.s * factor, ax, ay);
      return;
    }
    const target = L.clampScale((anim ? anim.target : o.v.s) * factor, o.nat, o.size);
    if (anim) {
      Object.assign(anim, { target, ax, ay });
      return;
    }
    anim = { target, ax, ay, last: performance.now(), frame: requestAnimationFrame(step) };
  }

  function step(now: number): void {
    const o = owned;
    const a = anim;
    if (!o || !a) {
      anim = null;
      return;
    }
    const dt = Math.max(0, now - a.last);
    a.last = now;
    const cur = Math.log(o.v.s);
    const goal = Math.log(a.target);
    const done = Math.abs(goal - cur) < 0.002;
    const next = done ? a.target : Math.exp(cur + (goal - cur) * (1 - Math.exp(-dt / ZOOM_TAU)));
    update(L.zoomAt(o.v, next, a.ax, a.ay));
    if (done) anim = null;
    else a.frame = requestAnimationFrame(step);
  }

  function stopAnim(): void {
    if (anim) cancelAnimationFrame(anim.frame);
    anim = null;
  }

  /* ---------------------------------------------------------------- *
   * Zoom indicator
   * ---------------------------------------------------------------- */

  function showIndicator(s: number): void {
    if (!L.settings.indicator || !lb) return;
    if (!indicator || !indicator.isConnected) {
      indicator = document.createElement("div");
      indicator.className = "inzlb-zoom";
      // updated through nodeValue: characterData is not observed, childList is
      indicatorText = document.createTextNode("");
      indicator.appendChild(indicatorText);
      lb.appendChild(indicator);
    }
    indicatorText!.nodeValue = `${Math.round(s * 100)}%`;
    indicator.classList.add("inzlb-show");
    clearTimeout(indicatorTimer);
    indicatorTimer = window.setTimeout(() => indicator?.classList.remove("inzlb-show"), INDICATOR_MS);
  }

  /* ---------------------------------------------------------------- *
   * Navigation and fullscreen
   * ---------------------------------------------------------------- */

  function nav(dir: -1 | 1): void {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: dir < 0 ? "ArrowLeft" : "ArrowRight", bubbles: true })
    );
  }

  function requestFullscreen(): void {
    const target = lb;
    if (!target || !document.fullscreenEnabled || document.fullscreenElement) return;
    fullscreenPending = false;
    // rejected without user activation: retried on the next input inside the lightbox
    const retry = () => {
      if (lb === target) fullscreenPending = true;
    };
    try {
      target.requestFullscreen().catch(retry);
    } catch {
      retry();
    }
  }

  function openFullscreenOnce(): void {
    if (fullscreenTried || !L.settingsLoaded || !lb) return;
    fullscreenTried = true;
    if (L.settings.autoFullscreen) requestFullscreen();
  }

  function retryFullscreen(t: EventTarget | null): void {
    if (fullscreenPending && within(t, ".Lightbox-display")) requestFullscreen();
  }

  /* ---------------------------------------------------------------- *
   * "Auto fullscreen" in Stash's lightbox options
   * ---------------------------------------------------------------- */

  function injectOptions(): void {
    if (!lb) return;
    for (const anchor of Array.from(lb.querySelectorAll<HTMLInputElement>("input#resetZoomOnNav"))) {
      // Form.Group > Form.Group.row > Col > Form.Check > input
      const group = anchor.closest(".row")?.parentElement;
      if (!group?.parentElement || group.parentElement.querySelector(":scope > .inzlb-option")) continue;
      group.after(buildOption());
    }
  }

  function buildOption(): HTMLElement {
    const id = `inzlb-autofs-${++optionSeq}`;
    const wrap = document.createElement("div");
    wrap.className = "form-group inzlb-option";
    wrap.innerHTML =
      `<div class="mb-1 row form-group"><div class="col"><div class="form-check">` +
      `<input type="checkbox" class="form-check-input" id="${id}">` +
      `<label class="form-check-label" for="${id}">Auto fullscreen</label>` +
      `</div></div></div>`;
    const input = wrap.querySelector("input")!;
    input.checked = L.settings.autoFullscreen;
    input.addEventListener("change", () => {
      L.settings.autoFullscreen = input.checked;
      syncOptionChecks();
      L.saveSetting("autoFullscreen", input.checked).catch((e) => console.error("inzLightbox: save", e));
    });
    return wrap;
  }

  function syncOptionChecks(): void {
    lb?.querySelectorAll<HTMLInputElement>(".inzlb-option input").forEach((i) => {
      i.checked = L.settings.autoFullscreen;
    });
  }

  /* ---------------------------------------------------------------- *
   * Input
   * ---------------------------------------------------------------- */

  function onWheel(e: WheelEvent): void {
    if (!within(e.target, ".Lightbox-display")) return;
    // also stops Stash's edge-of-image navigation in PanY and shift+wheel
    e.preventDefault();
    e.stopPropagation();
    const o = owned;
    if (!o) return;

    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? o.size.h : 1;
    let dy = e.deltaY * unit;
    let dx = e.deltaX * unit;
    // shift+wheel arrives as horizontal scroll in most browsers
    if (e.shiftKey && !dy) {
      dy = dx;
      dx = 0;
    }
    const p = local(o, e.clientX, e.clientY);

    if (e.ctrlKey) {
      stopAnim();
      zoomTo(o.v.s * Math.exp(-dy / PINCH_WHEEL_FACTOR), p.x, p.y);
      return;
    }

    const small = e.deltaMode === 0 && Math.abs(dy || dx) < WHEEL_SMOOTH_PX;
    if (e.timeStamp - wheelLast > WHEEL_GROUP_MS) wheelGroupSmooth = small;
    wheelLast = e.timeStamp;
    const smooth = wheelGroupSmooth || small;

    const zoom = stashOptions().panY === e.shiftKey;
    if (zoom) {
      if (!dy) return;
      if (smooth) {
        stopAnim();
        zoomTo(o.v.s * Math.exp(-dy / WHEEL_ZOOM_FACTOR), p.x, p.y);
      } else {
        animateZoom(dy < 0 ? ZOOM_WHEEL_STEP : 1 / ZOOM_WHEEL_STEP, p.x, p.y);
      }
      return;
    }
    stopAnim();
    const sy = smooth ? -dy : -Math.sign(dy) * WHEEL_PAN_STEP;
    const sx = smooth ? -dx : -Math.sign(dx) * WHEEL_PAN_STEP;
    update({ s: o.v.s, x: o.v.x + sx, y: o.v.y + sy });
  }

  function onMouseDown(e: MouseEvent): void {
    retryFullscreen(e.target);
    if (!isMediaTarget(e.target)) return;
    e.stopPropagation();
    if (e.button !== 0) return;
    // no text selection, no native image drag
    e.preventDefault();
    stopAnim();
    drag = { owner: owned, start: owned?.v ?? null, x0: e.clientX, y0: e.clientY, t0: e.timeStamp, moved: false };
  }

  function endDrag(): void {
    drag = null;
    lb?.classList.remove("inzlb-grabbing");
  }

  function onMouseMove(e: MouseEvent): void {
    const d = drag;
    if (!d) return;
    if (!(e.buttons & 1)) {
      // released outside the window
      endDrag();
      return;
    }
    e.stopPropagation();
    const dx = e.clientX - d.x0;
    const dy = e.clientY - d.y0;
    // total displacement, not the last step: Stash's per-step check let a fast drag count as a click
    if (!d.moved && Math.hypot(dx, dy) > CLICK_SLOP) {
      d.moved = true;
      lb?.classList.add("inzlb-grabbing");
    }
    if (d.moved && d.start && owned && owned === d.owner) {
      update({ s: d.start.s, x: d.start.x + dx, y: d.start.y + dy });
    }
  }

  function onMouseUp(e: MouseEvent): void {
    const d = drag;
    if (!d || e.button !== 0) return;
    endDrag();
    e.stopPropagation();
    if (d.moved) {
      // a drag ending over the background must not reach Stash's click-to-close
      suppressClick = true;
      window.setTimeout(() => (suppressClick = false), 0);
      return;
    }
    if (e.timeStamp - d.t0 > CLICK_MS) return;
    const display = lb?.querySelector(".Lightbox-display")?.getBoundingClientRect();
    const mid = display ? display.left + display.width / 2 : window.innerWidth / 2;
    nav(e.clientX < mid ? -1 : 1);
  }

  function onClick(e: MouseEvent): void {
    if (!suppressClick) return;
    suppressClick = false;
    e.preventDefault();
    e.stopPropagation();
  }

  // Stash's own pinch runs on pointer events of the image
  function onPointer(e: PointerEvent): void {
    if (e.type === "pointerdown") retryFullscreen(e.target);
    if (isMediaTarget(e.target)) e.stopPropagation();
  }

  function distance(a: Point, b: Point): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  // A new base on every change in the number of fingers: the remaining finger
  // carries on from where it is instead of jumping to it.
  function rebase(list: TouchList): void {
    const o = owned;
    if (!o || list.length === 0) {
      touchBase = null;
      return;
    }
    const a = local(o, list[0].clientX, list[0].clientY);
    if (list.length === 1) {
      touchBase = { owner: o, v0: o.v, p0: a, d0: 0 };
      return;
    }
    const b = local(o, list[1].clientX, list[1].clientY);
    touchBase = { owner: o, v0: o.v, p0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, d0: Math.max(1, distance(a, b)) };
  }

  function onTouchStart(e: TouchEvent): void {
    if (!within(e.target, ".Lightbox-carousel")) return;
    // no compatibility mouse events, double-tap zoom or selection callout
    e.preventDefault();
    e.stopPropagation();
    stopAnim();
    if (!touching) {
      touching = true;
      const t = e.touches[0];
      tap = e.touches.length === 1 ? { x: t.clientX, y: t.clientY, t: e.timeStamp, ok: true } : null;
    } else if (tap) {
      tap.ok = false;
    }
    rebase(e.touches);
  }

  function onTouchMove(e: TouchEvent): void {
    if (!touching) return;
    e.preventDefault();
    e.stopPropagation();
    const list = e.touches;
    if (!list.length) return;
    if (tap?.ok && (list.length > 1 || Math.hypot(list[0].clientX - tap.x, list[0].clientY - tap.y) > TAP_SLOP)) {
      tap.ok = false;
    }
    const o = owned;
    const base = touchBase;
    if (!o || !base || base.owner !== o) return;

    const a = local(o, list[0].clientX, list[0].clientY);
    if (base.d0 === 0) {
      update({ s: base.v0.s, x: base.v0.x + a.x - base.p0.x, y: base.v0.y + a.y - base.p0.y });
      return;
    }
    if (list.length < 2) return;
    const b = local(o, list[1].clientX, list[1].clientY);
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const s = L.clampScale((base.v0.s * distance(a, b)) / base.d0, o.nat, o.size);
    const k = s / base.v0.s;
    // the image point under the starting midpoint follows the current midpoint
    update({ s, x: m.x - (base.p0.x - base.v0.x) * k, y: m.y - (base.p0.y - base.v0.y) * k });
  }

  function onTouchEnd(e: TouchEvent): void {
    if (!touching) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.touches.length > 0) {
      if (tap) tap.ok = false;
      rebase(e.touches);
      return;
    }
    touching = false;
    touchBase = null;
    const t = tap;
    tap = null;
    retryFullscreen(e.target);
    if (e.type === "touchend" && t?.ok && e.timeStamp - t.t < TAP_MS) {
      nav(t.x < window.innerWidth * TAP_BACK_SHARE ? -1 : 1);
    }
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (!lb) return;
    if (fullscreenPending && e.isTrusted && e.key !== "Escape") requestFullscreen();
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (isEditable(e.target) || document.body.classList.contains("modal-open")) return;
    const action = L.settings.keys.get(e.code);
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    // a focused button would take Space as a click
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused !== document.body && lb.contains(focused)) focused.blur();
    if (owned) run(action, owned, e);
  }

  function onKeyUp(e: KeyboardEvent): void {
    if (!lb || e.ctrlKey || e.altKey || e.metaKey || isEditable(e.target)) return;
    if (L.settings.keys.has(e.code)) e.preventDefault();
  }

  function run(action: InzLightbox.Action, o: Owned, e: KeyboardEvent): void {
    const cx = o.size.w / 2;
    const cy = o.size.h / 2;
    if (action === "zoomIn" || action === "zoomOut") {
      // auto-repeat at the OS rate would zoom far too fast
      if (e.repeat && e.timeStamp - lastKeyZoom < KEY_REPEAT_MS) return;
      lastKeyZoom = e.timeStamp;
      animateZoom(action === "zoomIn" ? ZOOM_KEY_STEP : 1 / ZOOM_KEY_STEP, cx, cy);
      return;
    }
    if (e.repeat) return;
    stopAnim();
    switch (action) {
      case "original":
        update(L.centered(1, o.nat, o.size));
        break;
      case "fitScreen":
        update(L.centered(L.fitScreenScale(o.nat, o.size), o.nat, o.size));
        break;
      case "fitWidth":
        update(L.centered(L.fitWidthScale(o.nat, o.size), o.nat, o.size));
        break;
      case "fill": {
        // fill the screen -> 100% -> back to where the cycle started
        const f = o.fill;
        if (!f) {
          const prev = o.v;
          update(L.centered(L.coverScale(o.nat, o.size), o.nat, o.size), true);
          o.fill = { step: 1, prev };
        } else if (f.step === 1) {
          update(L.zoomAt(o.v, 1, cx, cy), true);
          f.step = 2;
        } else {
          update(f.prev);
        }
        break;
      }
    }
  }

  // Display mode or scale-up changed in Stash's options: re-place the current image
  function onChange(e: Event): void {
    const t = e.target;
    if (!(t instanceof HTMLElement) || !lb?.contains(t) || t.closest(".inzlb-option")) return;
    const isMode = t instanceof HTMLSelectElement && !!t.querySelector('option[value="FIT_X"]');
    if (!isMode && t.id !== "scaleUp") return;
    // Stash's form re-renders with the new value after its state update
    window.setTimeout(() => {
      const o = owned;
      if (!o) return;
      stopAnim();
      o.touched = false;
      o.fill = undefined;
      apply(o, startView(o.nat, o.size));
    }, OPTION_SETTLE_MS);
  }

  /* ---------------------------------------------------------------- *
   * Lifecycle
   * ---------------------------------------------------------------- */

  const LISTENERS: [string, (e: any) => void][] = [
    ["wheel", onWheel],
    ["mousedown", onMouseDown],
    ["mousemove", onMouseMove],
    ["mouseup", onMouseUp],
    ["click", onClick],
    ["pointerdown", onPointer],
    ["pointermove", onPointer],
    ["pointerup", onPointer],
    ["pointercancel", onPointer],
    ["touchstart", onTouchStart],
    ["touchmove", onTouchMove],
    ["touchend", onTouchEnd],
    ["touchcancel", onTouchEnd],
    ["keydown", onKeyDown],
    ["keyup", onKeyUp],
    ["change", onChange],
  ];
  const LISTEN = { capture: true, passive: false };

  const carouselObserver = new MutationObserver(() => sync());

  function attach(el: HTMLElement): void {
    lb = el;
    fullscreenTried = false;
    fullscreenPending = false;
    for (const [type, fn] of LISTENERS) window.addEventListener(type, fn, LISTEN);
    sync();
    openFullscreenOnce();
  }

  function detach(): void {
    release();
    for (const [type, fn] of LISTENERS) window.removeEventListener(type, fn, LISTEN);
    carouselObserver.disconnect();
    carousel = null;
    lb = null;
    endDrag();
    touching = false;
    touchBase = null;
    tap = null;
    indicator = null;
    indicatorText = null;
    clearTimeout(indicatorTimer);
    fullscreenPending = false;
  }

  function onDomChange(): void {
    const el = (found[0] as HTMLElement | undefined) ?? null;
    if (el !== lb) {
      if (lb) detach();
      if (el) attach(el);
    } else if (lb) {
      sync();
    }
  }

  L.watchSettings(() => {
    if (!lb) return;
    syncOptionChecks();
    openFullscreenOnce();
  });
  new MutationObserver(onDomChange).observe(document.body, { childList: true, subtree: true });
  window.addEventListener("pagehide", () => L.flushViews());
  onDomChange();
})();
