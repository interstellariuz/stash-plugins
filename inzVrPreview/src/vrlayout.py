"""Working out how a VR file packs its two eyes, and the crop that undoes it."""

import math
import os
import re
import statistics

import vrlog
import vrmedia

SBS = "sbs"
TB = "tb"
MONO = "mono"

# What a scene gets when nothing could be established: no filename token, no
# readable picture, no usable shape. Everything here is already known to carry a
# VR tag, and side-by-side is what the overwhelming majority of VR files are, so
# guessing it beats leaving the scene with a squashed stereo pair for a preview.
# This is only ever reached for want of evidence — a picture that was read and
# came back flat is a verdict, and stays MONO.
FALLBACK = SBS

# Tokens that appear in the naming conventions DeoVR and HereSphere understand.
# Layout and projection are separate axes: MKX200 says both "side by side" and
# "200 degree fisheye", while a bare _180_ says only "equirectangular".
_TB_TOKENS = ("_TB_", "_OU_", "_OVERUNDER_", "_TOPBOTTOM_", "_3DV_", "_180X180_3DV_", "_360X180_3DV_")
_SBS_TOKENS = (
    "_LR_", "_SBS_", "_3DH_", "_180X180_3DH_", "_360X180_3DH_",
    "_MKX200_", "_MKX220_", "_VRCA220_", "_FISHEYE190_", "_RF52_",
)
_PROJECTION_TOKENS = (
    ("_MKX200_", "fisheye200"),
    ("_MKX220_", "fisheye220"),
    ("_VRCA220_", "fisheye220"),
    ("_FISHEYE190_", "fisheye190"),
    ("_RF52_", "fisheye190"),
    ("_360X180_", "equirect"),
    ("_360_", "equirect"),
    ("_180X180_", "hequirect"),
    ("_180_", "hequirect"),
)

_SSIM_RE = re.compile(r"\[ssim@(lr|tb|lrm|tbm) @[^\]]*\]\s+SSIM\b.*?\bAll:([0-9.]+)")

# A frame where everything matches everything — a black frame, a title card —
# carries no layout information and would otherwise vote for whichever axis
# happens to win the noise.
_UNIFORM_CUT = 0.985

# One decoded frame plus four cheap 192x192 comparisons. Generous enough for a
# cold cache on a spinning disk, short enough that a wedged file gives up.
SSIM_TIMEOUT = 120


class Geometry:
    """The crop that isolates one eye, plus the filter chain built on top."""

    def __init__(self, layout, projection, width, height, settings):
        self.layout = layout
        self.projection = projection
        self.width = width
        self.height = height
        self.dewarp = bool(settings.dewarp)
        self.dewarp_hfov = float(settings.dewarpHFov)
        self.dewarp_aspect = float(settings.dewarpAspect)

        # Even integers computed here rather than left to ffmpeg: crop=iw/2
        # truncates on an odd width, which would put the second eye one pixel
        # off, and yuv420p rejects odd dimensions downstream anyway.
        second = bool(settings.useSecondEye)
        if layout == SBS:
            cw = (width // 2) & ~1
            ch = height & ~1
            self.crop = (cw, ch, width - cw if second else 0, 0)
        elif layout == TB:
            cw = width & ~1
            ch = (height // 2) & ~1
            self.crop = (cw, ch, 0, height - ch if second else 0)
        else:
            self.crop = (width & ~1, height & ~1, 0, 0)

        self.eye_w, self.eye_h = self.crop[0], self.crop[1]

    @property
    def aspect(self):
        if self.dewarp:
            return self.dewarp_aspect
        return self.eye_w / float(self.eye_h)

    def output_size(self, width=None, height=None):
        if width:
            return vrmedia.even(width), vrmedia.even(width / self.aspect)
        return vrmedia.even(height * self.aspect), vrmedia.even(height)

    def _v360(self, out_w, out_h):
        h_fov = self.dewarp_hfov
        # For a rectilinear output the aspect follows the tangents of the half
        # angles, so v_fov is derived rather than exposed as its own setting.
        v_fov = math.degrees(2 * math.atan(math.tan(math.radians(h_fov) / 2) / self.dewarp_aspect))
        common = "h_fov=%g:v_fov=%g:w=%d:h=%d" % (h_fov, v_fov, out_w, out_h)
        if self.projection.startswith("fisheye"):
            in_fov = float(self.projection[len("fisheye"):])
            return "v360=fisheye:flat:ih_fov=%g:iv_fov=%g:%s" % (in_fov, in_fov, common)
        if self.projection == "equirect":
            return "v360=e:flat:%s" % common
        return "v360=hequirect:flat:%s" % common

    def vf(self, width=None, height=None, size=None, tail=()):
        """The -vf chain: isolate one eye, then land on an exact output size."""
        out_w, out_h = size if size else self.output_size(width, height)
        chain = ["crop=%d:%d:%d:%d" % self.crop]
        if self.dewarp:
            # v360 is a per-pixel remap and painfully slow at 8K, so shrink the
            # eye to a few times the output size before remapping it.
            pre = min(self.eye_w, out_w * 4)
            if pre < self.eye_w:
                chain.append("scale=%d:-2" % vrmedia.even(pre))
            chain.append(self._v360(out_w, out_h))
        else:
            chain.append("scale=%d:%d" % (out_w, out_h))
        chain.append("setsar=1")
        chain.extend(tail)
        return ",".join(chain)

    def crop_only(self):
        return "crop=%d:%d:%d:%d" % self.crop


def _normalise(path):
    stem = os.path.splitext(os.path.basename(path))[0].upper()
    return "_" + re.sub(r"[-_. ]+", "_", stem).strip("_") + "_"


def from_filename(path):
    """(layout, projection) from naming-convention tokens; either may be None."""
    name = _normalise(path)
    is_tb = any(token in name for token in _TB_TOKENS)
    is_sbs = any(token in name for token in _SBS_TOKENS)

    projection = None
    for token, value in _PROJECTION_TOKENS:
        if token in name:
            projection = value
            break

    if is_tb and is_sbs:
        vrlog.debug("filename %s claims both layouts, ignoring the hint" % os.path.basename(path))
        return None, projection
    if is_tb:
        return TB, projection
    if is_sbs:
        return SBS, projection
    return None, projection


def _ssim_at(path, timestamp, width, height):
    """Measure one frame's stereo signature in a single ffmpeg pass.

    Four numbers come back: how well the left half matches the right (lr) and
    the top the bottom (tb), plus the same comparisons against a mirrored half
    (lrm, tbm). The mirrored pair is the control — a symmetric room shot in
    mono matches its own reflection just as well as it matches the other half,
    whereas a real stereo pair does not.

    The summary lines arrive in a nondeterministic order, so each ssim instance
    is named and the name is parsed back out.
    """
    cw, ch = (width // 2) & ~1, (height // 2) & ~1
    full_w, full_h = width & ~1, height & ~1
    xr, yb = width - cw, height - ch
    thumb = "scale=192:192,setsar=1,format=gray"

    left = "crop=%d:%d:0:0,%s" % (cw, full_h, thumb)
    right = "crop=%d:%d:%d:0,%s" % (cw, full_h, xr, thumb)
    top = "crop=%d:%d:0:0,%s" % (full_w, ch, thumb)
    bottom = "crop=%d:%d:0:%d,%s" % (full_w, ch, yb, thumb)

    graph = [
        "[a]%s[l]" % left,
        "[b]%s[r]" % right,
        "[c]%s[t]" % top,
        "[d]%s[o]" % bottom,
        "[e]%s[l2]" % left,
        "[f]%s,hflip[rm]" % right,
        "[g]%s[t2]" % top,
        "[h]%s,vflip[bm]" % bottom,
        "[l][r]ssim@lr[s1]",
        "[t][o]ssim@tb[s2]",
        "[l2][rm]ssim@lrm[s3]",
        "[t2][bm]ssim@tbm[s4]",
    ]
    labels = "".join("[%s]" % c for c in "abcdefgh")
    filtergraph = "[0:v]split=8%s;" % labels + ";".join(graph)

    args = [
        "-hide_banner", "-v", "info", "-nostats", "-y",
        "-ss", "%.3f" % timestamp, "-i", path, "-an",
        "-filter_complex", filtergraph,
    ]
    # -frames:v is an output option and binds to the next output only. Setting
    # it once before the first -map leaves the other three comparisons running
    # to the end of the file: they would decode everything past the seek point
    # and report an average over all of it instead of this one frame. On an
    # eight-minute-plus VR file that is the difference between 0.1 seconds and
    # a timeout.
    for label in ("s1", "s2", "s3", "s4"):
        args += ["-map", "[%s]" % label, "-frames:v", "1", "-f", "null", "-"]

    # SSIM prints its summary at info level, so unlike every other call here
    # the loglevel cannot be "error".
    stderr = vrmedia.run(args, want_stderr=True, timeout=SSIM_TIMEOUT)
    return {name: float(value) for name, value in _SSIM_RE.findall(stderr)}


def from_content(path, width, height, duration, samples):
    """Median stereo signature over frames spread across the file.

    The median rather than the mean so one black frame or credits card that
    slips past the uniformity guard cannot drag the verdict.
    """
    samples = max(3, int(samples))
    scores = {"lr": [], "tb": [], "lrm": [], "tbm": []}

    for index in range(samples):
        fraction = 0.10 + 0.80 * index / float(samples - 1)
        try:
            result = _ssim_at(path, duration * fraction, width, height)
        except vrmedia.FfmpegError as exc:
            vrlog.debug("ssim sample at %.1f%% failed: %s" % (fraction * 100, exc))
            continue
        if "lr" not in result or "tb" not in result:
            continue
        if min(result["lr"], result["tb"]) >= _UNIFORM_CUT:
            vrlog.trace("skipping featureless frame at %.1f%%" % (fraction * 100))
            continue
        for key, value in result.items():
            scores.setdefault(key, []).append(value)

    if len(scores["lr"]) < 3:
        return None
    return {key: statistics.median(values) for key, values in scores.items() if values}


def decide(scene, video_file, probe, settings, allow_fallback=True):
    """Resolve a layout, returning (layout, projection, detail dict).

    allow_fallback says whether this scene may be guessed at when nothing
    identifies its layout — see FALLBACK. A scene that is not known to be VR
    does not qualify and is left as MONO instead.
    """
    path = video_file.get("path") or ""
    detail = {}
    unknown = FALLBACK if allow_fallback else MONO

    override, projection = _manual_override(scene)
    if override:
        detail["signal"] = "manual"
        return override, projection or _projection_for(override, None, settings), detail

    mode = settings.layoutDetection
    name_layout, name_projection = from_filename(path)
    detail["filename"] = name_layout

    content = None
    if mode in ("auto", "content") and probe["duration"] > 0:
        content = from_content(
            path, probe["width"], probe["height"], probe["duration"], settings.layoutSamples
        )
        if content:
            # All four, including both mirror controls: these are the numbers
            # "Detect layouts only" exists to show, and the thresholds cannot
            # be calibrated against half of them.
            for key in ("lr", "lrm", "tb", "tbm"):
                if key in content:
                    detail["s_" + key] = round(content[key], 4)

    content_layout = _content_verdict(content, settings, detail)

    if mode == "filename":
        layout, signal = (name_layout, "filename") if name_layout else (unknown, "fallback")
    elif mode == "content":
        layout, signal = (content_layout, "content") if content_layout else (unknown, "fallback")
    elif mode == "aspect":
        layout, signal = _from_aspect(probe), "aspect"
    elif name_layout and content_layout and name_layout != content_layout:
        # Mislabelled filenames are common; a decisive SSIM reading is not.
        vrlog.warning(
            "%s: filename says %s but the picture says %s (lr=%.3f tb=%.3f) — trusting the picture"
            % (os.path.basename(path), name_layout, content_layout, content["lr"], content["tb"])
        )
        layout, signal = content_layout, "content"
    elif content_layout:
        layout, signal = content_layout, "content"
    elif name_layout:
        layout, signal = name_layout, "filename"
    else:
        # Last resort. Worth telling apart two ways of getting here: an
        # ambiguous reading still says the file looks stereo on both axes, so
        # the shape is a fair tiebreak, but no reading at all means shape is
        # the only evidence there is — and a mono 360 file is exactly 2:1, the
        # same shape as a side-by-side pair.
        layout, signal = _from_aspect(probe), "aspect"
        if content is None and layout != MONO and probe["duration"] > 0:
            vrlog.warning(
                "%s: could not read the picture, guessing %s from its %dx%d shape alone — "
                "pin it with the inz_vr_layout custom field if that is wrong"
                % (os.path.basename(path), layout, probe["width"], probe["height"])
            )

    # Nothing said anything: neither the name, nor the picture, nor the shape.
    # Rather than leave a VR-tagged scene with its stereo pair squashed into
    # every thumbnail, assume the layout nearly all of them use and say so.
    if allow_fallback and layout == MONO and signal in ("fallback", "aspect"):
        vrlog.warning(
            "%s: nothing identifies the layout of this %dx%d file, assuming %s — "
            "pin it with the inz_vr_layout custom field if that is wrong"
            % (os.path.basename(path), probe["width"], probe["height"], FALLBACK)
        )
        layout, signal = FALLBACK, "fallback"

    detail["signal"] = signal
    return layout, _projection_for(layout, name_projection, settings), detail


def _manual_override(scene):
    """A per-scene pin, e.g. custom field inz_vr_layout = "sbs" or "tb:fisheye200"."""
    raw = (scene.get("custom_fields") or {}).get("inz_vr_layout")
    if not isinstance(raw, str) or not raw.strip():
        return None, None
    layout, _, projection = raw.strip().lower().partition(":")
    if layout not in (SBS, TB, MONO):
        vrlog.warning("scene %s: inz_vr_layout=%r is not sbs/tb/mono" % (scene.get("id"), raw))
        return None, None
    return layout, projection or None


# How much better a half must match the other half than it matches that half's
# mirror image. Symmetric mono content scores high on both; stereo does not.
_MIRROR_MARGIN = 0.10


def _content_verdict(content, settings, detail):
    """Score each axis independently, then require a clear winner.

    An axis is only stereo if the halves are similar in absolute terms *and*
    meaningfully more similar than the mirror control. Comparing lr against tb
    alone is not enough: self-similar footage scores high on both axes.
    """
    if not content:
        return None

    lr, tb = content["lr"], content["tb"]
    lrm, tbm = content.get("lrm", 0.0), content.get("tbm", 0.0)

    sbs_ok = lr >= settings.stereoThreshold and lr - lrm >= _MIRROR_MARGIN
    tb_ok = tb >= settings.stereoThreshold and tb - tbm >= _MIRROR_MARGIN
    detail["sbs_ok"], detail["tb_ok"] = sbs_ok, tb_ok

    if not sbs_ok and not tb_ok:
        return MONO
    if sbs_ok and tb_ok:
        # Both axes look stereo — only possible on very self-similar footage.
        # Fall back to the gap between them, and give up if that is thin too.
        if abs(lr - tb) < settings.layoutMargin:
            detail["ambiguous"] = True
            return None
        return SBS if lr > tb else TB
    return SBS if sbs_ok else TB


def _from_aspect(probe):
    if not probe["height"]:
        return MONO
    ratio = probe["width"] / float(probe["height"])
    if 1.90 <= ratio <= 2.10:
        return SBS
    if 0.95 <= ratio <= 1.05:
        return TB
    return MONO


def _projection_for(layout, name_projection, settings):
    if name_projection:
        return name_projection
    if settings.defaultProjection != "auto":
        return settings.defaultProjection
    return "equirect" if layout == TB else "hequirect"
