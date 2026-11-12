# inzVrGenerate — code review

Revision: `097e6f5` (2026-08-16), the plugin tree with no uncommitted changes.
Review date: 2026-08-16.

> **Fix iteration 1 — 2026-08-16.** #1, 2, 3 and 5 are closed; #6 did not hold up on
> inspection. The line numbers in the links below have been updated for the edits.
> Next up are #12 (tests + CI) and #9-10 (an `auto` default / a geometry check).

Scope: [src/vrtask.py](src/vrtask.py), [src/vrgen.py](src/vrgen.py),
[src/vrformat.py](src/vrformat.py), [src/vrstash.py](src/vrstash.py), [src/vrlog.py](src/vrlog.py),
[src/index.tsx](src/index.tsx), [src/inzVrGenerate.yml](src/inzVrGenerate.yml),
[src/manifest](src/manifest), the build and packaging in [../package.json](../package.json) /
[../scripts/](../scripts/), and CI in [../.github/workflows/pages.yml](../.github/workflows/pages.yml).
`dist/` was checked against `src/` — they are in sync.

Overall impression: the engineering is strong, nearly every decision is explained by a
comment referencing the internals of Stash, and the reference document
[../tasks/00-reference.md](../tasks/00-reference.md) is of a standard rarely met. There
is one weak spot, and it is systemic: **everything rests on comments rather than on
checks**. The subtle invariants ("an eye is always wider than it is tall", "a format
applies to VR only", "`args_map` beats `defaultArgs`", "the format tables in Python and
TSX agree") are recorded in prose alone.

---

## Summary

| # | Finding | Where | Class | Status |
|---|---------|-------|-------|--------|
| 1 | `ffprobe` runs before the "is there anything to do" check | `vrtask.py` | blocking | fixed |
| 2 | Encoding has no timeout at all (`timeout` is a dead knob) | `vrgen.py` | blocking | fixed |
| 3 | Cancelling a task leaves orphaned `ffmpeg` processes | `vrgen.py` | blocking | fixed |
| 4 | `Stash` is not thread-safe yet is used from the workers | `vrstash.py` | blocking | open |
| 5 | The stderr encoding kills the whole run on Windows | `vrlog.py` | blocking | fixed |
| 6 | `exec: python3` does not start on a Windows Stash install | `inzVrGenerate.yml` | blocking | not confirmed |
| 7 | The sprite spills to disk far too late | `vrgen.py` | major | open |
| 8 | The cover is always rebuilt, and `sceneUpdate` shakes the whole scene | `vrtask.py`, `vrstash.py` | major | open |
| 9 | A dangerous default: `format: "sbs"` plus Generate over the whole library | `index.tsx` | major | open |
| 10 | False positives on short tokens (`LR`, `TB`, `OU`, `MONO`) | `vrformat.py` | major | open |
| 11 | The format table is duplicated three times | `vrformat.py`, `.tsx`, README | major | open |
| 12 | There is not a single test, and CI does not run them | the repository | process | partly |
| 13 | Progress bypasses its own rate limit | `vrlog.py` | process | open |
| 14 | The whole library is materialised before the first ffmpeg starts | `vrtask.py`, `vrstash.py` | process | open |
| 15 | Small things (17 items) | everywhere | minor | partly (1/17) |

### Order of work

| # | What | Why first | Status |
|---|------|-----------|--------|
| 1 | Timeouts (#2) + PDEATHSIG (#3) | Without them a stuck file or a cancelled task breaks the system, not just the run | done |
| 2 | UTF-8 on stderr (#5) | A one-line fix that currently aborts an entire run | done |
| 3 | `_outstanding` before `probe` (#1) | A one-line fix worth hours on repeat runs | done |
| 4 | Tests of the pure functions + CI (#12) | They have already found a real `maximum_sprites` bug; without them any refactoring is blind | partly |
| 5 | An `auto` default / a geometry check (#9-10) | The only place where the plugin can quietly ruin someone else's data | |

The first iteration's checks were run by hand (there are still no tests — that is #12):
all four artifacts were built by real ffmpeg from a synthetic SBS file, both halves of
#3 were verified end to end — `python:3-alpine` in docker for PDEATHSIG and this
Windows machine for the job object — and #1 and #5 were confirmed with scenarios that
failed before the fixes.

---

## Blocking

### 1. `ffprobe` runs before the "is there anything to do" check

**Status: fixed (2026-08-16).** `todo = _outstanding(...)` now sits at
[vrtask.py:233](src/vrtask.py#L233) and `probe()` at
[line 239](src/vrtask.py#L239), after the early exit. The order is explained by a
comment in place. `fmt` deliberately stays above both: otherwise a 2D file would get
"up to date" instead of a clear "nothing in the filename says which VR format this is".
Verified with a scenario where `vrgen.probe` is replaced by a throwing function: a scene
with ready artifacts goes to `skipped` without calling probe once, while a scene with a
missing preview does call it.

The caveat still stands: with covers on, `todo` is never empty
([lines 282-283](src/vrtask.py#L282-L283)), so the gain goes to "previews +
sprites" runs — the typical case and the UI default. See #8: a cover journal will remove
that too.

---

The original finding: `probe()` was called before `_outstanding()`, which is cheap
(`os.path.isfile`). A repeat run over a 30k-scene library where everything is already
generated means 30k `ffprobe` processes for zero work. At `parallel_tasks=3` that is
hours.

### 2. Encoding has no timeout at all

**Status: fixed (2026-08-16).** The `"timeout": None` knob was removed and replaced by a
budget at each of the six launch sites ([vrgen.py:31-48](src/vrgen.py#L31-L48)).
`timeout` became a **mandatory** second parameter of [`run`](src/vrgen.py#L292), so that
a forgotten call site cannot compile into an unprotected one.

Two deliberate differences from the solution proposed here:

- **The budgets are not tied to the file duration — with one exception.** A preview
  chunk's work is bounded by `-t` rather than by the source length (the fallback decodes
  no more than `SLOW_SEEK_MIN`), and the cover and webp are a single frame and a ready
  preview file. So those are fixed (300-600 s), and only the chunk budget grows, and
  only if someone sets a very long `previewSegmentDuration`. A proportional budget fits
  exactly where ffmpeg really decodes up to a timestamp — the sprite cell retry:
  `min(600, max(120, timestamp * 0.5))` ([vrgen.py:807-812](src/vrgen.py#L807-L812)).
- **A cell gets 120 s for a fast seek, not "10-30 s".** A smaller budget would cut off
  the slow seek for almost every frame and ruin the sprites of dubious but working
  files. On a timeout the cell is still skipped — the `None` mechanism was not changed.

[`FfmpegTimeout(FfmpegError)`](src/vrgen.py#L97) was added: on it `generate_preview` does
**not** go for a second attempt, because a slow seek decodes strictly more than the first
attempt that already ran out of time. An ordinary error is retried as before — both
behaviours verified.

---

The original finding: `"timeout": None` was never changed anywhere — a dead knob.
`PROBE_TIMEOUT=120` protected `ffprobe` only, while every `run(..., timeout=options["timeout"])`
went out unbounded. The worst case was the second attempt in
[`_capture_cell`](src/vrgen.py#L794): `-ss` after `-i` decodes the file from zero to the
timestamp — for the 81st cell of a two-hour 8K file that is literally hours on one cell.
One broken file hung a worker forever, and the comment at
[vrgen.py:26-29](src/vrgen.py#L26-L29) about "one of these must not hold up the run"
applied to probe only.

### 3. Cancelling a task leaves orphaned `ffmpeg` processes

**Status: fixed (2026-08-16), both platforms.** The Windows half was not done "for the
future": #6 did not hold up, Windows installs do work, so the orphans there are real.

- **Linux:** [`_preexec()`](src/vrgen.py#L139) returns a `preexec_fn` that sets
  `prctl(PR_SET_PDEATHSIG, SIGKILL)` and, if the parent managed to die during the fork,
  calls `os._exit(1)` itself. It is wired into both launch sites —
  [`run`](src/vrgen.py#L292) and [`probe`](src/vrgen.py#L326). `ctypes.CDLL(None)` rather
  than `"libc.so.6"`: the target platform is alpine, where libc is called
  `libc.musl-$arch.so.1`. The parent pid is read **at launch time** rather than once at
  import — otherwise it belongs to whoever imported the module.
- **Windows:** [`guard_child_processes()`](src/vrgen.py#L202) — one job object with
  `KILL_ON_JOB_CLOSE`, which the process adds itself to at the start of `main()`.
  Children inherit membership automatically, so `run`/`probe` know nothing about it;
  `TerminateProcess` from Stash closes our handle and the job takes the whole tree with
  it. Nested jobs have worked since Windows 8, so a job on Stash itself is no obstacle.
  A failure is a debug line, not a refused run.

Verified end to end on both sides: `python:3-alpine` in docker and this Windows machine.
In both cases a control run without the guard leaves a live child after the parent is
killed, and with the guard the child disappears.

---

The original finding: Stash kills a plugin with `SIGKILL` (`raw.go`,
`t.cmd.Process.Kill()` — on Windows that is `TerminateProcess`, and there is no signal
handler on either platform). Python died while up to `parallel_tasks` `ffmpeg` processes
kept burning CPU, writing temporary files and holding the disk — and together with #2
they could stay for a long time.

### 4. `Stash` is not thread-safe yet is used from the workers

[vrstash.py:80-109](src/vrstash.py#L80-L109) mutates `self._endpoints` and
`self.endpoint`, while [`set_cover`](src/vrstash.py#L236) is called from the pool. If two
threads get a `URLError` at the same time, both do a `pop(0)` — and `self._endpoints[0]`
raises `IndexError` instead of a clear `cannot reach stash`. On top of that
`self._endpoints = [self.endpoint]` is written on every successful call.

Separately: `urllib` does not reuse the connection — a new TCP connection per cover.

**Solution.** Fix the endpoint once (the candidates are walked before the pool starts
anyway, in `get_config`) and make the object read-only afterwards; or put a lock around
the whole selection section. For connections — an `http.client.HTTPConnection` in
`threading.local()`.

### 5. The stderr encoding kills the whole run on Windows

**Status: fixed (2026-08-16).** [`vrlog.setup()`](src/vrlog.py#L23) switches stderr to
`utf-8` / `errors="replace"` (inside a `try/except`, because `reconfigure` appeared in
3.7 and the stream may be replaced) and is called as the first line of `main()`. The
safety net is [`_write()`](src/vrlog.py#L39): it catches `UnicodeEncodeError` and repeats
the line put through the stream encoding with `replace`, and swallows any other
exception.

A separate `try/except` around the error handler in `process_scene` was **not** added,
and that is not an oversight: it used to fail because the logger threw again, and now the
logger does not throw at all — the invariant is written into the module docstring.
Treating the symptom on top of the cause would only hide the next such case.

Verified under `PYTHONIOENCODING=cp1251`: Cyrillic, CJK and emoji reach stderr as UTF-8
with intact level prefixes; the `_write` fallback was checked separately on a stream that
does not support `reconfigure`.

---

The original finding: `print(..., file=sys.stderr)` without an explicit encoding. Under
cp1251/cp866 a path with Cyrillic characters raised `UnicodeEncodeError` inside a worker.
Then the chain in [`process_scene`](src/vrtask.py#L255-L258): the exception is
caught, the handler calls `vrlog.error(...)` with the same `label` — and fails again,
outwards this time. `pool.map` raised it on iteration and **aborted the whole run**.

### 6. `exec: python3` does not start on a Windows Stash install

**Status: not confirmed (2026-08-16).** The finding is wrong: `python3` in `exec` is not
a file name Stash hands to the OS but a marker telling it to resolve the binary itself.

For `exec[0] == "python3"`, `raw.go` calls `python.Resolve(config.GetPythonPath())`
(`pkg/plugin/raw.go`), which tries the configured "Python executable path", then
`LookPath("python3")`, then `LookPath("python")` (`pkg/python/exec.go`). On top of that
`getExecCommand` (`pkg/plugin/config.go`) deliberately does not prepend the plugin path
for python commands. The code has been there since v0.14.0; checked on tag `v0.31.1`, the
minimum supported version. So on Windows with a python.org build the plugin starts, and
Python not being on `PATH` is fixed by the setting in Settings -> System.
[inzVrGenerate.yml:6-8](src/inzVrGenerate.yml#L6-L8) stays as it is: `python` and
`python3` are equivalent to `IsPythonCommand`.

Because of this, Windows stopped being an unsupported platform, which directly affected
#3 (the Windows half was implemented) and confirmed the importance of #5.

Done along the way, in the spirit of "every resolution should happen by itself":

- **`~/.stash` was added to [`resolve_binaries`](src/vrgen.py#L250).** `RefreshFFMpeg`
  (`internal/manager/init.go`) looks for ffmpeg like this: the configured path, then the
  `config.yml` directory, then `PATH`, then `~/.stash`, where the copy it downloaded
  itself ends up. The plugin repeated the first three steps (and `server_connection.Dir`
  is exactly `config.GetConfigPathAbs()`, `pkg/plugin/plugins.go`) but not the last one.
  Now the order matches completely, and the plugin encodes with the same binary the rest
  of the library was generated by.
- **[manifest:8](src/manifest#L8)** was filled in with the published index URL. The field
  is inert: `scripts/package.mjs` does not carry it into `pages/index.yml`, and on
  installation Stash writes its own manifest (`pkg/pkg/manager.go`) with the address of
  the source the package came from. The value is purely documentary. `inzDateSelect` has
  it empty too — a separate minor item for later.
- **README**: the Requirements section no longer describes Docker alone — it says that
  Stash itself finds Python (and ffmpeg), and that Windows works.

---

## Major

### 7. The sprite spills to disk far too late

In [`generate_sprite`](src/vrgen.py#L723-L792) the entire `frames` list is already
collected in memory **and only then** is `count * frame_bytes > MAX_SPRITE_MEMORY`
checked ([vrgen.py:765](src/vrgen.py#L765)). The spill saves only the copy made by
`b"".join(frames)`, not the frames themselves — the comment "spill them to disk instead"
does not describe what the code does. At `maximumSprites=500` and
`spriteScreenshotSize=480` that is about 205 MB per worker, times `parallel_tasks`.

**Solution.** `count` and `frame_bytes` are known before the loop — decide about the
spill in advance and write each frame to a file right after capture.

### 8. The cover is always rebuilt, and `sceneUpdate` shakes the whole scene

The "covers are always in `todo`" decision is documented and justified
([vrtask.py:267-289](src/vrtask.py#L267-L289)), but it has an invisible
price: [`set_cover`](src/vrstash.py#L236) goes through `sceneUpdate`, which updates
`updated_at` and fires the `Scene.Update.Post` hooks of other plugins. A repeat run over
the library with covers=on reshuffles the "recently updated" sort order and pokes other
people's integrations on every scene.

**Solution.** A journal of our own — json in `<generated>/tmp/inzvrgen-covers.json` or a
key in the ui-config: `scene id -> the digest the cover was built for by this plugin`.
Skip without `overwrite`. That closes "we always rebuild", the extra `sceneUpdate` calls,
and removes the caveat from #1.

### 9. A dangerous default: `format: "sbs"` plus Generate over the whole library

[`defaultOptions()`](src/index.tsx#L135-L144) returns `format: "sbs"`, while
[`VrTaskButtons`](src/index.tsx#L987) does `queue(options, {})` — the whole
library, without confirmation. An explicit format is applied to every scene, 2D
included. The arithmetic checks out:

```
Geometry(sbs, 1920x1080) -> eye 960x1080 -> crop 960x540
```

One click and the previews/sprites of 2D scenes are built from the left half of the
frame. With `overwrite` that overwrites existing ones.

**Solutions, in ascending cost:**

- an `auto` default. The README explains why `sbs` was chosen ("otherwise a silent
  no-op") — but that is better solved with a hint in the UI than with a default;
- a confirmation when the format is not `auto` and the target is the whole library or a
  folder;
- a server-side sanity check: compare the source aspect ratio with the declared format
  (SBS-180 expects about 2:1, SBS-360 about 4:1; a 16:9 source declared as SBS is almost
  certainly 2D) — warn and skip unless there is an explicit "force".

### 10. False positives on short tokens

[FORMATS](src/vrformat.py#L35-L52) contains `LR`, `TB`, `OU`, `3DH`, `3DV`, `MONO` and
`SBS`. `_normalise` matches them as whole words between separators — but such words
exist: the French `..._ou_...`, `..._MONO_...` meaning mono audio, the initials `_LR_`.
The result is a 2D scene silently cut in half, exactly the damage of #9.

**Solution.** The same geometry check as in #9: for "weak" tokens require confirmation
from the frame shape, for "strong" ones (`MKX200`, `360X180_3DH`) take them at their
word.

### 11. The format table is duplicated three times

[vrformat.py:35-52](src/vrformat.py#L35-L52),
[index.tsx:92-102](src/index.tsx#L92-L102) and the table in the
[README](../README.md#L120-L129). As of this review all eight rows agree — checked by
hand — but that is held together by attention alone.

**Solution.** One JSON as the source, generating the TS table at build time (a step next
to `cpx`), or a conformance check in the spirit of the existing `check:graphql`.

---

## Process

### 12. There is not a single test, and CI does not run them

[pages.yml](../.github/workflows/pages.yml) does `build` -> `package` -> publish.
`npm run check:graphql` is never called (and without a Stash checkout it is silently
skipped). There are no tests.

Meanwhile all the "hard" code is pure functions with no I/O: `Geometry`, `sprite_grid`,
`preview_segments`, `vtt_time`, `from_filename`, `is_under`, `_flag` / `_number` /
`_string_list`, `applyEntries`. That is exactly where the arithmetic lives that cannot be
checked by hand. An example found within a minute in the interpreter:

```
sprite_grid(7200.0, {custom_interval: True, minimum_sprites: 10,
                     maximum_sprites: 500, interval: 1})  ->  (529, 23)
```

The rounding up to a full square in [vrgen.py:708](src/vrgen.py#L708) is applied *after*
the bound, so the "maximum 500" setting is violated by 29 cells.

**Solution.** `python -m unittest discover` on stdlib (no dependencies — there is no pip
in the image, but the tests are not run in the image either) plus a separate workflow on
PRs that calls the tests, `tsc --noEmit` and `check:graphql` with a Stash checkout.

> **Partly done.** [test/test_pure.py](test/test_pure.py) covers `from_filename`, `Geometry`,
> `preview_segments`, `sprite_grid` (current behaviour, the bound above included), `vtt_time`
> and `is_under`; `npm test` runs it and the Pages workflow runs `npm run check` and `npm test`
> before building. Still open: the argument parsers, `applyEntries`, and `check:graphql` in CI,
> which needs a Stash checkout.

### 13. Progress bypasses its own rate limit

[vrlog.py:166](src/vrlog.py#L166) — `done()` always sends `force=True`, so the "no more
than once a second" limit is disabled in precisely the hottest place. Plus
[`vrlog.debug("%s: up to date")`](src/vrtask.py#L236) on every skipped scene. A
run over 30k scenes where almost everything is skipped means 60k lines with `flush=True`
under a shared lock — while the module docstring itself warns that "a stream of such
messages slows the plugin down more than the work does".

**Solution.** `force=True` only on the last scene (or once every N), and aggregate "up to
date" into a single summary line.

### 14. The whole library is materialised before the first ffmpeg starts

[`collect_scenes`](src/vrtask.py#L357) does `list(iter_scenes(stash))` at
`per_page=100` ([vrstash.py:208](src/vrstash.py#L208)) — 500 round trips for 50k scenes
before any work begins. [`pool.map`](src/vrtask.py#L424) immediately creates
futures for every scene.

**Solution.** Streaming processing (generator -> queue -> workers), `per_page` raised to
500-1000, and the progress total taken from `findScenes(...).count`. For `auto` — narrow
the selection on the server through `path` + `MATCHES_REGEX` with the token list; the
modifier is worth running through `check:graphql` first.

Alongside: [`is_under`](src/vrtask.py#L352) recomputes `os.path.realpath(folder)`
for every scene — resolve the folder once in `collect_scenes`.

---

## 15. Small things, still worth fixing

### Python

- [vrgen.py:728](src/vrgen.py#L728) — `if geometry.height > geometry.width` is
  unreachable: `Geometry` always yields 16:9. A dead branch.
- [`generate_cover`](src/vrgen.py#L491-L504) ignores `transcodeInputArgs` /
  `transcodeOutputArgs` (preview and webp apply them) and has no slow-seek fallback,
  although `_capture_cell` does. Two inconsistencies in one place.
- [`probe`](src/vrgen.py#L326) validates `width` / `height` but not `duration <= 0` —
  which is a guaranteed preview failure (`-t 0.000`, and then a retry on top) and a
  degenerate vtt. Better a `Skip` with clear text.
- [`Context.tally`](src/vrtask.py#L170-L175) is overloaded: an unknown key
  silently starts a new artifact counter, so a typo never surfaces.
- [`_exclude_value`](src/vrgen.py#L511-L519) swallows `ValueError` -> 0.0 without a word;
  [`workers`](src/vrtask.py#L421) is silently capped at 16.
- [`iter_scenes`](src/vrstash.py#L223) quotes the path as `'"%s"'` — a path with a `"`
  (possible on Linux) breaks the filter.
- [`CERT_NONE`](src/vrstash.py#L69-L71) is applied to the configured host as well, not
  only to loopback. The self-signed-certificate justification holds for loopback; for the
  rest it should at least be logged.
- Two scenes with the same hash are processed twice and write the same target
  (`os.replace` saves it from corruption, but the work is duplicated).
- The `defaultArgs` in [yml](src/inzVrGenerate.yml#L22-L27) set every artifact to
  `"true"`. An unchecked box is protected only by the merge order of `args_map` over
  `defaultArgs` inside Stash — an undocumented detail of someone else's implementation.
  Worth at least an explicit test for "every box unchecked but one".

### TSX

- [The `useMemo` in `SceneListOperations`](src/index.tsx#L789-L804) depends on
  `element`, whose identity is new on every render — the memoisation does not work.
- There is no guard against registering the patches twice: if the script runs twice, the
  menu item is duplicated. Cheaply fixed with a flag on `window`.
- ["Our job"](src/index.tsx#L1076-L1077) is identified by the substring
  `"Generate as VR"` in `description`. False positives, plus a complete loss of
  indication if `RUN_PLUGIN_TASK` did not build — the `description` is then not sent at
  all.
- [`edited`](src/index.tsx#L165) is module-level: once the options are changed,
  the tab ignores the server value forever, and changes from another tab are not picked
  up.
- The readout-to-wording coupling in [`_ARTIFACT_TEXT`](src/vrlog.py#L96-L101) through
  the [`RUN_LINE`](src/index.tsx#L1031-L1032) regex is documented but fragile.
  More robust: a machine-readable marker in the line
  (`[vrgen] {"a":"sprite","p":"..."}`) plus human-readable text beside it.
- ~~Hardcoded English strings ("VR format", "Currently generating", subHeading) mixed in
  with `intl.formatMessage`.~~ **Fixed (2026-08-16)** — see below.

### Fixed in section 15

**UI strings (2026-08-16).** All the text the plugin wrote itself was gathered into one
table, [`TEXT`](src/index.tsx#L103), with ids in the `inzVrGenerate.` namespace —
the dialog title and both menu items, "VR format" with its caption, nine format names and
nine token hints, "Currently generating", "Not generated by this plugin yet." and the
subHeading of the block in Settings -> Tasks. It is read through
[`useText()`](src/index.tsx#L135), which looks in the Stash catalogue first and
only then takes the default from the table.

Three decisions worth remembering:

- **Not `defaultMessage`.** `formatMessage` on an unknown id renders the id itself and
  writes a missing-translation warning to the console on every render. So the check goes
  through `intl.messages[id]`, and the `Intl.useIntl` type in
  [IPluginApi](src/index.tsx#L48-L58) gained a `messages` field. If the field is
  absent altogether (a different react-intl version), `?.` falls through to the default,
  that is to today's behaviour.
- **The language stayed single.** The "English only" rule from
  [../tasks/README.md](../tasks/README.md) still holds; the table is a set of defaults.
  But the ids are real now, and `custom-locales.json` (Settings -> System -> Custom
  locales) overrides any string just as it overrides Stash's own, because Stash flattens
  it into the same dotted keys. Recorded in the README.
- **The job description is deliberately untranslated.**
  [`describeRun`](src/index.tsx#L272) builds it from the new
  [`JOB_MARKER`](src/index.tsx#L159) — the default rather than the displayed
  title: `useVrJobRunning` recognises its own jobs by that string from another tab and
  after a reload, so it is an exchange format rather than interface text. Otherwise
  translating the title would silently kill the readout.

Along the way `FORMATS` [collapsed](src/index.tsx#L173) to `value` plus two ids,
so checking it against `vrformat.py` (#11) now means checking the list of values alone.
`label`/`tokens` are typed as `TextId`, so a typo in an id does not compile. `tsc` is
clean, `dist/` rebuilt.

---

## What was checked and found sound

So that it need not be rechecked on the next pass:

- `dist/` matches `src/` byte for byte across every copied file; the `.js` is newer than
  the `.tsx`.
- `creationflags=_CREATE_NO_WINDOW` is correct on POSIX: `subprocess` only complains
  about a non-zero value, and [vrgen.py:81](src/vrgen.py#L81) gives 0 outside Windows.
  Symmetrically after iteration 1: `preexec_fn=_preexec()` gives `None` outside Linux,
  where `subprocess` would not have accepted it anyway.
- ffmpeg never writes into our stdout (`DEVNULL` unless `capture_stdout`) — the plugin's
  JSON response cannot be spoilt.
- Not a single call goes through a shell; every argument list is a list.
- `Geometry` yields even dimensions on every combination checked, odd inputs and
  `tb 3840x3840` -> `3414x1920` included.
- Atomic writing: every writer is wrapped in `try / discard(tmp) / raise`, and an empty
  file is caught in `replace_atomically`.
- The format tables in Python, TSX and the README agree at this revision (the risk is in
  the future, see #11).
- `safely()` is used before its declaration, but it is a function declaration — hoisting
  works.
- The codebase requires nothing newer than Python 3.3 (`%` formatting throughout, no
  f-strings) — deliberate and consistently held. A caveat after iteration 1:
  `sys.stderr.reconfigure` (3.7) is called inside a `try/except` only, so an older
  interpreter loses the convenience but keeps working.
- Resolving Python and ffmpeg is left entirely to Stash and matches its own search order
  — see the analysis in #6.
