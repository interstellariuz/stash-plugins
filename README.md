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

**Python 3**, found by Stash rather than by the plugin: it looks for `python3`, then `python`, then
whatever *Settings → System → Python executable path* is set to. Nothing beyond the standard library
is needed — no pip packages. Same for `ffmpeg` and `ffprobe`: the plugin resolves them exactly as
Stash does, so it encodes with the binaries the rest of the library was generated with.

The official `stashapp/stash` image is Alpine with `ffmpeg` but **no Python**, so add it:

```dockerfile
FROM stashapp/stash:latest
RUN apk add --no-cache python3
```

`docker exec stash apk add --no-cache python3` works too, but does not survive recreating the
container.

Windows and bare-metal Linux installations work the same way; on Windows, a Python that is not on
`PATH` only needs the executable path filled in under Settings → System.

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

A first run offers previews, scrubber sprites and the side-by-side format — the two artifacts a
squashed stereo frame ruins most visibly, and the layout most VR files are in. After that it
offers whatever was last used: the switches are remembered the way Stash remembers its own, in the
server's UI config, so they follow the library rather than the browser and both the dialog and the
tasks page always agree. *Override preview generation options* is the one exception and is asked
for fresh each time, since it describes a single run.

While a run is going, the job queue names it — *Generate as VR for 12 scenes* — and the plugin's
own block on the Tasks page lists what each worker is on, a line per scene, the same wording
Stash's generation uses. That readout is rebuilt from the log stream because a plugin cannot write
into the job row itself, so treat it as a status light: the progress bar is the accurate measure
and the log is the accurate record.

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
- The UI reuses Stash's own wording wherever Stash has some. The strings that are this plugin's
  own — the title, the format select and its options, the tasks-page blurb — are English, but each
  has a message id under `inzVrGenerate.`, so a `custom-locales.json` entry with the same id
  replaces it exactly as it would one of Stash's. The ids are the keys of the `TEXT` table at the
  top of [inzVrGenerate.tsx](inzVrGenerate/src/inzVrGenerate.tsx). The job-queue description is
  deliberately left out: the plugin recognises its own jobs by it.

### inz-records — *Download Records*

Imports the metadata the site userscripts (`site-scripts`, a neighbouring repository) collect
while downloading. The userscript sends the page's record to this plugin on every download; once
the file is scanned into Stash, one click puts title, date, code, details, URL, studio,
performers and tags on the scene or gallery, and links the scene to the gallery of the same page.

Records are matched to entities **by file name**: a file's `basename` against the record's
`downloads[].xName` and `savedName` (the name a hand-edited download landed under).

#### Where

- **Scene / gallery `…` menu → *Import from records…*** — directly under *Generate…*. From a
  scene, the galleries of the same record are handled in the same pass, and the other way round.
- **Scene and gallery lists → `…` → *Import from records…*** for a selection, across sites.
- **The status page** `/plugin/records` — the icon next to the settings cog (with the number of
  records ready to import), or *Settings → Plugins → Download Records*.

#### The dialog

Every entity gets a row: what changes field by field, scalar fields as "before → after" (marked
`replaces` when a value is already there), lists as additions only. Each field has its own switch,
all on by default. `custom_fields.source` (the direct file link) goes along without one.

- *up to date* — nothing to change; a repeated import is a no-op.
- *no record* — no record names any of the entity's files.
- *N records match* — the same file name is in several records; pick one, or it is skipped.
- *Link gallery …* — a gallery of the same record that is not linked yet; the link is written on
  the scene (`gallery_ids`, topped up). Its own fields expand under the same row.

Studios, performers and tags are matched by name and alias (letters and digits only) and nothing
is created by the import itself. What is not found is listed under *Not in Stash* with a
*Create* button (a performer gets the record's profile link); an ambiguous name lists its
candidates instead. After a create the preview is rebuilt.

The field logic is a port of the stash CLI (`stash/ops/records.mjs`, `ops/lookup.mjs`) in
[records.ts](inzRecords/src/records.ts) and behaves the same. The CLI keeps the substitution rules
(abbywinters); entities that need them are better imported with `records --rules` there.

#### The status page

A summary, not a table: records, files and sites received, when the last record arrived, and every
record in one of three states — *ready to import* (a downloaded file is in Stash, the entity does
not have the record's URL yet), *not in Stash yet* (no scene or gallery carries the file name: not
scanned, or renamed on disk; the file names expand below) and *imported*. *Import all ready* opens
the dialog on everything that is ready. The badge in the navbar shows the ready count from the
last check, refreshed at most every 10 minutes.

#### Storage

`<Stash config dir>/inzRecords/records.sqlite`, outside the plugin directory so reinstalling the
plugin keeps it. One row per record (`site` + record key), plus an index of its file names. The
backend is [inzRecords.py](inzRecords/src/inzRecords.py), Python 3 standard library only (`sqlite3`),
called through `runPluginOperation`:

| `op`      | args                  | returns                                     |
| --------- | --------------------- | ------------------------------------------- |
| `put`     | `site`, `key`, `record` | upserts the record, re-indexes its names  |
| `lookup`  | `names`               | every record holding a file of that name    |
| `stats`   | —                     | record counts per site                      |
| `summary` | —                     | per-record digest for the status page       |

#### Requirements

**Stash v0.32.0 or newer** and Python 3, found the same way as for inz-vr-generate above.

### inz-lightbox — *INZ Lightbox*

Makes the image lightbox comfortable for photos. UI only, no backend.

- **Zoom is remembered per photo** for the rest of the browser tab's session (sessionStorage):
  back on a photo, it shows the same zoom and the same spot, even after the window or fullscreen
  changed size. A photo seen for the first time opens the way Stash's display mode says (not
  at the previous photo's zoom), but **centred** — *Original* and *Fit horizontally* no longer
  open at the top edge.
- **The wheel zooms towards the cursor** and animates; a trackpad or a free-spinning wheel zooms
  directly. Wheel and `↑` / `↓` **stop at 100%** on the way through it. Shift swaps zoom and pan as in Stash, but **the wheel never changes the photo** —
  neither in *Pan Y* at the top or bottom edge nor with Shift held.
- **Dragging never changes the photo.** A click (under 4 px and 250 ms from the press) does,
  left or right half; Stash counted a fast drag as a click. The mouse moves the photo anywhere,
  past the screen edges too, as Stash's own drag does, but a strip of it (10% of the screen,
  at least 64 px) always stays in view, also after zooming or resizing, so it can be grabbed
  back. The wheel pans only up to the photo's edges.
  On touch the photo stays within the screen and centred on the axis where it fits.
- **Keep zoom and position** (`V`, or the lightbox options): the next photo opens at the
  previous one's zoom, relative to fit to screen, and at the same spot. `Z` `X` `C` or picking
  a display mode leave it.
- **Preloading:** two photos ahead and one behind are loaded and decoded in advance (both
  counts are settings), and the neighbouring slides are rendered off screen, so a slide no
  longer comes in black. Stash's own `content-visibility: auto` on the slides deferred that.
  *Disable preload* turns all of it off and leaves loading to Stash.
- **A zoom percentage** shows in the middle of the screen while zooming (not on touch devices).
- **Auto fullscreen** on open, switched in the plugin settings or in the lightbox options; both
  are the same setting. A browser that refuses fullscreen without a fresh click gets it on the
  first click or key inside the lightbox. With it on, `Esc` closes the lightbox in one press
  instead of only leaving fullscreen; the fullscreen button still just leaves it.
- **Touch:** a tap on the left 30% of the screen goes back, the rest goes forward; fast taps no
  longer select text or raise Firefox's copy bar, and no longer close the lightbox when they
  miss the photo. Pinch zooms towards the point between the fingers, and lifting one finger
  no longer makes the photo jump to the other.

#### Keys

| Default     | Action                                                                 |
| ----------- | ---------------------------------------------------------------------- |
| `Space`     | Fill the screen; again: 100%; a third time: back to where it started   |
| `↑` / `↓`   | Zoom in / out by 15%, animated                                         |
| `Z`         | Display mode *Original*                                                |
| `X`         | Display mode *Fit to screen*                                           |
| `C`         | Display mode *Fit horizontally*                                        |
| `V`         | Keep zoom and position on navigation, on / off                         |

`Z` `X` `C` switch Stash's own display mode, as the lightbox options do: it is kept, and photos
not zoomed yet open in it. The current photo takes the new mode's size in place. `Space` and the
arrows act on the current photo only. All of them zoom about the middle of the visible part of
the photo, so it stays where it was moved. Each key
is a setting: a `KeyboardEvent.code` (`Space`, `ArrowUp`, `KeyZ`, `NumpadAdd`), a letter or
digit (`Z`, `5`), or several separated by commas; empty restores the default, `none` turns the
action off. Codes are physical keys, so they work under any keyboard layout. `←` `→` `Esc` and
`d d` stay Stash's.

#### How it hooks in

Stash's `Lightbox` and `LightboxImage` are not patchable components, so the plugin works on the
DOM: capture listeners on `window` take wheel, mouse, pointer and touch input on the lightbox
photos before React sees it, the current photo's wrapper is placed through CSS variables applied
with `!important` over React's inline transform, and navigation is handed back to Stash as
`ArrowLeft`/`ArrowRight` keydowns. Stash's own options are read from the hidden inline copy of
its options form. It depends on these class names: `Lightbox`, `Lightbox-display`,
`Lightbox-carousel`, `Lightbox-carousel-image`, `Lightbox-carousel-image-wrapper`,
`Lightbox-header-options-inline`. Preloading beyond the mounted neighbours reads the `images`
prop of Stash's Lightbox component from React's fiber; if that ever changes, only the extra
preloading stops. Stash's *Reset zoom* button no longer appears, since Stash's
own zoom stays at 1; `Z` and `X` take its place.

#### Requirements

**Stash v0.32.0 or newer.**

### inz-video-zoom — *INZ Video Zoom*

PotPlayer's mouse zoom and pan for the scene player. UI only, no backend, no settings.

| Gesture                              | Effect                                                         |
| ------------------------------------ | -------------------------------------------------------------- |
| `Ctrl` + drag right and down         | Zoom into the rectangle                                        |
| `Ctrl` + drag up or left (any part)  | Reset zoom and position                                        |
| `Alt` + drag                         | Move the video, at any zoom, off screen too                    |

- The rectangle is fitted **by its larger side**: all of it stays visible, centred. A
  rectangle drawn on a zoomed video zooms further, up to 64×. One thinner than 8 px is
  ignored. While dragging, the outline turns dashed when releasing would reset.
- `Alt` moves the video with no limits; `Ctrl` + a drag up or left brings it back.
- A drag never pauses or plays the video. A `Ctrl` / `Alt` click without movement is an
  ordinary click. Releasing `Alt` after a drag does not open the browser menu.
- The view survives fullscreen and resizing, and a stream switch within the scene (the
  source selector, transcode fallback). Another scene starts unzoomed.
- Only the picture moves: subtitles and the controls stay put, and gestures do not
  start on the control bar. Nothing happens in VR mode or while casting.

#### How it hooks in

Same approach as inz-lightbox: capture listeners on `window` take the gestures before
video.js does, and the `<video>` is placed through CSS variables on the player. The position
is a fraction of the player box, so `translate()` percentages carry it through any resize.
It depends on these class names: `VideoPlayer`, `video-js`, `vjs-tech`, `vjs-control-bar`,
`vjs-menu`, `vjs-modal-dialog`, `vjs-button`. The scene is recognised by the `/scene/<id>/`
part of the stream URL.

#### Requirements

**Stash v0.32.0 or newer.**

## Development

```
npm run build      # copy/compile each plugin into <plugin>/dist/<id>/
npm run package    # zip every dist package and write pages/index.yml
```

`npm run check:graphql` validates every query inzVrGenerate and inzRecords can send against
Stash's real schema — each plugin's oldest supported release and whatever the checkout is on —
including the variables, so a wrong field in `SceneUpdateInput` fails too. It reads the SDL out of
a Stash source checkout, `../../../libs/stash` by default (`../stash` is the CLI, not the sources):

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
