"""VR formats, the filename tokens that name them, and the crop they imply.

A format resolves to exactly one thing the encoder cares about: which part of
the frame holds one eye. The projection in a format's name is documentation and
token routing -- nothing here reprojects, so fisheye200 and plain side-by-side
produce identical ffmpeg arguments. They are kept apart anyway, because the
names are how people describe their files and because the tokens differ.
"""

import os
import re

import vrlog

LEFT = "left"    # the eye is the left half of the frame
TOP = "top"      # ... the top half
WHOLE = "whole"  # ... the whole frame; nothing to split

TARGET_RATIO = 16.0 / 9.0

AUTO = "auto"


class Format:
    def __init__(self, value, label, eye, tokens):
        self.value = value
        self.label = label
        self.eye = eye
        self.tokens = tokens


# Ordered most specific first: token matching is substring-based, so "3DH"
# would otherwise win over "360X180_3DH" and call a 360 file a 180 one. Both
# say "left eye", so nothing visible would change, but the log line would lie.
FORMATS = [
    Format("fisheye220", "Fisheye 220, side-by-side (MKX220, VRCA220)", LEFT,
           ("MKX220", "VRCA220")),
    Format("fisheye200", "Fisheye 200, side-by-side (MKX200)", LEFT,
           ("MKX200",)),
    Format("fisheye190", "Fisheye 190, side-by-side (RF52)", LEFT,
           ("FISHEYE190", "RF52")),
    Format("sbs360", "Side-by-side, 360", LEFT,
           ("360X180_3DH", "360_SBS", "360_LR")),
    Format("tb360", "Over/under, 360", TOP,
           ("360X180_3DV", "360_TB", "360_OU")),
    Format("mono", "Mono, 180 or 360 -- no stereo pair", WHOLE,
           ("360_MONO", "180_MONO", "MONO")),
    Format("sbs", "Side-by-side, 180", LEFT,
           ("180X180_3DH", "180_SBS", "SBS", "3DH", "LR")),
    Format("tb", "Over/under, 180", TOP,
           ("180X180_3DV", "OVERUNDER", "TOPBOTTOM", "3DV", "TB", "OU")),
]

BY_VALUE = {fmt.value: fmt for fmt in FORMATS}


def resolve(value):
    """A format by name. Raises rather than quietly falling back to a default."""
    try:
        return BY_VALUE[value]
    except KeyError:
        raise ValueError(
            "unknown VR format %r -- expected %s or %s"
            % (value, AUTO, ", ".join(sorted(BY_VALUE)))
        )


def _normalise(path):
    """The filename stem as _TOKEN_TOKEN_, whatever separated it.

    Dots, dashes, underscores and spaces all collapse to one underscore, so a
    token is found in Studio.Title.MKX200.mp4 and Studio-Title-MKX200.mp4 as
    readily as in the underscore spelling everyone assumes.
    """
    stem = os.path.splitext(os.path.basename(path))[0].upper()
    return "_" + re.sub(r"[-_. ]+", "_", stem).strip("_") + "_"


def from_filename(path):
    """The format named by the filename, or None when it names none.

    Several tokens may match at once -- MKX200 files are routinely also labelled
    LR -- which is fine as long as they agree about where the eye is. When they
    do not, the name is contradicting itself and is not worth guessing from.
    """
    name = _normalise(path)
    matched = [fmt for fmt in FORMATS
               if any("_%s_" % token in name for token in fmt.tokens)]
    if not matched:
        return None

    eyes = {fmt.eye for fmt in matched}
    if len(eyes) > 1:
        vrlog.warning(
            "%s: the filename claims %s at once, so it is not clear which eye "
            "to take -- pick a format explicitly"
            % (os.path.basename(path), " and ".join(fmt.value for fmt in matched))
        )
        return None
    return matched[0]


def even(value):
    """Round to a positive even integer -- libx264 and yuv420p require it."""
    return max(2, int(round(value / 2.0)) * 2)


class Geometry:
    """The crop that isolates one eye and centres a 16:9 frame inside it.

    Both steps fold into a single crop. They are worked out separately because
    they mean different things -- one undoes the stereo packing, the other picks
    a shape -- but ffmpeg has no reason to run two filters over every frame.

    Every number is an even integer, computed here rather than left to an
    ffmpeg expression: crop=iw/2 truncates on an odd width, which puts the
    second eye a pixel off, and yuv420p rejects odd dimensions anyway.
    """

    def __init__(self, fmt, width, height):
        self.format = fmt

        if fmt.eye == LEFT:
            eye_w, eye_h, eye_x, eye_y = (width // 2) & ~1, height & ~1, 0, 0
        elif fmt.eye == TOP:
            eye_w, eye_h, eye_x, eye_y = width & ~1, (height // 2) & ~1, 0, 0
        else:
            eye_w, eye_h, eye_x, eye_y = width & ~1, height & ~1, 0, 0

        self.eye_size = (eye_w, eye_h)

        # Centre a 16:9 window in the eye, keeping as much of it as that shape
        # allows: the full width of a tall eye, the full height of a wide one.
        if eye_w > eye_h * TARGET_RATIO:
            crop_w, crop_h = even(eye_h * TARGET_RATIO), eye_h
        else:
            crop_w, crop_h = eye_w, even(eye_w / TARGET_RATIO)
        crop_w, crop_h = min(crop_w, eye_w), min(crop_h, eye_h)

        self.crop = (
            crop_w,
            crop_h,
            eye_x + (((eye_w - crop_w) // 2) & ~1),
            eye_y + (((eye_h - crop_h) // 2) & ~1),
        )

    @property
    def width(self):
        return self.crop[0]

    @property
    def height(self):
        return self.crop[1]

    def output_size(self, width=None, height=None):
        """An even output size on this geometry's aspect ratio."""
        ratio = self.width / float(self.height)
        if width:
            return even(width), even(width / ratio)
        return even(height * ratio), even(height)

    def vf(self, width=None, height=None, size=None, tail=()):
        """The -vf chain: take one eye, land on an exact output size."""
        out_w, out_h = size if size else self.output_size(width, height)
        chain = [
            "crop=%d:%d:%d:%d" % self.crop,
            "scale=%d:%d" % (out_w, out_h),
            "setsar=1",
        ]
        chain.extend(tail)
        return ",".join(chain)

    def describe(self):
        return "%s %dx%d from a %dx%d eye" % (
            self.format.value, self.width, self.height,
            self.eye_size[0], self.eye_size[1],
        )
