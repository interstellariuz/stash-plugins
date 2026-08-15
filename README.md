# stash-inz-plugins

Plugins for [Stash](https://github.com/stashapp/stash).

## Plugins

### inz-date-select

Adds date-based filtering to the two pickers that link scenes and galleries together:

- **Scene editor → Galleries** (`GallerySelect` / `FindGalleriesForSelect`)
- **Gallery editor → Scenes** (`SceneSelect` / `FindScenesForSelect`)

Two buttons appear under the picker:

| Button      | Effect                                                                  |
| ----------- | ----------------------------------------------------------------------- |
| `Same date` | Only entries whose date equals the edited entity's date (`date EQUALS`) |
| `±N d`      | Only entries within N days of it (`date BETWEEN`), N is configurable    |

The reference date is read live from the `Date` field of the same form, so it follows unsaved
edits. While a filter is active the dropdown is reordered by distance from that date instead of
alphabetically.

The buttons only show up in the scene and gallery edit panels. Every other place that uses these
pickers — the image editor, bulk edit, the scene merge dialog — is left untouched.

### inz-vr-generate — *VR Generated Content*

Stash builds every generated artifact from the whole video frame. For a VR file that frame is a
stereo pair, so the scene card, the hover preview and the scrubber all show a squashed double
image. This plugin generates the same files from **one eye, centre-cropped to 16:9**:

| Artifact          | File                                               |
| ----------------- | -------------------------------------------------- |
| Scene cover       | blob store, written through `sceneUpdate`          |
| Preview video     | `<generated>/screenshots/<hash>.mp4`               |
| Animated preview  | `<generated>/screenshots/<hash>.webp`              |
| Scrubber sprite   | `<generated>/vtt/<hash>_sprite.jpg`, `_thumbs.vtt` |

Every command mirrors the one Stash builds in `pkg/scene/generate`, so the results sit next to
the ones it generated for the rest of the library and behave identically in the UI.

It has no settings, and does nothing a normal generation does not — apart from asking which VR
format the video is in.

#### Requirements

**Stash v0.31.1 or newer.** Generation settings change between releases, so the plugin
introspects the schema on startup and asks only for the settings the server actually has;
anything missing falls back to what that version hardcoded.

The official `stashapp/stash` image is Alpine with `ffmpeg` but **no Python**, so add it:

```dockerfile
FROM stashapp/stash:latest
RUN apk add --no-cache python3
```

`docker exec stash apk add --no-cache python3` works too, but does not survive recreating the
container. Nothing beyond the standard library is needed — no pip packages.

#### Running it

Three ways, all of which look like Stash's own generation.

**From a selection in the scene list.** Select scenes, open the `…` menu, and pick *Generate as
VR…* — it sits directly under *Generate…*.

**From one scene.** The same entry in that scene's own `…` menu.

**From Settings → Tasks → Plugin Tasks.** The *VR Generated Content* block is shaped like the
**Generated Content** section above it: *Generate* covers the whole library, *Selective
Generate…* opens the folder picker first, and the switches underneath apply to both.

A folder means that folder and what is inside it, nothing else. Stash's path filter is a
substring of the whole path and, unquoted, is split on whitespace and OR'd word by word — so
`/d/My Videos` would come back as everything matching `%my%` or `%videos%`, which for most
libraries is all of it. The criterion is sent quoted, and what comes back is checked against the
folder before anything is encoded; anything the server matched that turns out to sit elsewhere is
counted in one log line. Symlinked and bind-mounted folders still work: a path that does not
match directly is compared again resolved.

The folders are the **server's** — as Stash sees them, which for a container means the paths
inside it, the ones the picker offers. A path typed by hand that no scene sits under ends the run
with a message saying so rather than quietly doing nothing.

The dialog is Stash's Generate dialog with the parts this plugin does not do left out. Transcodes,
video perceptual hashes and interactive heatmaps are absent — they read the whole frame anyway,
so run Stash's own Generate for those. Marker previews, marker animated previews and marker
screenshots are shown but disabled: not implemented yet.

#### Which format

`auto` reads the format out of the filename, matching the naming conventions DeoVR and HereSphere
understand. Tokens may be separated by underscores, dots, dashes or spaces — `Studio.Title.MKX200.mp4`
and `Studio-Title-MKX200.mp4` are both recognised.

| Format                                | Eye        | Filename tokens                                       |
| ------------------------------------- | ---------- | ----------------------------------------------------- |
| Side-by-side, 180°                    | left half  | `LR` `SBS` `3DH` `180_SBS` `180x180_3dh`              |
| Over/under, 180°                      | top half   | `TB` `OU` `OVERUNDER` `TOPBOTTOM` `3DV` `180x180_3dv` |
| Side-by-side, 360°                    | left half  | `360_SBS` `360_LR` `360x180_3dh`                      |
| Over/under, 360°                      | top half   | `360_TB` `360_OU` `360x180_3dv`                       |
| Fisheye 190°, side-by-side            | left half  | `FISHEYE190` `RF52`                                   |
| Fisheye 200°, side-by-side            | left half  | `MKX200`                                              |
| Fisheye 220°, side-by-side            | left half  | `MKX220` `VRCA220`                                    |
| Mono — 180° or 360°, no stereo pair   | whole frame| `MONO` `180_MONO` `360_MONO`                          |

The same table is on each option's tooltip in the format select.

A scene whose filename carries none of these is **left alone** under `auto`, with a line in the
log saying so — this plugin exists for VR files, and a 2D file that slipped into the selection
should not have half its frame cropped away. Choosing a format explicitly instead of `auto`
applies it to every scene in the run, filename or not.

Only the eye matters to what is generated: the projection in a format's name is there to route
the tokens and to say what the file is, and the fisheye variants produce the same output as plain
side-by-side. Nothing is reprojected.

#### What the frame ends up as

The eye is centre-cropped to 16:9, keeping as much of it as that shape allows — the full width of
a tall eye, the full height of a wide one:

| Source              | Eye         | Result      |
| ------------------- | ----------- | ----------- |
| 3840×1920 side-by-side | 1920×1920 | 1920×1080 |
| 3840×2160 over/under   | 3840×1080 | 1920×1080 |

Wide-angle distortion is left alone. Nothing is zoomed beyond what the aspect change forces.

#### Overwriting

The same rule Stash applies: each artifact is skipped when it already exists, unless *Overwrite
existing files* is on. So a VR scene Stash has already generated keeps its squashed preview until
a run with overwrite replaces it.

Covers are the one exception and are always rebuilt when *Scene covers* is ticked. There is no way
to ask over GraphQL whether a scene has a cover, and a scene that has one has the squashed cover
Stash made — which is the thing being fixed.

#### Notes

- Covers are capped at 1920 wide. Stash uses native resolution, which for the cropped eye of an
  8K file is still 3840 — a multi-megabyte still for a thumbnail.
- The sprite montage is built with ffmpeg's `tile` filter over piped raw frames; Stash does it in
  Go with `imaging`. Visually equivalent, not byte-identical.
- The animated preview is encoded from the video preview on disk, which is what Stash does too,
  and like Stash it is only generated alongside it — that is why the switch is a sub-setting and
  is disabled when *Previews* is off.
- Stash stops plugins with SIGKILL, so everything is written to a temporary file beside its
  destination and moved into place atomically. Anything a kill leaves behind carries
  `*.inzvrgen.tmp*` in its name and is swept by the next run, once it is a day old.
- The preview is retried with slow seek when fast seek fails, and switches to `-vsync 2` for a
  file reporting a nonsense frame rate — both of which Stash's own preview task does, and without
  which a handful of files that Stash can preview would come back as failures here.
- Scenes are processed as many at a time as the server's **Parallel Tasks** setting allows, with
  four ffmpeg threads each — the same budget Stash spends on its own generation.
- Stash gives a plugin task no way to ask for anything, so the dialogs and the menu entries are a
  UI script shipped inside the same plugin. Nothing depends on it: with the UI half disabled the
  plain **Generate** task still works, and generates everything for every scene.

## Development

```
npm run build      # copy/compile each plugin into <plugin>/dist/<id>/
npm run package    # zip every dist package and write pages/index.yml
```

`npm run check:graphql` validates every query inzVrGenerate can send against Stash's real schema —
both the oldest supported release and whatever the checkout is on — including the variables, so a
wrong field in `SceneUpdateInput` fails too. It reads the SDL out of a Stash source checkout,
`../stash` by default:

```
STASH_SRC=/path/to/stash npm run check:graphql
```

Without a checkout it reports a skip and exits 0, so it never blocks a build. Worth running after
touching anything in [vrstash.py](inzVrGenerate/src/vrstash.py) — Stash returns HTTP 422 for an
unknown field, which surfaces as a plugin-wide failure rather than a missing value.

[tasks/](tasks/) holds the build plan for inz-vr-generate, and
[tasks/00-reference.md](tasks/00-reference.md) the Stash 0.31.1 internals it is built on — which
patch points really exist, how the two `…` menus are reached, and which encoder parameters have
to be matched.
