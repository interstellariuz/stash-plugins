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

#### Which scenes

Scenes carrying the VR tag from **Settings → Interface → VR tag**, the same one that makes the
player's VR button appear. Override it with the `vrTagName` setting, add more with
`extraTagNames`, and opt individual scenes out with `excludeTagNames`.

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

Run **Detect layouts only** first: it logs the raw scores per scene without encoding anything, so
the thresholds can be checked against a real library before committing to a full run.

#### Flattening

By default the cropped eye keeps its wide-angle distortion. Turn on `dewarp` to reproject it to an
ordinary rectilinear 16:9 frame with ffmpeg's `v360`, so previews look like normal 2D video. It
needs to know the source projection, which comes from the filename or from `defaultProjection`,
and it is noticeably slower.

#### Running it

There is no post-generation hook in Stash, so this cannot run automatically. The workflow is: run
Stash's normal Generate, then use **Settings → Tasks → Plugin Tasks**:

| Task                        | Effect                                                        |
| --------------------------- | ------------------------------------------------------------- |
| Process VR scenes           | Rebuild what is missing or has been overwritten since          |
| Process VR scenes (force)   | Rebuild everything                                             |
| Dry run                     | Report what would change, write nothing                        |
| Detect layouts only         | Cache each scene's layout and log the raw scores               |
| Prune state                 | Forget deleted scenes, sweep leftover temporary files          |

A normal Stash Generate does **not** clobber these files — every generator early-returns when its
output already exists. Only a run with *overwrite* enabled replaces them, and the plugin notices
on the next pass: it records the size and modification time of everything it writes, so a re-run
is a `stat` per artifact and rebuilds only what actually changed.

#### Notes

- Marker screenshots and covers are capped at 1920 wide. Stash uses native resolution, which for
  an 8K VR file means a multi-megabyte still for a thumbnail.
- The sprite montage is built with ffmpeg's `tile` filter over piped raw frames; Stash does it in
  Go with `imaging`. Visually equivalent, not byte-identical.
- Stash stops plugins with SIGKILL, so everything is written to a temporary file beside its
  destination and moved into place atomically. A kill can leave `*.inzvr.tmp*` files behind;
  **Prune state** sweeps them.
