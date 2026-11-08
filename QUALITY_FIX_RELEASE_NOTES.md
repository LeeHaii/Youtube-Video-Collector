# Downloader quality fix — Windows v1.0.2

Prepared 17 October 2026 (Asia/Saigon). Implementation and local release-candidate verification are complete. Client distribution and an installed-GUI pilot have not been performed.

## Build

- [Windows installer](<E:/CodingFolder/Youtube-Video-Collector/youtube-video-collecting/out/make/squirrel.windows/x64/Rhymx's Youtube Ultimate Tool-1.0.2 Setup.exe>)
- [Packaged application folder](<E:/CodingFolder/Youtube-Video-Collector/youtube-video-collecting/out/Rhymx's Youtube Ultimate Tool-win32-x64>)
- [Executable/build manifest](E:/CodingFolder/Youtube-Video-Collector/youtube-video-collecting/dist/release-manifest.json)
- Base Git commit: `03ca156833c2ed22fdeda77f8930ad552f738d72`; changes remain in the working tree.
- Downloader source SHA-256: `8c63947e29a9a67ee0052fa8cf47c2dedf2e5e59f799ef390539cb5e8cd7ead2`.
- Downloader executable SHA-256: `368fb39d4fb6f85c2f4a9e4d4de762904532243453dd34eafc6e5773e4effc10`.
- Installer SHA-256: `9cc64013595f99647120dd2b97cc715423b18a90ed3121399c381b61ee2d8b8b`.
- Tested extraction/build pair: yt-dlp 2026.08.19, EJS 0.8.0, PyInstaller 6.22.3; Python 3.12.14 for building/tests.

The packaged executable hash matches the standalone tested executable. Python source extracted from the packaged ASAR matches the source digest. The ASAR excludes duplicate `dist`/`.runtime` executables and build intermediates. The app checks executable capabilities, manifest/hash, application version, and source digest before running a download.

## Behavior

New runs default to a 1080p minimum and maximum. Portrait 1080×1920 meets the same requirement as landscape 1920×1080. Best available removes the maximum while preserving the selected minimum.

The downloader compares eligible combined and separate renditions across configured delivery profiles. It retains the chosen tier/frame rate across refreshes, delivery switches, and repeated CSV occurrences of the video. A lower successful profile is not promoted into an acceptable source. Inaccessible quality produces an explicit failure rather than a successful low-quality output.

Every accepted output is validated, published from an attempt-specific temporary path, hashed, and accompanied by provenance. Existing positional files are reused only when input identity, range, policy, hash, and media validation match. Conflicting/legacy files are preserved by default. Replacement requires the explicit checkbox/flag and occurs after the new download validates.

Canonical YouTube video IDs are retained in clip records and retry URLs; signed media credentials remain redacted from diagnostics.

Quality, delivery, validation, and output-conflict outcomes appear in per-clip records, final counts, and retry exports. The app requires a complete consistent report with compliant per-clip evidence before displaying success. Retry CSVs carry a `.quality.json` companion containing the original policy and targets.

## Verification

| Verification | Result |
| --- | --- |
| Full repository Python suite | 64 passed, no skips |
| Full repository JavaScript suite | 70 passed, no skips; includes frozen CLI/streaming checks |
| Every CLI maximum (including explicit 144p/240p) | Processing validation passed; real low-tier overrides also passed through the frozen executable |
| Controlled HD → 403 → low-profile sequence | No silent downgrade; equivalent-quality recovery or explicit failure |
| Repeated CSV URL/policy/source cache isolation | Passed |
| Real local 1080p and portrait delivery | Passed through standalone and packaged executables |
| Real 3840×2160 at 60 fps | Retained 4K/60 fps, H.264 High/yuv420p, level 5.2, exactly five seconds through the final executable |
| Real 144p input with strict 1080p requirement | Rejected; no completed low-quality output |
| Matching reuse / changed-source collision / clean final summary | Passed through standalone and packaged executables |
| HLG/PQ sources through strict pipeline | Tone mapped and validated as 8-bit output at retained 60 fps |
| Rotated source | Display dimensions preserved and validated |
| Stop/deadline / malformed or truncated reports | Passed; no unqualified success |
| Representative live YouTube source | Packaged Big Buck Bunny `YE7VzlLtp-4`, 30–35s and 40–45s: both 1920×1080, 24 fps, H.264 High/yuv420p, five seconds; canonical video IDs retained |
| Shared-dependency trimmer smoke | Real local HD clip passed using a synthetic cookie-header fixture; its automatic Chrome-cookie path was not validated |
| Forge Windows package and Squirrel installer | Built successfully |
| Packaged binary and ASAR source identity | Verified against release manifest |
| Git whitespace/error check | Passed |

Live checks used both the implemented source pipeline and packaged executable. The standalone and packaged binaries were also exercised with real local HTTP media. Actual Electron IPC/renderer code is covered by the JavaScript harnesses. A manual installed-GUI/client pilot remains outstanding. No affected client URL was available, so this report does not claim reproduction of a particular client incident.

## First client run

1. Install/update to this v1.0.2 build so the interface and compiled downloader match.
2. Use a fresh output folder and retain the default 1080p minimum/maximum for an HD delivery requirement.
3. For genuinely lower-resolution originals, lower the minimum explicitly. The downloader will not upscale or quietly relax it.
4. If reusing an old folder, explicitly enable replacement when desired. Old files without matching provenance produce conflicts.
5. Inspect a small pilot's outputs and its `run-*.jsonl`/`run-*.quality.json` reports before expanding client distribution. Keep retry CSVs and their `.quality.json` files together.

Full FFmpeg/FFprobe and a supported JavaScript runtime remain runtime prerequisites. Extraction restrictions can still make a clip fail; the release enforces the quality contract rather than promising every source is accessible. A 1080p label alone cannot establish native detail in an already-soft source, so perceptual complaints at identical dimensions still require matched-time source comparison.

Clip operations have four application attempts, one 403 refresh per profile, and a 180-second budget. External processes are terminated on Stop/deadline; an in-flight extraction request can take up to its 10-second socket timeout to return. The previous Linux/FFmpeg 6.1.1 duration discrepancy was not reproduced or repaired on Linux; this release was verified on Windows.
