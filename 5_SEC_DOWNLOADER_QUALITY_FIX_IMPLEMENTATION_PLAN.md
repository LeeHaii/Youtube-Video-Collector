# 5-Sec Downloader Quality Fix: Implementation Plan

Prepared: 17 October 2026 (Asia/Saigon).

Status: implemented in the working tree; Windows release candidate built and verified. Client rollout and installed-GUI pilot remain pending.

Baseline: `03ca156833c2ed22fdeda77f8930ad552f738d72`.

## Approach

Resolve and rank the available source renditions before downloading clips, enforce an explicit quality requirement, and preserve the selected quality through refreshes and delivery fallbacks. Validate every completed output against that requirement and its input identity before reporting success. Release the Python downloader, Electron interface, and packaged executable together, with enough local evidence to explain every delivered clip.

The release must prevent this sequence from being reported as fully successful: an HD clip downloads, its delivery profile fails, a lower-quality profile succeeds, and the remaining clips silently use that lower quality.

This plan supersedes the quality-related behavior in the existing [resolution plan](E:/CodingFolder/Youtube-Video-Collector/5_SEC_DOWNLOADER_RESOLUTION_PLAN.md), especially preservation of legacy Auto selection, literal-height portrait tiers, and preference for cached fallback profiles. Retain the encoding, HDR handling, exact-cut, and frame-rate requirements from the [playback plan](E:/CodingFolder/Youtube-Video-Collector/5_SEC_DOWNLOADER_PLAYBACK_FIX_PLAN.md).

## Scope

- In: 5-Sec Downloader source selection, minimum/maximum quality, portrait tiers, metadata refresh, retries, caching, output identity, structured results, retry exports, dependencies, Windows packaging, and release verification.
- Out: changes to collection/marking behavior, CSV syntax, CapCut editing/export, upscaling, a new codec for delivered clips, and a promise to measure perceptual quality from resolution alone.
- Preserve positional clip filenames and row directories, five-second ranges, source dimensions/frame rate, MP4/H.264 High/yuv420p/AAC output, and HDR-to-SDR conversion.
- Retain the current encoding preset and CRF for the first quality release. Change encoding only if matched-source evidence identifies a separate defect.
- The shared dependency update also requires a YouTube Trimmer smoke test. Do not expand this work into a trimmer redesign.

## Evidence and current verification

The [quality audit](E:/Downloads/5-second-downloader-quality-audit.md) identifies credible defects but does not prove the cause of each client's incident. Its live-incident gap remains: affected URL/timestamps, original good/bad clips, logs, and deployed binary identity.

Confirmed against the baseline source:

- Explicit resolution filters are upper bounds; neither selection nor output validation enforces a requested minimum.
- Auto uses ordered separate-video/combined-video alternatives and can prefer a lower separate stream.
- `download_clip()` accepts the first successful profile and promotes cached sessions before other profiles.
- Failed sessions are removed; subsequent clips can remain on the successful lower fallback.
- Sessions reset for each CSV URL/timestamp pair, including another occurrence of the same URL.
- Output names encode positions rather than input identity; existing outputs have no provenance check.
- `EncodingError` ends profile retries. A new quality rejection must not accidentally use this terminal path.
- Electron runs a PyInstaller executable, so editing Python alone cannot fix the deployed application.

Fresh Windows baseline verification during plan preparation:

| Check | Result | Limit |
| --- | --- | --- |
| Existing downloader Python suite | 41/41 passed | Used bundled Python 3.12.14, repository-local yt-dlp 2026.07.04, and installed Windows FFmpeg/FFprobe; includes local HTTP media tests, not live YouTube |
| Downloader options/summary JavaScript tests | 8/8 passed | Local integration/unit tests, not packaged Electron UI |
| Controlled actual retry orchestration | Standard at 0s; standard fails at 10s; Safari succeeds at 10s and is first at 20s | Controlled session failures, not a YouTube download |
| Controlled output-validator check | Mocked valid 256x144 output passed | Confirms validator contract, not a new real-media experiment |
| Deployed client executable | Not verified | Client build/hash and packaged smoke run remain required |

The audit reported a combined-WebM duration failure on Linux/FFmpeg 6.1.1. That test passed on the current Windows baseline. Treat this as an environment-specific regression to investigate and record, not as either a universally failing test or a reason to weaken duration validation.

## Ordered implementation checklist

- [ ] 1. Capture one affected client case and preserve the baseline reproduction evidence.
- [x] 2. Define and implement a versioned quality policy with strict defaults and portrait-aware dimensions.
- [x] 3. Replace branch-first selection with a ranked inventory of eligible combined/separate sources.
- [x] 4. Preserve the URL's target quality across delivery attempts, metadata refreshes, and repeated CSV entries.
- [x] 5. Add transactional output publication and provenance-based reuse.
- [x] 6. Propagate quality outcomes through per-clip records, summaries, Electron IPC, UI, and retry export.
- [x] 7. Update and pin tested extraction/runtime dependencies; add executable identity/capability checks.
- [x] 8. Implement and pass the regression matrix with real yt-dlp selection and real local media.
- [ ] 9. Build and verify the Windows executable and installed Electron application against affected URLs.
- [ ] 10. Pilot the verified build, inspect delivered outputs, and expand distribution only after release gates pass.

Do not ship an intermediate source-only change as the completed fix. Steps 2-9 form the first release's required behavior; step 1 can proceed alongside implementation when client evidence is not immediately available.

## 1. Define an explicit quality contract

### Policy model and defaults

Introduce an immutable `QualityPolicy` containing `policy_version`, `minimum_edge`, `maximum_edge` (optional), `dimension_basis`, and `fallback_mode`. Keep this separate from `EncodingPolicy` and delivery profiles.

Recommended product defaults for the first release:

| Setting | Default | Meaning |
| --- | --- | --- |
| Minimum accepted quality | 1080p | A delivered video must have at least 1080 pixels on its shorter dimension |
| Maximum quality | 1080p | Select the best eligible source within this limit |
| Fallback mode | Strict | Do not accept a lower target tier/frame rate after a delivery failure |
| Best available maximum | Explicit choice | Remove the maximum, retain the chosen minimum, and disclose possible 4K/8K processing cost |

These are proposed defaults for the fix, not a claim that clients previously chose them. Tests and documentation must make the behavior change visible.

Rules:

1. Compute the quality dimension from the display-oriented source width/height as `min(width, height)`. Handle rotation consistently between extraction metadata, probing, and output validation; do not apply rotation twice.
2. Thus 1920x1080 and 1080x1920 both meet 1080p; 720x1280 meets 720p. Do not filter portrait sources by literal height.
3. Require positive, known dimensions before strict acceptance. Probe a promising candidate when metadata is incomplete; an unknown dimension must never bypass a minimum or maximum.
4. Use actual dimensions for comparisons, without rounding a sub-1080 source up to 1080. Document that unusual/ultrawide aspect ratios use the shorter dimension; for example 1920x800 does not meet this strict 1080p rule.
5. Reject `minimum > maximum` before extraction or spawning. Changing the maximum must not silently lower the minimum.
6. Keep the minimum a hard acceptance requirement. A genuinely 480p original fails a 1080p run with an explanatory quality result. The user can explicitly rerun it under a lower minimum.
7. Do not upscale, change metadata labels, or impose an H.264-only source restriction to satisfy this requirement. Continue converting the best selected codec to the existing output format.

Define Best available as the best rendition exposed by the configured, supported extraction profiles within the policy. Do not claim knowledge of every stream YouTube might expose to another account, region, or client. Record incomplete discovery when access failures prevent comparison.

### CLI and migration

Retain existing positional argument order. Add named policy flags such as `--min-quality`, `--max-quality`, and `--quality-mode strict`; expose `--capabilities-json` separately from normal run arguments.

Keep `--resolution` as a deprecated compatibility alias for the maximum. If no minimum is supplied through this legacy alias, derive `min(1080, explicit_maximum)`; explicit 360p/480p/720p choices therefore remain usable while becoming strict. Map explicit legacy `auto` to Best available with a 1080p minimum. New calls with no quality flags use strict 1080p minimum/maximum. Reject conflicting aliases instead of choosing silently.

Migrate persisted UI settings explicitly: preserve a selected maximum, derive and show the minimum using the same rule, and display the new meaning of Auto. Do not preserve the old selector under the new Best available label. Existing scripts remain syntactically compatible, but low-source acceptance intentionally changes; document that in release notes.

An optional allow-lower mode can follow after the strict release. It may relax the locked target while remaining above the explicit hard minimum, must be chosen before the run, and must emit `DEGRADED`. Sources below the minimum still require an explicit lower-minimum rerun. Do not enable this mode automatically after failures or as part of rollback.

## 2. Build and rank a source inventory

Introduce a small `SourceCandidate` model containing source identity, profile/client provenance, video/audio format IDs, transport/protocol, width/height, normalized quality, frame rate, codecs, dynamic range, and available bitrate metadata. Keep signed media URLs and authorization headers in memory only.

Implementation requirements:

1. Extract metadata without media downloads for each configured supported delivery profile in a fixed, bounded order. Observe request delays and Stop between operations. Collect a comparable inventory before accepting a lower candidate from an early profile.
2. Include combined video/audio and video-only plus eligible audio in the same resolution comparison. Do not make a separate-video branch win merely because it exists.
3. Bind an audio/video pair to the same extraction context/profile for the first release. Preserve language/default-track intent; do not silently replace audio with another language or synthesize audio to hide unavailable streams.
4. If a source has audio, require a valid audio-bearing download plan. A high-quality video-only stream with no accessible audio is not an acceptable complete candidate for an audio-bearing source. Record this limitation distinctly; permit video-only output only for a confirmed silent original under a documented policy.
5. Exclude above-maximum, below-minimum, DRM, storyboard/image-only, and unsupported delivery candidates. Record rejection reasons without persisting sensitive URLs.
6. Rank first by normalized resolution, then frame rate, then tested yt-dlp rendition preferences. At equal resolution/frame rate, prefer separate streams when appropriate, but do not let that preference override resolution. Do not compare raw bitrates across codecs as a universal quality score.
7. Preserve extractor and client provenance: the standard profile may aggregate multiple YouTube clients. Deduplicate identical deliveries without collapsing independent client/protocol fallbacks for the same quality.
8. Use yt-dlp's documented custom-selector API or a verified equivalent to bind the chosen candidate. Ensure `process_ie_result()` cannot reselect a different rendition behind the application's policy. Test selected format IDs at the actual range-download boundary.
9. Use a pure eligibility/ranking helper for the minimum/maximum rule. yt-dlp's `res` sorting can assist ranking, but preference sorting alone is not a hard bound. Verify the chosen API with the new pinned version rather than assuming behavior from current master.

Preflight metadata calls are bounded to the configured profiles once per URL/policy, with on-demand refresh thereafter. Do not run unbounded format probes or download the entire source to discover quality.

If discovery fails for a profile, retain the underlying error and mark discovery incomplete. A surviving 360p inventory does not prove the original only exists at 360p. Under the default 1080p requirement it cannot be accepted regardless.

## 3. Lock quality and repair retries/caching

Introduce `VideoQualityState` for a canonical video identity plus quality-policy fingerprint. It contains the candidate inventory, locked target, selected candidate, metadata generation/time, attempted deliveries, and acceptance history. Sessions are delivery resources, not the authority for quality.

Target rules:

- Resolve the best eligible tier/frame rate from discovery, verify it through probing, and lock it before publishing the first clip.
- If a candidate's real probe contradicts its metadata, invalidate it and resolve again before locking. Do not lock an impossible target solely from an unverified dimension claim.
- Once locked, refreshes and profile switches must maintain at least the locked normalized resolution and frame rate, while remaining within the maximum. Preserve output dimensions/frame rate against the actual selected rendition as well.
- A discovered/locked 2160p target must not quietly become 1080p merely because 1080p exceeds the run's minimum. In strict mode that remains a quality failure if the target cannot be recovered.
- A change of source codec or transport at equivalent quality is allowed. Record it for diagnosis; nominal resolution cannot establish identical perceptual detail.
- Repeated occurrences of the same canonical video in later pairs/rows reuse the target requirement. They must not reset the acceptance floor. Target records survive for the run even if delivery sessions/URLs are evicted or refreshed.

Bound the media-attempt state machine independently from yt-dlp's internal retries:

1. Try the best verified candidate at the locked quality.
2. For an expired/403 delivery, invalidate its URLs and perform one metadata refresh for that profile. Reapply the policy/target; retry only an eligible refreshed candidate.
3. Try another independent rendition/client/protocol at the locked quality, rather than retrying the same failed URL repeatedly.
4. Stop at a configured application budget: initially four media attempts per clip and one refresh per profile per clip, with a 180-second total clip deadline as an initial tuning value. Enforce the deadline across extraction, probes, child FFmpeg processes, and yt-dlp internal retries; four outer attempts alone is not an elapsed-time limit.
5. Retain interruptible backoff. Respect 429 throttling; do not fan out requests or rotate profiles to evade a rate limit. Check Stop and remaining deadline before every operation and wait.
6. If no acceptable candidate remains, return a structured terminal outcome, close affected sessions, remove only this attempt's temporary artifacts, and continue unrelated clips.

Use a distinct `QualityUnavailable`/quality-rejection result that allows bounded search of the remaining profiles. Do not subclass or route it through today's terminal `EncodingError` branch. Keep genuine output-encoding/validation faults distinguishable from network failure and unavailable quality.

Cache by canonical video ID/URL, policy fingerprint, delivery profile/client configuration, and metadata generation. Cache hits may reuse an eligible candidate but never override candidate ranking or the target. Reusing a known unacceptable fallback must not make it eligible. Negative results expire and cannot permanently suppress a recovered HD source.

Retain a lightweight target map for every distinct video in the run. Bound the heavier session/metadata cache separately, close evicted sessions, and never persist signed media URLs across runs. Requests for the same source under a different policy must not share an incorrectly selected session.

Differentiate final reasons:

| Outcome | Meaning |
| --- | --- |
| `OK` | A validated, correctly identified output meets minimum, maximum, and the locked target |
| `QUALITY_UNAVAILABLE` | Successful bounded discovery/probing provides no candidate satisfying the policy/target |
| Existing network/access category | A possibly acceptable rendition could not be assessed/delivered because of 403/429/authentication or another delivery error |
| `VALIDATION_FAILED` | Downloaded output fails container, codec, dimensions, FPS, audio, HDR, duration, or quality checks |
| `OUTPUT_CONFLICT` | Existing positional output belongs to another input/policy or has unverifiable identity |
| `DEGRADED` | Reserved for the later explicitly enabled lower-target mode; never ordinary success |
| `CANCELED` | User cancellation; never relabel it as quality unavailability |

If discovery is incomplete, report that fact alongside the primary access/quality outcome. Avoid presenting a network restriction as proof that the original is low resolution.

## 4. Make output publication and reuse trustworthy

Preserve filenames such as `1/1.1.1.mp4`, but stop downloading directly into the final path.

1. Create an attempt-specific temporary directory on the destination volume. Point all downloader/remux artifacts there; explicitly replace only files owned by that attempt. Prevent concurrent runs from owning the same final destination using an exclusive run/output lock with explicit stale-lock handling.
2. Probe the real selected source and the finished temporary file. Enforce both the quality policy/target and the existing encoding checks. Probing only against a low-resolution selected source is insufficient.
3. Record source ID/canonical URL, exact effective start/end, positional destination, policy version/fingerprint, selected format IDs/profile, source/output measurements, build identity, file size, and SHA-256 in a sidecar manifest.
4. Publish using same-volume atomic replacement. Because media and sidecar cannot be replaced atomically as one pair, use a completion marker/transaction state: missing, inconsistent, or pending provenance is never reusable. Mark committed and increment success only after both final media and provenance are durable and checked.
5. Reuse an existing output only when input identity, effective range, policy/target, encoding-policy version, file hash, and fresh media validation match. A matching filename/dimensions alone is insufficient. Reused clips still emit a full per-clip result with `reused=true`.
6. Treat legacy files without provenance and conflicting files as `OUTPUT_CONFLICT`. Default to preserving them and reporting the conflict. Offer an explicit replace-existing run option or recommend a fresh directory; do not silently treat old media as the new input.
7. If replacing is explicitly enabled, keep the old completed output until the new media has passed validation. Handle commit failure so the result cannot be reported as the new successful output. On failure, identify any retained old file as previous output in the result.
8. Clean only known temporary paths under the run-owned directory. Replace the existing broad positional-stem glob cleanup; it must not delete valid earlier clips, manifests, or another run's files.
9. Handle Stop/crash at every publication boundary. A pending transaction is recognized on the next run, and incomplete artifacts are excluded from completed output counts.

The output directory may contain earlier files after a failed replacement. The run manifest and UI must distinguish newly committed/reused successes from retained historical files so clients cannot interpret directory contents as this run's delivered set.

## 5. Expose quality results through the whole app

### Per-clip records and summaries

Emit a versioned `CLIP_RESULT:` JSON record for every terminal clip outcome, including reused files. Persist equivalent local JSONL records and a run summary next to the output; no automatic telemetry or third-party upload is part of this plan.

Minimum record fields:

- Run ID, clip ID, CSV row/pair/clip indices, source ID/canonical URL, effective range, and final path.
- Requested minimum/maximum, dimension basis, locked target/FPS, strict/allow-lower mode, and policy version.
- Actual profile and available underlying client, format IDs, transport, codec/dynamic range, source/output dimensions/FPS, and optional bitrate metadata with units.
- Ordered attempts, sanitized causes, metadata refreshes, discovery completeness, reuse/transaction state, and terminal outcome.
- Executable build/source commit, application/protocol version, yt-dlp/EJS versions, FFmpeg/FFprobe versions, and runtime capabilities.

Do not persist full extraction dictionaries, signed CDN URLs, URL query credentials, cookies, tokens, authorization headers, or unredacted FFmpeg commands. Test redaction against nested exception data as well as simple log lines.

Extend `DOWNLOAD_SUMMARY:` with a schema version and explicit quality-unavailable, validation-failed, output-conflict, and degraded counts. Keep existing categories and fields where practical. Each terminal clip contributes once; repeated URL/timestamp occurrences are counted by clip identity, while retry CSV export may deliberately deduplicate them.

Required invariants:

- `processed = succeeded + degraded + failed` if the later degraded mode is implemented; until then `degraded = 0`.
- `succeeded` contains only validated `OK` outputs, including provenance-verified reuse.
- `total = processed + notProcessed`, including cancellation.
- Code 0 means the requested run completed with no failures or degraded results. Keep code 1 for fatal startup/runtime failure, code 2 for non-clean completion, and code 3 for cancellation. Use code 2 for a future degraded run to retain a clear non-success signal.
- A process exiting 0 without a compatible, complete summary is a protocol failure in the new UI, not a green success.

### Electron and user-facing behavior

Add controls for Minimum accepted quality and Maximum quality, with strict 1080p as the default. Explain portrait handling in ordinary terms. Show a compact per-clip requested-versus-delivered result and a final count such as: `12 met quality, 2 quality unavailable, 1 delivery failed`.

Before spawn, validate the entire policy in the renderer and main process. Pass it through preload and `buildDownloadArguments()` without changing existing positional fields. Freeze a snapshot while the run is active; unlock controls on completion, cancellation, spawn failure, and capability mismatch.

Do not let `completion.success` depend only on exit code. Require protocol compatibility, a parsed final summary, zero failed/degraded results, and consistent counts. The renderer must never show a generic all-success message after quality failures or a truncated result stream.

Extend retry exports to include quality-unavailable, delivery, validation, and conflict outcomes. Keep the existing CSV syntax, and export a companion policy/run metadata file because the CSV itself cannot preserve quality settings. Import/attach the companion through the app when present; when absent, visibly apply the current strict policy. A retry must not silently loosen the original minimum/target. An explicitly enabled future degraded mode gets a separate retry-degraded action.

## 6. Update dependencies and bind the release to its executable

Use a clean, reproducible Windows build environment with a tested maintained yt-dlp/EJS pair. Resolve the exact versions during implementation, pin them, and record why those versions passed the affected-URL and packaging checks. Do not write an unverified future version into this plan or assume system yt-dlp changes a frozen executable.

The [19 August yt-dlp release](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.08.19) confirms default-client changes after the project's July pin. Evaluate the supported clients against affected URLs; do not mechanically retain obsolete fallback profiles. Use the [official PO Token Guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide) and [EJS instructions](https://github.com/yt-dlp/yt-dlp/wiki/EJS) when determining necessary runtime/provider setup. Token provision and JavaScript challenge solving are separate requirements.

Requirements:

1. Package EJS and any required provider dependencies explicitly. Test their dynamic discovery inside PyInstaller; source-mode availability is insufficient.
2. Provide a diagnostic preflight for JS runtime, supported clients/provider readiness, FFmpeg/FFprobe, and required encoders/filters. Missing prerequisites produce an actionable startup/result error rather than a quiet quality reduction.
3. Preserve the current external FFmpeg/FFprobe prerequisite unless the release deliberately bundles a tested build. Record the exact binaries used; feature-check them, including HDR filters, rather than assuming any PATH executable works.
4. Add a build manifest with source commit, dirty/source digest status, policy/protocol version, exact tool versions, and supported flags. The external packaging manifest contains the final executable SHA-256; do not attempt to embed the executable's own hash inside itself.
5. Add `--capabilities-json`/build-information output and have Electron validate it before a run. Fail clearly if UI and binary protocol/policy versions disagree; never silently fall back to an old binary.
6. Cleanly rebuild the downloader and smoke-test the trimmer that shares requirements. Verify Forge includes the new executable under `resources/dist` and is not using an old `dist` artifact.
7. Bump the app release version and save the executable/package hashes with the release. Verify the installed client's executable matches that manifest, not just the installer filename.
8. Require an explicit build interpreter/module invocation rather than whichever global `pyinstaller` happens to appear on PATH. Validate the dependency versions before compilation and fail the build if they differ from the tested pins.

## 7. File-level work map

Paths below are implementation targets; proposed new modules do not exist yet.

| File | Work |
| --- | --- |
| [5_sec_downloader.py](E:/CodingFolder/Youtube-Video-Collector/youtube-video-collecting/tools/5_sec_downloader.py) | Integrate policy, inventories, quality state, attempts/deadlines, output transactions, structured records, summary/exit codes, CLI/capabilities |
| [downloader_quality.py](E:/CodingFolder/Youtube-Video-Collector/youtube-video-collecting/tools/downloader_quality.py) (new) | Pure policy validation, normalized dimensions, eligibility/ranking, target checks; keep delivery I/O outside this module |
| [downloader_output.py](E:/CodingFolder/Youtube-Video-Collector/youtube-video-collecting/tools/downloader_output.py) (new) | Attempt paths, provenance, hash/reuse validation, publication/recovery, scoped cleanup |
| [requirements.txt](E:/CodingFolder/Youtube-Video-Collector/youtube-video-collecting/tools/requirements.txt) | Tested exact yt-dlp/EJS pins and required provider dependencies |
| [downloader-options.js](E:/CodingFolder/Youtube-Video-Collector/youtube-video-collecting/src/downloader-options.js) | Policy defaults/validation, backward-compatible argument builder, policy fingerprint/serialization contract |
| [index.html](E:/CodingFolder/Youtube-Video-Collector/youtube-video-collecting/src/index.html), [tools-handler.js](E:/CodingFolder/Youtube-Video-Collector/youtube-video-collecting/src/tools-handler.js) | Quality controls, migration, frozen run settings, per-clip/final messages, retry actions |
| [preload.js](E:/CodingFolder/Youtube-Video-Collector/youtube-video-collecting/src/preload.js), [index.js](E:/CodingFolder/Youtube-Video-Collector/youtube-video-collecting/src/index.js) | Policy IPC, binary capability validation, strict completion logic, support/export paths |
| [downloader-summary.js](E:/CodingFolder/Youtube-Video-Collector/youtube-video-collecting/src/downloader-summary.js) | Versioned per-clip/summary parsing, quality counts, complete-stream checks, retry-policy companion |
| [build-executables.js](E:/CodingFolder/Youtube-Video-Collector/youtube-video-collecting/build-executables.js), [forge.config.js](E:/CodingFolder/Youtube-Video-Collector/youtube-video-collecting/forge.config.js) | Deterministic interpreter/dependency verification, manifests, collected modules/providers, packaged-resource checks |
| [package.json](E:/CodingFolder/Youtube-Video-Collector/youtube-video-collecting/package.json), [package-lock.json](E:/CodingFolder/Youtube-Video-Collector/youtube-video-collecting/package-lock.json) | Repeatable test/build commands and application version change |
| [test_5_sec_downloader.py](E:/CodingFolder/Youtube-Video-Collector/youtube-video-collecting/tests/test_5_sec_downloader.py), [test_downloader_encoding.py](E:/CodingFolder/Youtube-Video-Collector/youtube-video-collecting/tests/test_downloader_encoding.py) | Replace assertions preserving old quality semantics and add selection/retry/real-media acceptance cases |
| [test_downloader_options.js](E:/CodingFolder/Youtube-Video-Collector/youtube-video-collecting/tests/test_downloader_options.js), [test_downloader_summary.js](E:/CodingFolder/Youtube-Video-Collector/youtube-video-collecting/tests/test_downloader_summary.js) | Actual IPC/renderer/parser/retry behavior, chunked records, protocol failure cases |
| [README.md](E:/CodingFolder/Youtube-Video-Collector/README.md), [USAGE_GUIDE.md](E:/CodingFolder/Youtube-Video-Collector/USAGE_GUIDE.md), [BUILD_GUIDE.md](E:/CodingFolder/Youtube-Video-Collector/youtube-video-collecting/BUILD_GUIDE.md) | Quality promises, CLI migration, output/retry manifests, build identity, client triage |

Keep refactoring limited to responsibilities needed for these fixes. Do not combine unrelated cleanup with the release.

## 8. Regression matrix and release gates

Use three layers: pure policy tests, real pinned yt-dlp selection/orchestration with controlled failures, and real FFmpeg media over local HTTP. Live YouTube/packaged Windows runs are a separate release layer and cannot be replaced by synthetic metadata.

| Case | Required result |
| --- | --- |
| Separate 360p + audio, combined 1080p | Select 1080p in every quality mode that permits it |
| Separate 1080p and 2160p | Maximum 1080 selects 1080; Best available/2160 selects 2160 when permitted |
| Only 144p/360p under minimum 1080 | Explicit quality failure; no ordinary success and no committed low-quality output |
| Real local 144p source, strict 1080 run | Quality rejection through the actual download/probe path, not only mocked metadata |
| First clip HD; standard 403 on second; lower Safari succeeds | Refresh/alternative HD delivery or explicit failure; lower Safari cannot be accepted or promoted |
| Cached low fallback before next clip | Policy/target excludes it; recover HD or report failure |
| First profile succeeds at 360p; later profile exposes 1080p | Inventory comparison chooses 1080p |
| Same URL in later pair/row; expired metadata | Target survives; refreshed candidate cannot downgrade |
| Same video, different policy fingerprints | No cross-policy candidate/session contamination |
| 2160p target fails; 1080p still exceeds minimum | Strict run fails if 2160p cannot be recovered; future opt-in mode emits DEGRADED |
| Same resolution, 60fps target vs 30fps fallback | Strict run preserves target FPS or reports explicit quality failure |
| Portrait 1080x1920, 720x1280, 360x640 | 1080 selects portrait 1080; lower tiers honor normalized dimensions |
| Rotated source / unknown dimensions / false metadata | Probe consistently; no minimum/maximum bypass |
| Above-cap source with only unknown alternatives | No out-of-cap selection or unrestricted fallback |
| High video-only source without usable audio | Never silently deliver mute output for an audio-bearing original; classify/retry appropriately |
| HDR/10-bit SDR/combined WebM/separate audio | Retain 8-bit H.264 High MP4/AAC, correct tone mapping, dimensions, FPS, duration, and one lossy encode |
| Clip near source end | Validate against the actual remaining duration |
| Different same-dimension source, same positional name | Provenance conflict or explicit replacement; old bytes cannot count as new success |
| Same source, different timestamp/policy | No stale reuse |
| Hash mismatch / missing sidecar / incomplete transaction | Reject reuse and explain the conflict/incomplete state |
| Valid matching completed output | Fresh validation and provenance-verified reuse; emit per-clip record |
| Stop/crash during extraction, refresh, encode, or publication | No false success, no unrelated deletion, consistent recovery state |
| Concurrent runs into the same destination | Exclusive ownership or explicit conflict; no mixed media/sidecars |
| 429, retry exhaustion, network outage | Bounded attempts/deadline, backoff, accurate category, responsive Stop |
| Chunked UTF-8 stdout / partial JSON / final line without newline | Parse supported records safely; incomplete protocol never becomes green success |
| Exit 0 with missing summary / stale executable | Visible protocol/capability failure before acceptance |
| Mixed OK/quality/access/conflict outcomes | Exact counts; retry export retains URLs/timestamps and companion policy |
| Logs with signed URLs/cookies/tokens | Support records are redacted, including nested attempt diagnostics |

Update tests that currently require legacy Auto ordering, literal-height portrait filtering, acceptance of arbitrarily low sources, and unconditional cached-fallback priority. Keep regression coverage for the useful compatibility behavior those tests also exercise.

Release gates:

1. All applicable Python and JavaScript tests pass with the exact proposed dependency/runtime set. No skipped real-selector or real-media tests in release validation.
2. At least one real below-minimum output is rejected, and at least one actual 1080p or 2160p eligible source is delivered and measured. Tiny fixtures alone cannot prove HD delivery works.
3. Controlled 403-after-HD and repeated-URL cases cannot generate an unqualified lower-quality success.
4. Output identity/reuse and interrupted publication cases pass with real files; hashes and manifests match the completed media.
5. The actual built executable and installed Electron UI pass policy, summary, cancellation, and resource-path checks on Windows. Test without a system Python installation; verify JS/FFmpeg prerequisites through the intended client setup.
6. Reproduce an affected client case using original timestamps in a fresh directory, then perform a rerun/reuse/conflict check. Inspect output dimensions/FPS directly and retain sanitized evidence. If the affected case remains unavailable, mark the release as a controlled pilot with synthetic/local coverage rather than claiming incident resolution.
7. Resolve the Linux combined-WebM duration discrepancy on supported FFmpeg builds, or explicitly scope/test the supported Windows toolchain and document the Linux limitation. Do not widen duration tolerance just to obtain a green test.
8. Measure preflight calls, clip throughput, retries, deadline compliance, and Stop behavior on a batch with repeated URLs. Record discovery overhead separately from encoding time; investigate unbounded/repeated extraction before release.
9. Verify the executable SHA-256, build identity, policy version, dependency versions, and installed packaged-resource path match the release manifest.

For perceptual complaints at identical dimensions, compare the exact same timestamp with the exact selected source rendition, including codec/dynamic range, before blaming CRF or increasing bitrate. Keep representative decoded frames and a short visual comparison as evidence; dimensions alone cannot prove restored detail.

## 9. Delivery sequence, pilot, and recovery

### First release: block silent downgrades and recover acceptable sources

Ship the strict policy, unified ranking, target-preserving refresh/retry, provenance-safe outputs, quality-aware summaries/retry exports, tested dependency update, and packaged-binary checks together. Collect client evidence alongside development. Reject low-quality results explicitly even if that increases visible failures initially; do not describe those failures as successful deliveries.

Produce a reviewable release candidate with its test report, sanitized before/after reproduction, installer/executable hashes, and known limitations. A source commit or a passing unit suite alone is not a release candidate.

### Pilot and wider distribution

Use a small affected workflow first, with a fresh destination and known URLs/timestamps. Verify every pilot clip against the minimum/target and inspect representative visual quality. Track policy-compliant success, quality unavailability, delivery failures, validation/conflict outcomes, source transitions, and processing time as separate counts.

Expand distribution only after the packaged release gates pass and pilot outputs match the recorded source properties. Keep quality checks active for every output after expansion; sampling visual quality does not replace numeric/provenance validation.

Any silent below-policy success, stale-content success, or UI/binary mismatch blocks expansion and requires correction. Preserve logs/artifacts, stop distributing the candidate, and issue a corrected package. Recovery must retain strict checks; do not automatically roll back to the old silent-downgrade behavior or lower client quality settings.

### Follow-up work

After the strict release is stable: optional explicit lower-target mode with DEGRADED outcomes, a better per-clip report/export interface, broader provider/client coverage if incident evidence requires it, and measured encoding-preset improvements. Any extraction-dependency update reruns the critical selection/fallback and packaged-binary cases before release.

No calendar ETA is promised by this document. The first meaningful milestone is a built Windows candidate that passes the silent-downgrade, stale-file, and UI-summary gates; client rollout depends on that evidence.

## Completion criteria

This work is complete when the installed application consistently selects the best exposed eligible source, preserves its target quality through bounded retries, and reports any inability to meet the requirement explicitly. Every accepted file must match its recorded video/range/policy, pass real media validation, and appear correctly in the final UI summary. Client support must be able to explain a clip's selected source, retries, measurements, and exact build without exposing credentials.

## Primary references

- [yt-dlp format selection, sorting, and custom-selector API](https://github.com/yt-dlp/yt-dlp/blob/master/README.md): supported selection integration; `res` sorting describes the smaller dimension but is not a hard acceptance filter.
- [yt-dlp 2026.08.19 release](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.08.19): client maintenance after the project pin.
- [YouTube PO Token Guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide) and [EJS setup](https://github.com/yt-dlp/yt-dlp/wiki/EJS): verify runtime/client requirements at implementation time.
- [FFmpeg documentation](https://www.ffmpeg.org/ffmpeg.html): range processing, encoding, stream mapping, and output validation context.

External references describe upstream behavior and can change. The implementation's pinned-version tests and packaged-runtime evidence are the acceptance authority for this release.


## Implementation verification update — 17 October 2026

The strict policy, source inventory/ranking, per-video target, qualified cache,
transactional provenance/reuse, JSON records and retry-policy companions, app
completion checks, dependency update, and binary/source identity checks are
implemented. The optional degraded mode remains deferred as planned.

Fresh checks currently pass: 64 Python tests and 70 JavaScript tests. The public
Big Buck Bunny source (`YE7VzlLtp-4`, 30–35 seconds) produced a real 1920×1080,
24 fps, H.264 High/yuv420p MP4 with a measured duration of exactly five seconds.
This is a representative live check, not a reproduction of an unavailable client
incident. Windows frozen-media and packaging verification passed and is recorded in
the [release notes](E:/CodingFolder/Youtube-Video-Collector/QUALITY_FIX_RELEASE_NOTES.md). No client-wide distribution has been performed.
