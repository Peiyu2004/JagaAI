# Screenshot privacy update — 15 October 2026

Implemented local automatic face/plate concealment for still evidence photos shared with residents. Upload queues local YuNet/YOLOv9 CPU inference and a metadata-free JPEG copy. Staff preview, add missing opaque rectangles, explicitly acknowledge review, and send only that revision to linked residents. Originals remain internal. Withdrawal, source/version/session checks, restricted copy access, retries and retention are implemented.

Build and **77/77 tests** passed, including 13 new privacy tests. The public test composite produced one face and one plate detection; browser QA added an extra cover and verified the resident view at desktop/mobile widths. This is simulated workflow QA and a small detector smoke sample, not a Malaysian CCTV recall benchmark. See `docs/privacy-screenshots.md` and `output/verification/privacy-smoke.json`.

Existing local data and earlier demos were preserved. No GitHub upload, cloud deployment or remote image processing occurred. Argon reviewed code text only. Full-video redaction, face identity matching, plate OCR and report-based points remain outside this delivery. The phase records below describe earlier snapshots; references there to privacy masking as future work are superseded by this update.

---

# Report workflow update — 15 October 2026

The revised proposal's second local phase is implemented: resident submission atomically queues retrieval; the worker prepares missing local VLM descriptions and semantic indexes, then proposes at most three time-bounded clips. Management opens a clip, records a human decision, and explicitly links approved evidence to a new/existing incident while dispatching a property/security work order. Property staff can accept, arrive and submit a result; management closes the case and residents receive public progress only.

Added a property-team role, durable retrieval leases/recovery, exact registered camera/time scoping, session-bound review receipts, source/version invalidation, transactional/idempotent dispatch, restricted approved-clip access and retention cleanup. A report without recordings waits and is woken by a later matching upload. No live camera stream, face identification, privacy masking or report-based points was added.

Build and **64/64 tests** passed, including 17 report-workflow tests. A separate real local Qwen run automatically analysed/indexed an 8-second synthetic upload and produced a 2–7-second candidate in 44.4 seconds. Browser automation exercised review, property dispatch, five-second playback, accept/arrive/resolve and management closure; this is simulated QA, not a real incident or an independent human CCTV evaluation. A second report, **JG-20261015-AB3449**, remains pending for the user to review. See `output/verification/report-workflow-smoke.json` and `docs/test-results.md`.

All work remains on this computer. Existing data was preserved and a SQLite backup saved before the workflow change. No GitHub upload or deployment occurred. Argon received focused design/code text for review, with no footage or account data.

---

# VLM/search update — 15 October 2026

Completed the revised proposal's first implementation phase: local VLM descriptions, persistent multilingual semantic vectors, natural-language time/location search, private frame previews and original-timestamp playback. Portable model setup is project-local. Both models are installed, with Ollama cloud features disabled. The existing local business data and reviewed alerts were preserved; no GitHub repository/upload/deployment was created.

Build, 47 integration tests and the separate real-model smoke run passed at this stage. See `docs/test-results.md`, `README.md` and `output/verification/local-ai-smoke.json`. Report-triggered retrieval has since been implemented above; privacy masking and report-based points remain future work.

The sections below record the earlier baseline.

---

# Execution progress · 14 October 2026

The original development plan remains unchanged. This record distinguishes delivered local software from unverified real-world outcomes.

## Delivered locally

| Area | Status / evidence |
| --- | --- |
| Project setup | Local React/Express/worker structure, locked dependency versions, startup scripts, environment example, README. No GitHub remote or cloud project. |
| Accounts and permissions | Three seeded roles, township/object authorization, hashed passwords, sessions, membership deactivation, private media tickets and audit. Integration tests pass. |
| Report workflow | Validated reports and optional real file uploads, management review/link, formal incidents, assignment, guard state updates, public resident feedback and internal notes. Integration tests pass. |
| Cameras and video | Actual MP4 format/duration probing, private uploads, Range playback, timestamps, silent evidence clipping for assigned guards. Integration tests pass. |
| Worker | Independent process, persisted SQLite jobs, atomic claim, owner/lease/heartbeat, interrupted-job recovery, bounded attempts/backoff, deterministic segment IDs. Integration tests pass. |
| AI workflow | Strict observable-result schema and timestamp checks; clearly labelled predefined synthetic fixtures. Local Ollama adapter implemented; actual installed-model inference not validated. |
| Alerts and search | Separate candidate alerts, human decisions, overlap merging, location/time/keyword search, report-prefilled search, source offsets and partial-analysis coverage. Synthetic integration tests pass. |
| Activities and points | Publish/cancel, unique registration, transactional capacity, verified attendance, one-time ledger award, cancellation reversal preserving history. Integration tests pass. |
| Retention | Actual local original/thumbnail/search-record cleanup; path traversal and resolved path checks. Integration tests pass. |
| Quality | 34 automated tests pass, including two independently identified and fixed permission/state regressions. Final browser/build record is in test-results.md. |

## Intentional changes from the plan

- Firebase Authentication / Firestore / Cloud Storage were replaced with local auth / SQLite / private disk media to honour the user's local-only instruction.
- Gemini calls were replaced with a local-only adapter boundary. No image or video was uploaded to a cloud model. Default fixture output is predefined, not AI inference.
- Video search uses local keywords and structured filters. It is not semantic embedding search or AI reranking; the UI and responses identify this limitation.
- Plain shared CSS provides the responsive visual system. The implemented behaviour is prioritised over reproducing a cloud-oriented stack.
- No publishing, GitHub synchronization, external interviews, real partner claims or deployment occurred.

## Still open

- Six authorised development videos and an independent labelled holdout set.
- A configured local visual model and real output/latency/accuracy evaluation.
- User interviews and property-management authorisation.
- Search accuracy evaluation on 10 real queries and the broader 30-video test set.
- Real-time camera ingestion and 24-hour continuity/soak testing.
- Production password provisioning/recovery, invitation-based membership application and an operational data/privacy review.
- Daily analysis resource budget beyond the current upload/queue/concurrency/attempt limits, larger-scale query pagination and multi-township operations.

These items cannot be counted as completed by running synthetic examples. The local prototype provides the software foundation for them.
