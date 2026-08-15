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

### inz-vr-preview

Stash builds every generated artifact from the whole video frame. For a VR file that frame is a
stereo pair, so the scene card, the hover preview and the scrubber all show a squashed double
image. This plugin rebuilds them from **one eye**:

| Artifact               | File                                        |
| ---------------------- | ------------------------------------------- |
| Preview video          | `<generated>/screenshots/<hash>.mp4`        |
| Animated preview       | `<generated>/screenshots/<hash>.webp`       |
| Scrubber sprite + VTT  | `<generated>/vtt/<hash>_sprite.jpg`, `_thumbs.vtt` |
| Marker previews        | `<generated>/markers/<hash>/<seconds>.{mp4,webp,jpg}` |
| Scene cover            | blob store, written through `sceneUpdate`   |

Every command mirrors the one Stash builds in `pkg/scene/generate`, with a `crop` prepended to the
filter chain, so the results behave identically in the UI.

#### Requirements

The official `stashapp/stash` image is Alpine with `ffmpeg` but **no Python**, so add it:

```dockerfile
FROM stashapp/stash:latest
RUN apk add --no-cache python3
```

`docker exec stash apk add --no-cache python3` works too, but does not survive recreating the
container. Nothing beyond the standard library is needed — no pip packages.

**Stash v0.31.1 or newer.** Generation settings change between releases, so the plugin introspects
the schema on startup and asks only for the settings the server actually has; anything missing
falls back to what that version hardcoded. v0.31.1, for instance, has no configurable marker
preview duration and capped it at 20 seconds.

#### Which scenes

Scenes carrying the VR tag from **Settings → Interface → VR tag**, the same one that makes the
player's VR button appear. Add more with `extraTagNames` and opt individual scenes out with
`excludeTagNames`. Tags are matched by name, ignoring case; child tags count too.

A run can be narrowed further to particular folders or to a handful of scene ids — see
[Running it](#running-it).

#### Which eye

Side-by-side and over-under are told apart automatically, from three signals in this order:

1. A per-scene pin in the `inz_vr_layout` custom field — `sbs`, `tb` or `mono`, optionally with a
   projection, e.g. `sbs:fisheye200`.
2. Filename tokens: `_LR`, `_SBS`, `_TB`, `_OU`, `MKX200`, `MKX220`, `VRCA220`, `FISHEYE190`,
   `RF52`, `180x180_3dh`, and friends. These also give the projection.
3. The picture itself. Several frames spread across the file are sampled and the halves compared
   with ffmpeg's `ssim` filter, along both axes. Each axis is also compared against a mirrored
   copy of itself as a control — a symmetric room shot in mono matches its own reflection just as
   well as it matches the other half, whereas a real stereo pair does not.

Measured on test footage: a genuine stereo pair scores **0.85–0.88**, flat 2D scores **~0.50**.
The `stereoThreshold` default of 0.75 sits between them. Anything that does not clearly look
stereo is reported `mono` and left completely alone — the safe direction, since a wrong stereo
verdict would crop away half of a perfectly good 2D scene.

The mirror control is what carries the awkward cases. A flat 2:1 scene can easily score 0.83 on
the top-versus-bottom comparison — well over the threshold — and would be cropped in half on that
evidence alone; its own mirror scores 0.83 too, which is what marks it as symmetry rather than
stereo.

Run **Detect layouts only** first: it logs all four scores per scene without encoding anything, so
the thresholds can be checked against a real library before committing to a full run. If the
picture cannot be read at all the scene falls back to its shape, and says so in a warning — that
is the one path that can misjudge a mono 360 file, which has the same 2:1 shape as a stereo pair.

When nothing identifies the layout at all — no filename token, no readable picture, and a shape
that says nothing either — the scene is treated as **side-by-side** rather than left alone, with a
warning naming the file. Anything reaching that point carries a VR tag, and side-by-side is what
nearly all of them are, so guessing beats leaving a squashed stereo pair in the grid. This only
ever applies for want of evidence: a picture that *was* read and came back flat is a verdict, and
such a scene stays `mono` and untouched.

A run started from a selection in the scene list is the one case where the tag cannot be taken for
granted — Stash ignores the tag filter once a query names scene ids — so those scenes are checked
against the configured tags first, and an untagged one is left as `mono` rather than guessed at.

`stereoThreshold`, `layoutMargin` and `dewarpAspect` are text fields rather than number fields.
Stash's number input runs the value through `parseInt`, so `0.75` would arrive as `0`; as text the
fraction survives. `dewarpAspect` also accepts `16:9`.

#### Flattening

By default the cropped eye keeps its wide-angle distortion. Turn on `dewarp` to reproject it to an
ordinary rectilinear 16:9 frame with ffmpeg's `v360`, so previews look like normal 2D video. It
needs to know the source projection, which comes from the filename or from `defaultProjection`,
and it is noticeably slower.

#### Running it

There is no post-generation hook in Stash, so nothing here happens on its own. There are three
ways to start a run.

**From Stash's own Generate dialog.** The plugin adds a switch, *Rebuild VR artifacts from one
eye*, to the bottom of that dialog — wherever it is opened from: **Settings → Tasks**, the `…` menu
over selected scenes, or a single scene's own `…` menu. Whichever scenes, folders and artifacts
were chosen for Stash are what the VR pass gets, so this is also how a run is aimed at one scene.

Turning the switch on reveals a second control, *VR pass*, with two choices:

| Choice                          | Effect                                                                 |
| ------------------------------- | ---------------------------------------------------------------------- |
| After Stash's own generation    | Both run, ours second — the queue is serial, so it starts as the first finishes |
| Instead of it — **VR only**     | Stash's generation is not queued at all; only the VR pass runs           |

*VR only* is usually what a VR scene wants. Stash builds from the whole stereo frame and this
plugin then rebuilds the same artifacts from one eye, so running both encodes everything twice and
throws the first result away. Only the overlapping artifacts are taken away from Stash: phashes,
transcodes, interactive heatmaps and the rest of what this plugin does not touch are still
generated normally, in a job of their own ahead of the VR pass.

**From the dialog.** *Generate VR…* sits under this plugin's tasks in **Settings → Tasks → Plugin
Tasks**, and asks for everything a run needs: which artifacts to rebuild, whether to overwrite,
which folders to restrict it to, a scene limit, and whether to log verbosely. Folders are picked
with the same directory browser Stash uses.

**As a plain task.** The buttons in **Settings → Tasks → Plugin Tasks** take no options and act on
every VR-tagged scene:

| Task                        | Effect                                                        |
| --------------------------- | ------------------------------------------------------------- |
| Process VR scenes           | Rebuild what is missing or has been overwritten since          |
| Process VR scenes (force)   | Rebuild everything                                             |
| Dry run                     | Report what would change, write nothing                        |
| Detect layouts only         | Cache each scene's layout and log the raw scores               |
| Prune state                 | Forget deleted scenes, sweep leftover temporary files          |

Folders are matched as a substring of the file's path, not as a strict parent directory, so
`\vr\studio` selects everything under it and anything else whose path contains that text.

A normal Stash Generate does **not** clobber these files — every generator early-returns when its
output already exists. Only a run with *overwrite* enabled replaces them, and the plugin notices
on the next pass: it records the size and modification time of everything it writes, so a re-run
is a `stat` per artifact and rebuilds only what actually changed.

Settings are tracked the same way, in two halves. Retuning a detection threshold re-examines the
picture but leaves alone the artifacts whose verdict did not move; changing the eye or the dewarp
re-encodes without re-probing. A scene that fails part way through keeps the artifacts it already
finished, so an interrupted run resumes instead of starting over.

#### Notes

- Marker screenshots and covers are capped at 1920 wide. Stash uses native resolution, which for
  an 8K VR file means a multi-megabyte still for a thumbnail.
- The sprite montage is built with ffmpeg's `tile` filter over piped raw frames; Stash does it in
  Go with `imaging`. Visually equivalent, not byte-identical.
- Stash stops plugins with SIGKILL, so everything is written to a temporary file beside its
  destination and moved into place atomically. A kill can leave `*.inzvr.tmp*` files and
  directories behind; **Prune state** sweeps anything carrying that marker and older than a day.
- The preview is retried with slow seek when fast seek fails, and switches to `-vsync 2` for a
  file reporting a nonsense frame rate — both of which Stash's own preview task does, and without
  which a handful of files that Stash can preview would come back as failures here.
- Scenes are processed as many at a time as the server's **Parallel Tasks** setting allows, with
  four ffmpeg threads each — the same budget Stash spends on its own generation.
- Upgrading to the version that added the side-by-side fallback re-runs layout detection once, so
  that scenes previously written off as `mono` for want of evidence are reconsidered. That pass
  samples the picture again but does not re-encode: only the scenes whose verdict actually moved
  are rebuilt.
- Stash gives a plugin task no way to ask for anything, so the dialog and the switch are a small
  UI script shipped inside the same plugin. Nothing depends on it — every task still works with
  the UI half disabled, just without the options.

## Development

```
npm run build      # copy/compile each plugin into <plugin>/dist/<id>/
npm run package    # zip every dist package and write pages/index.yml
```

`npm run check:graphql` validates every query inzVrPreview can send against Stash's real schema —
both the oldest supported release and whatever the checkout is on — including the variables, so a
wrong field in `SceneUpdateInput` fails too. It reads the SDL out of a Stash source checkout, `../stash`
by default:

```
STASH_SRC=/path/to/stash npm run check:graphql
```

Without a checkout it reports a skip and exits 0, so it never blocks a build. Worth running after
touching anything in [vrstash.py](inzVrPreview/src/vrstash.py) — Stash returns HTTP 422 for an
unknown field, which surfaces as a plugin-wide failure rather than a missing value.
