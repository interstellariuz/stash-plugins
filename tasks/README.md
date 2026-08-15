# inzVrGenerate — build plan

Replacement for `inzVrPreview`. Same idea — rebuild generated content from one eye — but
presented as an ordinary Stash generation that happens to understand VR, rather than as a
separate contraption with its own vocabulary.

The plugin is called `inzVrGenerate`; everything a user sees calls it **VR Generated Content**.

## What it is, in one paragraph

Stash builds every cover, preview, animated preview and scrubber sprite from the whole video
frame. For a VR file that frame is a stereo pair, so all four come out as a squashed double
image. This plugin runs the same generators over a single eye, centre-cropped to 16:9, and
writes the results to the paths Stash serves from. Nothing else: no tags, no custom fields, no
detection heuristics, no settings.

## Design rules

These are the decisions the whole thing hangs off. Changing one means revisiting several tasks.

1. **No plugin settings.** The manifest declares none. Everything that varies is asked for when
   a run is started, exactly as Stash asks for its own generation options.
2. **Behave like Stash's Generate.** Same switches, same defaults, same overwrite semantics
   (a generator early-returns when its output already exists unless *Overwrite* is on), same
   toast, same job queue. The single deliberate difference is the VR format select.
3. **The layout comes from the filename or from the user.** No content probing, no VR tag, no
   custom fields. `auto` reads naming-convention tokens; anything else is a straight override.
4. **16:9, centre of the eye.** The eye is centre-cropped to 16:9 keeping maximum area — full
   width for a tall eye, full height for a wide one. No reprojection, no zoom.
5. **No state files.** Existence on disk is the record, which is what Stash itself does.
6. **English only**, in code and in UI strings.

## Task files

Work through them in order; each one says what "done" means.

| # | File | Status |
|---|------|--------|
| — | [00-reference.md](00-reference.md) — Stash 0.31.1 facts the rest depends on | reference |
| 1 | [01-scaffold.md](01-scaffold.md) — plugin skeleton and build wiring | done |
| 2 | [02-backend-format.md](02-backend-format.md) — format table, tokens, geometry | done |
| 3 | [03-backend-generate.md](03-backend-generate.md) — the four artifacts | done |
| 4 | [04-backend-entry.md](04-backend-entry.md) — scene selection, run loop, entry point | done |
| 5 | [05-ui-generate-as-vr.md](05-ui-generate-as-vr.md) — menu item and dialog | done |
| 6 | [06-ui-plugin-tasks.md](06-ui-plugin-tasks.md) — Settings → Tasks section | done |
| 7 | [07-docs-and-retirement.md](07-docs-and-retirement.md) — README, drop inzVrPreview | done |

## Not doing (yet)

Marker previews, marker animated previews and marker screenshots. The switches are present and
disabled in both dialogs so the shape of the UI does not change when they are turned on; the
backend has no marker code at all. See [03-backend-generate.md](03-backend-generate.md).

Transcodes, force transcode, video perceptual hashes and interactive heatmaps are not this
plugin's business and are absent entirely — they do not care which eye they read.
