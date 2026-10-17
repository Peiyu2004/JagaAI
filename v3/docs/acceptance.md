# v3 acceptance checklist

Prepared **2026-10-15 (Asia/Kuala_Lumpur)** from `JagaAI_Redesign_Plan_v3.md` v3.2. This file is a test plan, **not a pass report**. Every item below is pending until a dated command/output, browser artifact or evaluation result is linked. Existing legacy test counts do not count as v3 acceptance.

## M0 — safe rebuild and runnable foundation

- [ ] Preserve `.runtime/` and its local model weights. Record a recoverable legacy code/data/config backup without printing secrets; for SQLite include committed WAL state. Verify restore instructions and obtain the planned confirmation before deleting old code.
- [ ] Build an independent React/TypeScript/Vite frontend, FastAPI/SQLModel SQLite API and Python worker. No old database schema is assumed compatible. Old `.env` values are not silently loaded into new services.
- [ ] One Windows start script binds frontend/API/Ollama to loopback, handles occupied ports, preserves data on restart and shuts down only processes it owns. Log actionable failures.
- [ ] Validate FFmpeg/FFprobe paths, Python packages and ONNX execution providers; report actual CPU/GPU/VRAM and measured decode/detect/track throughput rather than promised FPS.
- [ ] Verify the existing local `qwen3-vl:2b` and `qwen3-embedding:0.6b` model digests/health without re-downloading weights or enabling cloud aliases/fallbacks.
- [ ] Record detector/tracker/model source versions and licenses. YOLOX + ByteTrack, no Ultralytics/AGPL dependency. Download failure cannot produce fabricated detections.

## M1 — software behavior

- [ ] Admin and supervisor authenticate; only admin manages accounts/settings. Guards are duty-roster records and cannot log in. Residents see only their own leads and public replies.
- [ ] Private authenticated video delivery supports browser playback, time offsets and HTTP Range. Viewing footage is audited. Direct/expired/other-resident media requests are denied.
- [ ] Upload rejects invalid formats and paths, records UTC start/duration/expiry, and queues analysis once. Restart/lease recovery/reanalysis is idempotent; failed analysis is distinguishable from completed analysis with no event.
- [ ] Detection/tracking yields camera-local anonymous IDs and bounded timestamps; motion filtering does not suppress required track timing. No identity/person-face database or cross-camera identity is added.
- [ ] R1 uses parking-zone dwell ≥120s, or proximity to ≥3 distinct vehicles in 5 minutes with ≥3s per vehicle. Metrics, rule ID/version, triggering timestamp and keyframes are persisted and visible.
- [ ] R3 entering a restricted polygon/line respects active hours including 19:00–06:00 across midnight. Boundary, crossing direction, repeated crossings and daylight inactivity have explicit test cases.
- [ ] Same-person/same-behavior and per-camera/rule 10-minute deduplication survive retries and reanalysis. Test boundary values immediately before/at/after thresholds, not only one easy positive.
- [ ] Alert confirm/dismiss/link transitions are valid and auditable; dismissal requires a reason. Repeated confirm cannot create duplicate incidents or silently overturn a previous review.
- [ ] Incident flow: pending → assigned → resolved → closed, with duty guard, outcome, evidence and timestamped history. Manager records the guard's work; no external notification is implied by assignment.
- [ ] Resident mobile flow: map location, one sentence, time choice, optional photo, submit; fixed follow-up/safety wording, received/in progress/handled status and public reply. Rate limiting and demo login limitations are visible.
- [ ] Lead → footage search carries the correct location/time; conversion/linking preserves evidence and replies without granting resident footage access.
- [ ] Command Centre receives alerts/leads via SSE. Reconnection refreshes durable state; duplicates, deleted sessions and missed event IDs are handled.
- [ ] UTC storage and Asia/Kuala_Lumpur display work for upload, search, active hours and overnight ranges.
- [ ] Expiry removes source media, derived clips/keyframes/tracks/events/descriptions/vectors while preserving human review/outcome/audit. Expiry during inference or playback fails closed.
- [ ] English management UI at 1440px and resident UI at approximately 390px fit without horizontal overflow. Navigation, dialogs, forms and evidence controls work with keyboard/focus; no console/runtime errors in core flows.
- [ ] Runtime business media/queries remain local; HTTP redirects cannot forward them to a remote inference endpoint. No hidden analytics/font/cloud inference dependency is required.

## M1 — search honesty and plan examples

- [ ] Show editable interpreted time/location/behavior/object/color conditions and explicit analysis/index coverage. Unknown location, missing model, failed index and no match remain distinct states.
- [ ] Behavior queries route to rule events; descriptions route to real local embeddings. Model/dimension/content versions must match and stale/expired/unscoped records are excluded before ranking.
- [ ] Apply a documented/calibrated semantic threshold. Low scores show “No clear match”; optional nearest footage is labeled for manual review. Similarity is never displayed as a probability of guilt or verified event.
- [ ] `昨晚有没有人有可疑行为`: supported behavioral events and reasons, or “not found” with coverage.
- [ ] `昨晚停车场有人逗留吗`: only loitering in the correct place/time.
- [ ] `穿红衣服的人靠近白色汽车`: expected public/authorized clip ranks in top 3 on the held-out queries.
- [ ] `lelaki baju merah dekat kereta`: same intended appearance retrieval, with Malay interpretation visible.
- [ ] `有没有人打架` and `有人倒地吗`: unsupported message, no invented event result.
- [ ] `昨晚有大象吗`: no clear match, not a mandatory nearest clip presented as a match.

## M1 — empirical gates (not satisfied by synthetic software tests)

- [ ] Freeze debugging/holdout material from distinct recording sessions; store source consent or MEVA attribution and exact split identifiers.
- [ ] Each supported rule recall ≥2/3; report raw TP/FN counts for each rule/day/night condition. Unmet behavior is labeled experimental.
- [ ] Normal-footage false alerts average ≤1 per clip; report actual false alerts and clip count/durations, including failures.
- [ ] Answerable search top-3 hit rate ≥80%; record query/expected/returned clip IDs and numerator/denominator.
- [ ] No-answer queries correctly show no clear match in ≥4/5 cases. Test unsupported behavior separately from supported but absent behavior.
- [ ] Record real processing throughput, end-to-end search latency and human-vs-system retrieval timing with hardware, cold/warm conditions and run counts. Do not generalize a single synthetic run.

## M2 — public VLM experiment and deployment gates

- [ ] Reconfirm official MEVA source/license and annotation release, camera/date/interval conventions, activity alias mapping and r13 frame alignment. Native reader is currently an unresolved gate; normalized input is not the native MEVA schema.
- [ ] Download selected public data directly in Colab; no resident media/local private dataset uploads. Preserve source hashes, annotation commit/IDs and extracted-frame attribution.
- [ ] Audit at least ten normalized intervals and negatives; associated object labels are not automatically exhaustive. Split by whole date or camera with frozen IDs and no source-video leakage. Record missing labels.
- [ ] Run the notebook's 10-example/10-step serialization smoke, save/checkpoint/reload and test public image inputs before a longer run. A smoke adapter is labeled as such.
- [ ] Record current Colab GPU, package freeze, base revision and peak VRAM. On T4 use 4-bit/FP16, batch 1 and bounded images/context; catch OOM and document the adjusted consistent comparison budget.
- [ ] Evaluate 2B original and 8B original on validation. Predeclare an adequate baseline target; skip fine-tuning if it already suffices. Do not select a model using the final test set.
- [ ] If training, save each epoch to verified persistent storage and validate resume. No Drive mount/account connection occurs automatically in the supplied notebook.
- [ ] Evaluate 2B original, 8B original and actual 8B adapter on identical frozen samples/prompt/decoding; report activity precision/recall, schema correctness, class support and sequence/amortized-frame latency with raw counts and errors. This is pre-cut sample classification, not temporal detection recall.
- [ ] Record actual adapter/base/processor hashes. Verify Transformers 4-bit reload and image conditioning. A Colab 8B batch run is labeled preprocessed, separate from local 2B live inference.
- [ ] Ollama export remains unverified: validate a matching vision projector/template, multi-image behavior and adapter equivalence against Transformers, not only `ollama create` success. Save import/version/error logs; otherwise use explicit Transformers 4-bit fallback or offline batch analysis.
- [ ] Imported offline descriptions validate against schema and source-video offsets, carry model/training provenance and never fabricate rule events from an activity caption.

## M2 — remaining product work

- [ ] Full camera zone editor/timelines, reports and PDF export use real recorded metrics; unsupported/unimplemented controls are labeled.
- [ ] R4/R5, VLM event verification, appearance/combined search, simulated RTSP and voice input receive separate acceptance evidence before being advertised as implemented.
- [ ] Demo labels preprocessing/recordings and experimental behavior, includes public-data attribution, honest hardware limits and reproducible empirical results.

Training preparation details and checked primary sources: [training/README.md](training/README.md). Actual test reports should be dated separately and linked here when performed.

---

## Verification log — 2026-10-15 (Asia/Kuala_Lumpur, evening)

Only items below were actually run. No checkbox above is ticked from this log because none of it measures real CCTV accuracy.

| Check | Result |
| --- | --- |
| `pytest` in `backend/` | **74 passed** (includes 5 new cases for retry/force re-analysis) |
| `tsc -b` and `vite build` in `frontend/` | Pass (JS 382 kB, gzip 118 kB) |
| `scripts/smoke-pipeline.py` against the running API, real local Ollama | Detection and tracking `ready`; `qwen3-vl:2b` description and `qwen3-embedding:0.6b` vector `ready`. Input is a labelled **synthetic** 5 s clip, so this proves the plumbing only. CPU YOLOX-Tiny, 25 sampled frames, one description frame, total 36.6 s |
| Search on that clip | Fighting and falls return "not supported"; a no-match query returns "No clear match"; nearest clip is marked "human review only" (score 0.59 < threshold 0.65) |
| Headless Chromium, 1440 px, signed in as admin | All 8 management pages render, no horizontal overflow, **0 console or page errors** |
| Headless Chromium, 390 px, `/resident` | Renders, no horizontal overflow, 0 errors |

Defects found and fixed in this pass:

1. The running API had been started before `local_ai.py` was fixed (the 2048-token budget for the thinking VLM), so it kept returning an empty structured result. Restarted on current code; the VLM step now completes.
2. `POST /api/videos/{id}/analyse` ignored `?force=true` and refused to re-queue a `ready` video whose descriptions had `failed` or `partial`. The Cameras page showed "Reanalyse" / "Retry semantic analysis" and a success toast, but nothing ran. Now re-queues in both cases and never re-queues while descriptions are still processing.
3. Search said "Upload and analyse footage" even when recordings existed but fell outside the interpreted time or place. It now distinguishes "nothing in range" from "in range but not yet analysed".

Still unproven and **not** claimed: R1/R3 recall on real footage, false-alert rate, top-3 search hit rate, MEVA training and evaluation, Ollama export of a fine-tuned model, resident photo upload in a browser, and the SSE reconnect behaviour in a live browser session.

### Addendum — MEVA clip selection tooling (2026-10-15, later)

`scripts/meva_select.py` written; `backend/tests/test_meva_select.py` (6 cases) passes, including a local AVI to MP4 conversion. `index` was run against the public bucket (listing only): 3956 clips, about 476 GB, 324 h, 4 sites, 8 collection dates, clips start between 07:00 and 17:59 except one 23:xx slot on 2018-03-11 (26 clips, one per camera), so no usable night footage. 64 annotated example clips exist (about 9.4 GB of video). The 128 annotation text files (47 KB) were downloaded after the user approved it; **no video has been downloaded**.

Findings from the real annotation files (checked 2026-10-15):

- The bucket's `examples/annotations/` is a small *example* release: 64 clips, 122 activity instances, 3-5 per activity. It is **not** the 120-hour training release, so it cannot support the QLoRA experiment on its own. The full annotation set still has to be obtained from the official MEVA repository, which could not be fetched earlier.
- The files use an older vocabulary (`Open_Vehicle_Door`, `Vehicle_Stopping`, `Theft`, ...) than the NIST SDL names in `docs/training/activities.md`; 36 names occur. The script matches vehicle activities in both vocabularies, but a verified alias table does not exist yet. Frame spans in `tsr0` are video frame numbers.
- The parser read all 128 files with 0 unparsed entries after correcting the key (`types`, not `typ`) and class capitalisation.
- `eval_candidates.csv` (git-ignored, under `data/meva/`): 24 clips on 18 cameras, 3.4 GB, tagged R1_context 10, R3_context 6, normal_context 8, split by whole camera (15 debug, 9 holdout, no camera in both). Because the split is by camera, **only one R3-context clip lands in holdout**; widen the candidate pool or accept a weak R3 holdout. The `R1_expected` and `R3_expected` columns are blank: MEVA has no loitering or restricted-area labels, so a person has to watch each clip.

### Addendum — MEVA clip download and first real-footage run (2026-10-15, night)

Approved by the user: download the 24 listed clips (3.39 GB), convert to MP4, record SHA-256.

- **Download is slow and not finished.** The bucket delivered about 40-50 KB/s per connection and about 150-280 KB/s machine-wide even with 24 parallel range requests, roughly 7 minutes per 140 MB clip. At the time of writing 8 of 24 AVI files were present; the remaining ones continue in a detached job (`data/meva/run-download.cmd`, log `data/meva/download.log`, which ends with `finished-all`). `data/meva/manifest.json` holds SHA-256 only for clips already completed. Re-running `download --yes` resumes by skipping complete files.
- **MP4 conversion works on real files.** AVI to MP4 by stream copy (H.264, 1920x1072, 30 fps, 9000 frames, 300 s), so frame counts match the annotation frame ranges. Tested on 3 clips.
- **First real-footage run** (one 5-minute 1080p clip, throwaway instance with its own data directory, VLM disabled, CPU YOLOX-Tiny, other jobs running at the same time): upload 1.7 s, 1500 sampled frames at 5 fps, 403 detector calls (1097 skipped by the motion filter), 57.5 s detection and tracking wall time, 26 sampled frames per second. **No event was raised**, which is expected: no R1/R3 zone had been drawn for that scene. This is one run, not a throughput claim.
- **Defect fixed:** an uploaded recording stayed in `uploaded` and never started analysis, contradicting the checklist item "queues analysis once". Upload now queues it once (`status=queued`); `/analyse` on a queued video does not enqueue it again. Backend suite: 83 passed.
- With the VLM enabled, a clip samples up to 24 frames at roughly 30 s each. For a rules-only evaluation of 24 clips set `JAGAAI_ENABLE_VLM=0` on the API process; descriptions then show as `failed` with the reason "disabled by configuration", which is accurate but looks like an error.

Still not done: labelling `R1_expected`/`R3_expected`, drawing zones per camera, and running the 24 clips through the rules.

### Addendum — download completed and verified (2026-10-16)

All 24 clips are present: 24 AVI files re-hashed against `data/meva/manifest.json` with **0 mismatches**, 24 MP4 files (H.264, at least 8900 frames each) and `finished-all` in the log. Labelling and rule evaluation are still not done.

### Addendum — labelling tool (2026-10-16)

`scripts/label_server.py` + `scripts/labeller/index.html` (launcher `Label-MEVA.cmd`). Local-only page for filling `scene_hint`, `R1_expected`, `R3_expected`, the R3 door/fence description and notes while watching each clip. The MEVA activity context is hidden until requested; opening it is recorded and exported. Labels are stored per labeller so a second person can label a few clips and the page shows agreement counts.

Checked: `backend/tests/test_label_server.py` (6 cases: range requests, host/origin rejection, path traversal, validation, per-labeller save, export) and a headless Chromium run on two real clips (video plays at 1920 px, speed keys, labels survive reload, export CSV correct, no console errors, no horizontal overflow at 1440 and 390 px). That run found and fixed two defects: typed text could be dropped, or attached to the next clip, when Next was pressed within 0.4 s; and the first click after typing the name was swallowed by a layout shift. **No real labelling has been done yet.** Not tested: other browsers, the CSV opened in Excel.
