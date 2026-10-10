# 5-Sec Downloader Resolution Selection Implementation Plan

## Intended behavior

Add one resolution setting per download run. The default is **Auto (current
behavior)**, so existing downloads and command-line calls retain their behavior.
Explicit choices are 360p, 480p, 720p, 1080p, 1440p, and 2160p.

An explicit choice is a maximum source-video height, not a requirement to produce
that exact resolution. For example, a 720p choice permits a 480p source and does
not upscale it. It must never silently select a stream above the selected height.
If no qualifying stream exists across the delivery profiles, record the existing
FORMAT failure and continue processing the remaining clips.

This first implementation retains the downloader's existing height-based
semantics. A portrait source measuring 720 x 1280 exceeds a 720-pixel height cap.
Selection based on the shorter dimension, matching YouTube-style labels for
portrait videos, is a separate future change. Make the height semantics clear in
the UI hint and test portrait inputs explicitly.

## Current implementation

| Component | Current behavior | Planned change |
| --- | --- | --- |
| `tools/5_sec_downloader.py`: `DEFAULT_FORMAT` | Prefers video up to 1080 pixels high, then allows unrestricted `/best` | Preserve this exact selector for Auto; generate capped selectors for explicit choices |
| `DownloadProfile` / `DOWNLOAD_PROFILES` | Frozen profiles for standard, Safari HLS, and embedded delivery | Create local profile copies with the selected format selector |
| `build_ydl_options()` | Reads `profile.format_selector` and configures range downloading and FFmpeg | Read the selector and apply height-first sorting only for explicit choices |
| `download_clip()` | Tries up to three profiles and favors previously successful cached sessions | Accept the profiles selected for the run; preserve retry ordering |
| `VideoDownloadSession` | Caches extracted information and reuses a `YoutubeDL` instance | Construct each session with the correct selector; keep the setting fixed |
| `main()` | Reads two required and five optional positional arguments | Retain those arguments and add an optional named resolution flag |
| Electron renderer, preload, and main process | Pass paths and sleep settings to the compiled executable | Pass one additional optional resolution value |

All component paths in this table are relative to `youtube-video-collecting/`.
Electron runs `dist/5_sec_downloader.exe` in development and the bundled executable
under `process.resourcesPath` after packaging. Updating the Python source alone
will not update app behavior.

## Compatibility requirements

- Auto returns the existing profiles and preserves the exact existing selector:
  `bestvideo[height<=1080]+bestaudio/best[height<=1080]/best`.
- Explicit choices apply the same cap to every delivery profile and every
  video-bearing fallback branch. Do not append an unrestricted `/best`.
- For explicit choices, prioritize the largest available height within the cap.
  At the same height, prefer separate video plus audio; also allow a higher
  combined stream to beat a lower separate stream. Auto retains its original
  branch preference. Do not introduce fixed format IDs or source-codec restrictions.
- Preserve five-second range downloading, keyframe handling, FFmpeg arguments,
  audio selection, output naming, directory layout, and partial-file cleanup.
- Preserve sleep intervals, request throttling, error classification, retry limits,
  graceful Stop behavior, summary messages, and exit codes.
- Keep existing Python positional parameters and Electron IPC parameters in their
  current order. Add new parameters at the end with backward-compatible defaults.
- Keep CSV input and retry-export formats unchanged. Resolution is a run setting.
- Do not mutate global profiles or change the resolution of an active session.
- Ship the updated executable and UI together so a stale executable cannot
  silently ignore the new setting.

## Phase 1: Add selection policy in Python

Define the supported explicit heights in one Python constant. Add
`profiles_for_resolution(max_height: Optional[int] = None)` and import `replace`
from `dataclasses`.

The helper should validate its input, return `DOWNLOAD_PROFILES` for `None`, and
otherwise return profile copies with a generated selector:

```python
selector = (
    f"bestvideo*[height<={max_height}]+bestaudio/"
    f"best[height<={max_height}]"
)
profiles = tuple(
    replace(profile, format_selector=selector, max_height=max_height)
    for profile in DOWNLOAD_PROFILES
)
```

Preserve each profile's name and `player_clients`. Do not reassign
`DEFAULT_FORMAT` at runtime: the dataclass defaults and existing profile instances
already contain their original value.

Store the cap in an optional `DownloadProfile.max_height` field. For explicit
choices only, use `format_sort=["height", "+hasaud"]` and
`format_sort_force=True`. This makes the largest qualifying height win over
extractor quality rankings, with separate video preferred when heights match.
The `bestvideo*` branch allows an already combined stream at a higher height;
yt-dlp retains its existing audio when audio multistreams are disabled.

Keep strict comparisons without `?`. Formats whose height is unknown must not
bypass an explicit cap. Retain the existing FORMAT error path when selection is
impossible. Auto retains its existing unrestricted fallback.

Completion gate: Auto matches the existing profiles, and every explicit setting
produces capped selectors for all three profiles without modifying the globals.

## Phase 2: Integrate with downloads and cached sessions

Add a keyword-only `max_height=None` parameter after the existing parameters of
`process_clips()`. Build the profiles once for the run.

Add a keyword-only `profiles=DOWNLOAD_PROFILES` parameter after the existing
parameters of `download_clip()`. Replace its direct use of the global tuple with
the supplied tuple when applying `MAX_CLIP_ATTEMPTS` and sorting profiles by
cached-session availability.

For explicit selections, pass the run's profiles from `process_clips()` into
`download_clip()`. For Auto, preserve the existing injected
`download_clip_func` call contract so existing callback implementations do not
need to accept a new keyword merely to retain the old behavior.

Continue passing each profile into `VideoDownloadSession`. Its existing
`build_ydl_options()` call will apply the selector before `YoutubeDL` construction,
so neither function needs a separate resolution parameter.

Keep the existing cache keyed by profile name. It is recreated per URL entry and
closed afterward, and the selected height is fixed throughout a run. Capture the
setting at Start and disable editing while the run is active. If a future feature
allows resolution changes within a run, it must create fresh sessions or include
the resolution in the cache key.

Do not change the cached information or normalized `outtmpl` handling. When
available, log the selected source dimensions once per session/profile using
metadata; avoid logging signed media URLs. Keep structured summary output intact.

Completion gate: a capped download can retry through Safari HLS and embedded
delivery, and subsequent timestamps reuse the successful session with the same
cap and correct output filenames.

## Phase 3: Extend the command-line interface

Replace manual argument indexing with a testable argument parser that preserves:

1. Required `csv_path` and `output_path`.
2. Optional `clip_sleep_min`, `clip_sleep_max`, `row_sleep_min`, and
   `row_sleep_max`, in that order and with their current defaults.
3. Optional `stop_flag_path`, in its current position.
4. New `--resolution` with choices `auto`, `360`, `480`, `720`, `1080`, `1440`,
   and `2160`; default `auto`.

Normalize Auto to `max_height=None` and explicit values to integers before
calling `process_clips()`. Validate arguments before FFmpeg discovery, runtime
downloads, or other setup work. Preserve the existing file and sleep validation.

Configure argument errors to exit with `EXIT_FATAL` (1). The standard argparse
error code is 2, which this tool already uses for partial download failure.
Normal `--help` should exit successfully without initializing download services.

Both of these calls must work:

```text
5_sec_downloader.exe input.csv output 1 2 10 15 stop.flag
5_sec_downloader.exe input.csv output 1 2 10 15 stop.flag --resolution 720
```

Also support `5_sec_downloader.exe input.csv output --resolution 720` with the
existing default sleeps and no stop flag. Log the normalized choice at startup.
Do not add mandatory fields to `DOWNLOAD_SUMMARY` or alter summary prefixes.

Completion gate: old valid calls retain their parsing and defaults; new calls
select the requested cap; invalid choices fail before setup with exit code 1.

## Phase 4: Connect the Electron UI

Modify these files under `youtube-video-collecting/src/`:

| File | Change |
| --- | --- |
| `index.html` | Add a labeled dropdown near the downloader settings, with Auto selected and the six explicit choices |
| `tools-handler.js` | Read and capture the choice at Start, append it to `startDownload()`, log it, and manage the dropdown's enabled state |
| `preload.js` | Append an optional `resolution = 'auto'` parameter to the bridge method and IPC invocation |
| `index.js` | Append the optional IPC parameter, validate it, and pass it to the executable as a named flag |

Use the label **Maximum video height** and a short hint explaining that lower
quality may be selected and portrait videos are also limited by pixel height.
Keep the initial dropdown value Auto. Persistence of this setting is outside this
change, avoiding an unexpected change to the default between launches.

Validate the resolution independently in the Electron main process, using the
same allowed values as Python. Treat an omitted value as Auto; reject unsupported
values before starting the child process.

Keep the existing executable argument order and append
`['--resolution', resolution]` after the stop-flag argument. Convert arguments to
strings as needed and retain `spawn(..., { shell: false })` so paths containing
spaces continue to work.

Disable the dropdown while running or stopping. Restore it on normal completion,
partial failure, fatal failure, cancellation, a failed start response, and an IPC
rejection, using the existing downloader lifecycle handlers.

Completion gate: the value selected in the UI reaches the executable unchanged,
old bridge callers still default to Auto, and Stop and subsequent runs work.

## Phase 5: Verify and package

Extend `tests/test_5_sec_downloader.py` and add focused JavaScript coverage for the
new IPC validation and argument construction. Prefer extracting a small pure
helper if necessary to test those behaviors without launching the whole app.

| Case | Expected result |
| --- | --- |
| Auto / omitted resolution | Exact legacy selector, defaults, and callback behavior |
| Every supported height | All delivery profiles contain the requested cap |
| 720 choice with 1080, 720, and 480 sources | Qualifying stream selected; 1080 excluded |
| 720 choice with only a 480 source and audio | Successful lower-resolution selection; no upscaling |
| Combined video/audio stream only | Combined fallback works and obeys the cap |
| Above-cap or unknown-height sources only | No unrestricted escape; existing FORMAT handling |
| Standard delivery returns 403 | Safari HLS and embedded retries retain the cap |
| Multiple timestamps for one URL | Metadata/session reuse and stable filenames |
| Old CLI calls and paths with spaces | Existing argument meaning and output locations |
| Invalid resolution | Fatal argument error before setup; exit code 1 |
| Graceful Stop | Existing cancellation behavior and exit code 3 |
| Portrait source | Selection follows documented pixel-height semantics |
| Auto after an explicit-resolution run | Fresh sessions; original default behavior restored |

For format-selection tests, use synthetic metadata with the pinned real yt-dlp
library, without network requests. Existing orchestration stubs alone cannot
verify how yt-dlp interprets a format selector. Continue running the current
orchestration, output-template, and summary-parser tests.

Rebuild `5_sec_downloader.exe` using the pinned requirements and the PyInstaller
options in `build-executables.js`, including `--clean` and
`--collect-all yt_dlp_ejs`. The existing `npm run build-exe` workflow rebuilds all
listed tools; an isolated downloader build should use the same relevant options.

Smoke-test the rebuilt executable and app with a small CSV containing several
timestamps for a controllable public video. Test Auto, 720, and a higher available
resolution. Inspect output dimensions, audio, and approximately five-second clip
duration with FFprobe. Test graceful Stop using the existing frozen-streaming
test, then verify a packaged app uses the rebuilt executable. Keep live tests
small to preserve the current throttling behavior.

Completion gate: automated tests pass, live output matches the selected policy,
and both development and packaged apps use the updated executable.

## Release acceptance and recovery

- Default users and old valid CLI callers retain the current behavior.
- Explicit selections remain bounded through every delivery-profile retry.
- Existing summaries, failure exports, cancellation, and numbering still work.
- The UI and executable ship in the same release.
- Selecting Auto restores the legacy format policy without changing CSV files.
- If release rollback is necessary, restore the previous UI and executable
  together. No data migration is required.

## Baseline and references

Implementation completed on 2026-10-04:

- Added the dropdown, Electron argument validation and forwarding, Python CLI
  support, immutable run profiles, strict height caps, and height-first selection.
- Passed 24 Python tests using the pinned real yt-dlp library, eight downloader
  JavaScript tests, and three frozen-executable tests. Another 13 collector
  renderer/session regression tests passed.
- Rebuilt `youtube-video-collecting/dist/5_sec_downloader.exe` and packaged the
  matching app under `youtube-video-collecting/out/resolution-selection/`.
  Packaged source files match the workspace, and the bundled downloader's SHA-256
  matches the rebuilt executable. The packaged downloader passes the same three
  frozen-executable checks.
- Downloaded two 720p clips, one 4K clip, and one Auto clip from a public test
  video. FFprobe confirmed 1280 x 720, 3840 x 2160, and 1920 x 1080 respectively,
  each with H.264 video, AAC audio, and a five-second duration. The existing
  embedded profile recovered from direct 403 errors; the second 720p timestamp
  reused that successful session.
- Verified 4K selection with a 1080p-only source using synthetic metadata through
  the real yt-dlp selector. Manual interaction with the packaged GUI was not
  performed; renderer and IPC behavior were verified through automated tests.

At planning time, seven Python downloader orchestration tests and two JavaScript
summary-parser tests passed.

The dependency file pins `yt-dlp[default]==2026.7.4`. Selector semantics, fallback
ordering, and unknown-height behavior are documented in that release's
[format-selection documentation](https://github.com/yt-dlp/yt-dlp/tree/2026.07.04#format-selection).
