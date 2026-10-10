# 5-Sec Downloader Playback Fix Implementation Plan

## Target behavior and confirmed preference

Implementation refinement: always probe the selected stream once per session.
yt-dlp fills missing HDR metadata with inferred SDR/HDR10 labels, so those
labels cannot establish whether the transfer function is HLG or PQ. If the
CDN rejects direct ffprobe access but permits the existing FFmpeg range path,
copy a one-second sample without encoding and probe it locally. Remove the
temporary sample immediately and retain the existing delivery fallback when
both methods fail. This refinement is covered by local integration tests and
the reported 1080p source that exposed the direct-probe regression.

Produce five-second MP4 clips with H.264 High, 8-bit `yuv420p` video and AAC
audio. Convert HDR sources to SDR with correct brightness and color. Preserve
the selected source dimensions and frame rate, including **3840 x 2160 at
60 fps**, as requested by the user. Keep the existing resolution cap and
highest-available-within-the-cap behavior.

Preserving 4K60 means some Windows players can still reject the result: the
Microsoft Media Foundation decoder documents High profile support through
level 5.1, while the affected 4K60 clips use level 5.2. Do not reduce frame rate
or falsify the H.264 level to hide this limitation. Playback in every Windows
player is outside this plan's acceptance criteria.
[Microsoft decoder documentation](https://learn.microsoft.com/en-us/windows/win32/medfound/h-264-video-decoder).

## Evidence and root cause

The reported run completed all eight downloads. Its 403 and unavailable-format
messages were failed delivery attempts followed by successful fallbacks.

The three affected files under `E:\Downloads\dwadwadwdadwtr555\1\1.1.*.mp4`
contain H.264 **High 10**, `yuv420p10le`, 3840 x 2160 at 60 fps, and HLG HDR
tags (`arib-std-b67`, BT.2020). The inspected clip decodes without errors in
FFmpeg. The 1080p and 480p files contain ordinary 8-bit H.264 High video.

`build_ydl_options()` currently supplies `libx264` and `yuv420p` through
`postprocessor_args`. yt-dlp's FFmpeg range downloader performs the actual
cut and encoding before those postprocessor settings apply. With
`force_keyframes_at_cuts=True`, its automatic encoding retained a 10-bit
pixel format from the HDR source.

The installed yt-dlp 2026.07.04 code reads output arguments from
`external_downloader_args['ffmpeg_o']`, after its input and stream-map
arguments and before the output filename. Use that supported integration
point; do not modify yt-dlp itself.

## Phase 1: Put encoding settings on the actual range download

Primary file:
`E:\CodingFolder\Youtube-Video-Collector\youtube-video-collecting\tools\5_sec_downloader.py`.

1. Add a helper that builds fresh FFmpeg output arguments for each resolved
   video selection. Keep delivery profiles and output encoding policy separate.
2. Pass the arguments through `external_downloader_args={'ffmpeg_o': args}`.
   Set `libx264`, `-profile:v high`, `-pix_fmt yuv420p`, the existing `veryfast`
   preset and CRF 18, plus AAC at 192 kbps.
3. Preserve frame rate: add no FPS filter or `-r` override. Let the encoder
   select a valid level, including 5.2 for 4K60. Preserve dimensions.
4. Ensure the actual container and final filename are MP4, including when
   the selected input is WebM or separate video/audio streams. Add
   `-movflags +faststart` to the MP4 output.
5. Remove the misplaced general encoding arguments from postprocessing.
   Any necessary container finalization must remux without another lossy encode.
6. Keep the existing range start/end calculation and forced keyframe cuts.

Completion gate: a local integration test exercising yt-dlp's real range
downloader produces 8-bit H.264 High output from a 10-bit input. Verify the
constructed FFmpeg command places the encoding arguments on the output side.

## Phase 2: Convert HDR to SDR correctly

1. Determine the selected video stream's dynamic range from resolved yt-dlp
   metadata. Inspect the selected video, rather than an unrelated entry in the
   available-format list. Cover separate streams and combined streams.
2. Use HLG or PQ transfer characteristics to identify HDR. Ten-bit depth or
   BT.2020 primaries alone are insufficient: an SDR source can also use them.
3. When metadata is missing or inconsistent, probe the selected source with
   ffprobe using its required headers and a bounded timeout. Cache the result
   for that session. Preserve existing delivery fallback if the probe gets a
   network/access error, and sanitize URLs and headers in diagnostics.
4. For HDR, apply a tested filter chain that linearizes the source, tone maps
   to SDR, converts the color primaries/matrix to BT.709, then outputs limited
   range `yuv420p`. Configure HLG and PQ input handling explicitly; validate
   reference brightness and peak handling on both.
5. Set matching BT.709 SDR output tags and remove obsolete HDR mastering and
   content-light metadata. Merely changing the tags or pixel format is not
   sufficient. For SDR, retain appropriate source color handling and apply
   only the required 8-bit conversion.
6. Check the selected FFmpeg's `libx264`, `zscale`, and `tonemap` capabilities
   once per run. Cache the check. Report a clear prerequisite error rather
   than silently producing incompatible output if a required capability is absent.

FFmpeg's CPU tone mapper requires linear, floating-point input; `zscale`
provides the necessary transformations. Prototype and visually validate the
filter settings before integrating them.
[FFmpeg filter documentation](https://ffmpeg.org/ffmpeg-filters.html#tonemap).

Do not restrict source selection to SDR formats: that could select 1080p when
the available 4K source is HDR and break the user's resolution policy.

## Phase 3: Integrate safely with sessions and success reporting

1. Resolve and cache the encoding policy inside `VideoDownloadSession` after
   source selection, before downloading its first clip. Apply it to the active
   `YoutubeDL` parameters used by `process_ie_result()`.
2. Continue deep-copying cached extraction information per clip. Rebuild the
   policy for a new delivery session, since a fallback can expose a different
   resolution or HDR format. Avoid shared mutable option lists.
3. Locate ffprobe beside the selected FFmpeg, then through PATH. Check this
   prerequisite at startup and give an actionable installation message if it
   is missing. Document that the FFmpeg installation must include ffprobe.
4. Probe each finalized local output before returning `OK`. Verify MP4,
   H.264 High with `yuv420p`, AAC when source audio is available, matching
   dimensions and frame rate, and approximately five seconds of duration
   within frame/audio-packet tolerance. For converted HDR, verify BT.709 SDR
   tags and absence of stale HDR metadata. A valid level 5.2 is permitted.
5. Use typed conversion/validation failures so deterministic local encoding
   errors do not trigger three delivery retries. Preserve the existing summary
   categories, CSV exports, and exit codes. Network errors retain their current
   fallback behavior. Clean up unsuccessful output using the existing flow.
6. Keep Stop behavior, sleep intervals, cached-session reuse, naming, folder
   layout, and the existing CLI/IPC parameter order.

Local output probing adds a small verification step; the normal encoding path
still downloads and encodes only the requested range in one pass.

## Phase 4: Make the result understandable in the app

Log the selected source and intended output once per session, for example:

```text
Selected source: 3840x2160, 60 fps, HLG HDR (embedded)
Output: MP4, H.264 High, 8-bit SDR, 3840x2160, 60 fps
Compatibility note: 4K60 can require a player supporting H.264 level 5.2.
```

Keep failed-attempt logs visible so fallback behavior can be diagnosed. Emit
the existing success marker only after output validation succeeds.

Update the downloader hint in
`E:\CodingFolder\Youtube-Video-Collector\youtube-video-collecting\src\index.html`
and the README/build guide to describe 8-bit SDR output and retained frame
rate. No additional quality selector or CLI/IPC flag is needed for this fix.

## Phase 5: Test the case that failed and its regressions

Extend
`E:\CodingFolder\Youtube-Video-Collector\youtube-video-collecting\tests\test_5_sec_downloader.py`
and add local FFmpeg integration coverage. Test the real pinned yt-dlp path,
not only helpers or mocked options.

| Input/case | Required result |
| --- | --- |
| Reported 4K60 HLG clip | 3840 x 2160 at 60 fps, High/yuv420p, correct SDR colors, AAC |
| PQ HDR10 fixture | Correct SDR conversion, preserved dimensions and frame rate |
| SDR 4K60 | Preserved 60 fps, 8-bit High, no HDR tone mapping |
| SDR 1080p/480p and 10-bit SDR | No mistaken HDR conversion; correct output and duration |
| Missing or conflicting HDR metadata | Bounded probe resolves policy or reports an actionable failure |
| Separate video/audio and combined streams, including WebM input | Correct MP4 naming/container, video and audio retained |
| Select 4K for a 1080p maximum source | 1080p output, no upscale |
| Standard delivery fails, fallback succeeds | Validated output, existing retry order and summary counts |
| Several timestamps for one URL | Session/policy reused without repeated extraction or color probing |
| Missing filters, invalid output, Stop, partial failure | Clear diagnostics, cleanup, preserved cancellation/exit behavior |

Use generated fixtures for repeatable tests and the user's existing clips as
read-only visual regression inputs. Write converted test copies into the
workspace; do not overwrite the original downloads. Check skin tones, bright
highlights, shadows, and saturation as well as metadata. Fully decode the
result to check for corruption and verify audio synchronization.

Repeat a live range download of the affected HDR source: converting an already
downloaded local clip alone does not prove the yt-dlp integration is fixed.
Run the existing Python, Electron downloader, summary, and frozen streaming
regressions. Verify browser playback and test a Windows player that supports
4K60; record the player used and the known level 5.2 limitation separately.

## Phase 6: Rebuild and verify the delivered app

1. Rebuild `5_sec_downloader.exe` using the pinned dependencies and bundled
   `yt_dlp_ejs`. The reported log says EJS was not bundled; verify the actual
   executable being tested, rather than assuming source edits reached it.
2. Package the app with the rebuilt executable and updated hint/docs. Check
   the packaged executable hash against the newly built binary.
3. Repeat the HDR range test through the packaged app. Verify its startup
   version/runtime diagnostics, selected source, validated output, streaming
   logs, graceful Stop, and final summary.
4. Keep the previous build available until the packaged verification passes.

This plan changes future downloads. Repairing the already downloaded files is
a separate optional task that would create converted copies.

## Acceptance criteria

The affected HDR source downloads directly into a valid five-second MP4 with
8-bit H.264 High video, SDR color, AAC audio, and unchanged 4K60 dimensions and
frame rate. Existing lower-resolution downloads, resolution limits, fallback
delivery, Stop, and summary reporting continue to work. The packaged executable
passes the same checks as the source implementation, and the remaining Windows
level 5.2 compatibility limit is clearly communicated.

## Implementation verification (completed)

The fix is implemented in `youtube-video-collecting/tools/5_sec_downloader.py`.
It probes the selected source stream and converts HDR to tagged BT.709 SDR with
8-bit H.264 High while preserving the source dimensions and frame rate. For
sources whose signed CDN URL rejects a direct probe, it makes a temporary,
lossless one-second sample through yt-dlp's normal `process_ie_result` path,
probes that local sample, and removes the temporary files. This keeps the
existing format selection, range download, fallback, and session reuse paths.

Verification completed:

- All 65 unique Python and Node tests passed, including generated SDR, HLG, PQ,
  10-bit SDR, combined/separate audio, WebM, range, probe fallback, cleanup,
  and validation cases.
- The standalone and packaged frozen executables passed streaming, graceful
  Stop, argument, and summary checks.
- A live run through the packaged app completed 4 of 4 clips: two 4K clips,
  one 1080p clip, and one 480p clip. Probes confirmed H.264 High/yuv420p,
  BT.709 SDR tags, source dimensions and frame rates, and approximately five
  seconds duration. Full FFmpeg video/audio decoding succeeded for each file.
- The converted 4K60 sample played to completion in the in-app browser: 300
  frames rendered, with no dropped frames.
- The downloader executable inside the final app package matches the rebuilt
  standalone downloader binary by
  SHA-256: `D476BDF04189C24DCD4B90A6A180BA6307C17DF54A5B546185654AE948EE72F7`.

The desktop app UI and a native Windows player were not manually exercised.
The tested browser playback does not establish compatibility with every
Windows player; 4K60 output can still require support for H.264 level 5.2.
Existing downloads remain unchanged and need a separate conversion or
redownload to receive the fix.
