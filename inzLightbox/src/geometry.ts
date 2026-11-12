/**
 * View math. A view places the image's top-left corner at (x, y) inside the
 * box, scaled by s: s = 1 is 100%, natural pixels.
 */

namespace InzLightbox {
  export interface Size {
    w: number;
    h: number;
  }

  export interface View {
    s: number;
    x: number;
    y: number;
  }

  /** Scale plus the image point at the box centre, as fractions of the image size. */
  export interface NormView {
    s: number;
    cx: number;
    cy: number;
  }

  export type DisplayMode = "ORIGINAL" | "FIT_XY" | "FIT_X";

  export function fitScreenScale(n: Size, b: Size): number {
    return Math.min(b.w / n.w, b.h / n.h);
  }

  export function fitWidthScale(n: Size, b: Size): number {
    return b.w / n.w;
  }

  export function coverScale(n: Size, b: Size): number {
    return Math.max(b.w / n.w, b.h / n.h);
  }

  /** Stash's calculateDefaultZoom (LightboxImage.tsx). */
  export function defaultScale(n: Size, b: Size, mode: DisplayMode, scaleUp: boolean): number {
    if (!scaleUp && n.w < b.w && n.h < b.h) return 1;
    switch (mode) {
      case "ORIGINAL":
        return 1;
      case "FIT_X":
        return scaleUp ? fitWidthScale(n, b) : Math.min(fitWidthScale(n, b), 1);
      default:
        return scaleUp ? fitScreenScale(n, b) : Math.min(fitScreenScale(n, b), 1);
    }
  }

  export function clampScale(s: number, n: Size, b: Size): number {
    const fit = fitScreenScale(n, b);
    const min = Math.min(fit, 1) * 0.1;
    const max = Math.max(16, fit * 8);
    return Math.min(max, Math.max(min, s));
  }

  // Larger than the box: no empty band at either edge. Smaller: centred, or
  // anywhere fully inside the box when free.
  function clampAxis(pos: number, size: number, box: number, free: boolean): number {
    if (size <= box && !free) return (box - size) / 2;
    return Math.min(Math.max(0, box - size), Math.max(Math.min(0, box - size), pos));
  }

  export function clampView(v: View, n: Size, b: Size, free = false): View {
    return { s: v.s, x: clampAxis(v.x, n.w * v.s, b.w, free), y: clampAxis(v.y, n.h * v.s, b.h, free) };
  }

  /** Scale by factor, stopping at 100% when the step would cross it. */
  export function stepScale(s: number, factor: number): number {
    const next = s * factor;
    return (s < 1 && next > 1) || (s > 1 && next < 1) ? 1 : next;
  }

  /** Centre of the visible part of the image, in box coordinates. */
  export function visibleCenter(v: View, n: Size, b: Size): { x: number; y: number } {
    const mid = (pos: number, size: number, box: number) =>
      (Math.max(0, pos) + Math.min(box, pos + size)) / 2;
    return { x: mid(v.x, n.w * v.s, b.w), y: mid(v.y, n.h * v.s, b.h) };
  }

  export function centered(s: number, n: Size, b: Size): View {
    return { s, x: (b.w - n.w * s) / 2, y: (b.h - n.h * s) / 2 };
  }

  /** Rescale keeping the image point under (ax, ay) in place. */
  export function zoomAt(v: View, s: number, ax: number, ay: number): View {
    const k = s / v.s;
    return { s, x: ax - (ax - v.x) * k, y: ay - (ay - v.y) * k };
  }

  export function toNorm(v: View, n: Size, b: Size): NormView {
    return { s: v.s, cx: (b.w / 2 - v.x) / (n.w * v.s), cy: (b.h / 2 - v.y) / (n.h * v.s) };
  }

  export function fromNorm(nv: NormView, n: Size, b: Size): View {
    return { s: nv.s, x: b.w / 2 - nv.cx * n.w * nv.s, y: b.h / 2 - nv.cy * n.h * nv.s };
  }
}
