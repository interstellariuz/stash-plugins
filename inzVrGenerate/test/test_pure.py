"""The parts of the generator that need no ffmpeg and no Stash."""

import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

import inzVrGenerate  # noqa: E402
import vrformat  # noqa: E402
import vrgen  # noqa: E402


class FromFilenameTest(unittest.TestCase):
    def fmt(self, name):
        found = vrformat.from_filename(name)
        return found.value if found else None

    def test_tokens_with_any_separator(self):
        self.assertEqual(self.fmt("Studio.Title.MKX200.mp4"), "fisheye200")
        self.assertEqual(self.fmt("Studio-Title-180_SBS.mp4"), "sbs")
        self.assertEqual(self.fmt("studio title tb.mp4"), "tb")

    def test_most_specific_first(self):
        self.assertEqual(self.fmt("x_360x180_3dh.mp4"), "sbs360")
        self.assertEqual(self.fmt("Studio.MKX200.LR.mp4"), "fisheye200")

    def test_tokens_are_whole(self):
        self.assertIsNone(self.fmt("CLR_film.mp4"))
        self.assertIsNone(self.fmt("holiday.mp4"))

    def test_contradicting_names_are_not_guessed(self):
        with mock.patch.object(vrformat.vrlog, "warning") as warning:
            self.assertIsNone(self.fmt("x_TB_LR.mp4"))
        warning.assert_called_once()

    def test_resolve(self):
        self.assertEqual(vrformat.resolve("tb").eye, vrformat.TOP)
        with self.assertRaises(ValueError):
            vrformat.resolve("auto")


class GeometryTest(unittest.TestCase):
    def crop(self, value, w, h):
        return vrformat.Geometry(vrformat.resolve(value), w, h).crop

    def test_tall_eye_keeps_full_width(self):
        self.assertEqual(self.crop("sbs", 3840, 1920), (1920, 1080, 0, 420))

    def test_wide_eye_keeps_full_height(self):
        self.assertEqual(self.crop("tb", 3840, 3840), (3414, 1920, 212, 0))

    def test_odd_sizes_round_to_even(self):
        self.assertEqual(self.crop("sbs", 3841, 1921), (1920, 1080, 0, 420))

    def test_mono_takes_the_whole_frame(self):
        self.assertEqual(self.crop("mono", 1920, 1080), (1920, 1080, 0, 0))

    def test_vf(self):
        geometry = vrformat.Geometry(vrformat.resolve("sbs"), 3840, 1920)
        self.assertEqual(geometry.vf(width=640), "crop=1920:1080:0:420,scale=640:360,setsar=1")
        self.assertEqual(geometry.output_size(height=720), (1280, 720))


class TimingTest(unittest.TestCase):
    def test_preview_segments(self):
        options = {"segments": 4, "segment_duration": 2, "exclude_start": "10", "exclude_end": "10%"}
        self.assertEqual(vrgen.preview_segments(100, options), [(10, 2), (30, 2), (50, 2), (70, 2)])
        # shorter than the whole preview: one chunk of all of it
        self.assertEqual(vrgen.preview_segments(5, options), [(0.0, 5)])

    def test_sprite_grid(self):
        default = {"custom_interval": False}
        self.assertEqual(vrgen.sprite_grid(810, default), (81, 9))
        by_minimum = {"custom_interval": True, "minimum_sprites": 10, "maximum_sprites": 0, "interval": 0}
        self.assertEqual(vrgen.sprite_grid(100, by_minimum), (16, 4))
        capped = {"custom_interval": True, "minimum_sprites": 10, "maximum_sprites": 100, "interval": 1}
        self.assertEqual(vrgen.sprite_grid(1000, capped), (100, 10))

    def test_vtt_time(self):
        self.assertEqual(vrgen.vtt_time(3725.5), "01:02:05.500")
        self.assertEqual(vrgen.vtt_time(-1), "00:00:00.000")
        self.assertEqual(vrgen.vtt_time(float("nan")), "00:00:00.000")


class IsUnderTest(unittest.TestCase):
    def test_folder_and_inside_only(self):
        with tempfile.TemporaryDirectory() as root:
            folder = os.path.join(root, "vr")
            self.assertTrue(inzVrGenerate.is_under(os.path.join(folder, "a.mp4"), folder))
            self.assertTrue(inzVrGenerate.is_under(folder, folder))
            self.assertFalse(inzVrGenerate.is_under(os.path.join(root, "vr2", "a.mp4"), folder))
            self.assertFalse(inzVrGenerate.is_under("", folder))


if __name__ == "__main__":
    unittest.main()
