# Screenshot privacy verification — 15 October 2026

`npm run build` passed and **77/77 tests** passed, zero skipped. The 13 new tests establish atomic private job creation, actual offline opaque pixel replacement and EXIF removal, scoped draft/preview access, explicit review and session receipts, copy-only resident playback, share idempotency, withdrawal invalidating tickets, revision/source invalidation, reassignment, bounded failure/recovery and retention with audit preservation. Temporary databases and test files are isolated from local demonstration records.

The real installed YuNet and YOLOv9-t 640 ONNX models detected one face and one plate in a labelled composite of public test imagery. Playwright uploaded the image through the property UI, waited for automatic processing, previewed it, dragged and applied an extra cover, reopened the new revision, confirmed review and sent the masked screenshot. Resident UI showed one protected copy without internal evidence descriptions or editing controls. Staff and resident dialogs fit 390-pixel viewports without horizontal overflow.

`npm run verify:privacy` separately checks the persisted demonstration, model hashes/counts, linked-resident scope, original-image denial, unassigned-guard denial, resident output metadata and the opaque pixels at every cover centre. Evidence: `output/verification/privacy-smoke.json`, `privacy-shared-qa.jpg`, and `output/playwright/privacy-staff-auto-masked.png`, `privacy-staff-review-mobile.png`, `privacy-resident-desktop.png`, `privacy-resident-mobile.png`. This is public test imagery and simulated browser review, not actual resident CCTV or a real physical inspection.

Argon suggestions were independently checked. Expired files were already removed by the shared cleanup stage; superseded previews are now also marked unavailable. Publishing uses single-use receipts after withdrawal, authoritative state is checked inside the write transaction, and detector result fields are explicitly selected. Existing deadline inheritance intentionally prevents retries extending retention. Final resident verification additionally removed internal evidence identity from public screenshot identifiers. All processing remains local, with no GitHub upload.

Detection can miss faces/plates, especially under domain/visibility changes; no independent Malaysian CCTV recall evaluation has been performed. The screenshot preview and manual-cover step remain required. See `docs/privacy-screenshots.md` for actual limits and primary model/sample sources.

---

# Report workflow verification — 15 October 2026

Final `npm run build` passed. Final `npm test`: **64/64 passed**, zero skipped (17 report-workflow tests plus the previous 47). Tests use isolated temporary databases, a loopback model double and actual FFmpeg/MP4/Range operations. They verify software behavior, not visual accuracy.

The added suite covers atomic report/job creation, automatic VLM/index dependencies, camera scoping before ranking, waiting/upload wakeup, retry/lease recovery, report closure during inference, model changes, cross-role/township isolation, bounded preview, session-bound review, changed source/description/camera invalidation, immutable review, invalid-assignee rollback, idempotent create/link/dispatch, approved staff-only clips, ticket revocation after reassignment, resident privacy and retention cleanup.

Separately, the installed **qwen3-vl:2b** and **qwen3-embedding:0.6b** processed an uploaded, visibly labelled synthetic 8-second parking animation. Submitting resident report **JG-20261015-15D71F** automatically queued analysis (audit actor `local-report-worker`), built its index and returned one 2–7-second candidate in **44,443 ms**. No manual Analyse call or predefined description was used. This is one ingestion-to-candidate measurement on this machine, not a general latency target.

Playwright exercised the visible management review/dispatch and property-task workflow: a five-second bounded clip played, approval was disabled until a note and acknowledgement were supplied, approved evidence was linked to a new incident, and the property account accepted, arrived and submitted a result. Management then closed the case. All notes explicitly identify simulated QA; browser automation is not an actual staff review of a real incident.

`npm run verify:report` checks the persisted completed case, real-model provenance, automatic-analysis audit, property assignment/results, public resident progress and private 64-byte Range playback (206). It verifies residents cannot see candidate/clip ids, internal review notes or work instructions, property staff cannot access the raw original and an unassigned guard cannot access the approved clip. Evidence: `output/verification/report-workflow-smoke.json` and screenshots `output/playwright/report-candidate-review.png`, `report-reviewed-dispatch.png`, `property-approved-playback.png`, `property-resolved-case.png`, `report-closed-case.png`.

Resident UI verification showed the closed-case public timeline with no CCTV player, private review or work instructions. At 390 × 844, both resident and management report dialogs had document width 390 pixels without horizontal overflow; the management evidence panel was 326 pixels wide and its preview remained five seconds. Approval remained disabled without a note and acknowledgement. Screenshots: `report-resident-closed-mobile.png`, `report-manager-review-mobile.png`, `report-manager-preview-mobile.png` in `output/playwright/`.

A second synthetic report **JG-20261015-AB3449** is left awaiting review for a hands-on demonstration. `data/report-workflow-demo/manifest.json` describes that pending report; the verification JSON retains the completed QA report. `demo:report` never approves or dispatches candidates. All footage, inference, data and services remain local. Argon reviewed focused code/design text only. No GitHub upload occurred.

After restarting API/worker/web, `npm run verify:report` passed again at 12:03 Malaysia time. The completed case, review, assignment and local model provenance persisted. API (4000), web (5173) and Ollama (11434) were all confirmed listening on `127.0.0.1` only.

These checks do not establish real CCTV precision/recall, complete temporal event recognition, physical inspection, crime reduction or legal compliance. Live ingestion, facial identification, privacy masking and report-based points remain unimplemented.

---

# Local AI verification — 15 October 2026 (earlier search phase)

`npm run build`: passed (TypeScript and Vite). `npm test`: **47/47 passed**, zero skipped. The final suite includes 13 semantic-search integration tests in addition to the original 34 tests. Automated integration tests use a loopback HTTP model double and isolated temporary databases; they establish software behavior rather than model accuracy.

Real-model verification is separate: `npm run smoke:semantic` completed against the installed portable Ollama, **qwen3-vl:2b** and **qwen3-embedding:0.6b** on this Windows machine (RTX 3050 Laptop, 4 GB VRAM). No video or query was sent to a cloud inference service. Model downloads used the official distribution/model repositories; two Argon reviews received design/code text only.

| Real-model query | First candidate | Measured elapsed time |
| --- | --- | ---: |
| 穿红色衣服的人靠近白色汽车 | red-white animation | 4,773 ms |
| A person wearing a blue shirt next to a dark car | blue-dark animation | 4,916 ms |
| 昨晚8点到10点在B区停车场穿红衣的人 | red-white animation | 4,804 ms |

The table records the post-restart repeat (all persisted indexes survived). The earlier run measured 3,527 / 3,778 / 3,537 ms for the same queries.

The relative-date query required confirmation and resolved to **14 October 2026, 20:00–22:00, Asia/Kuala_Lumpur**, with Zone B Parking scope. The three labelled synthetic 8-second MP4 files produced 3 VLM segments, 12 timestamped frame descriptions and 3 persisted semantic vectors. Each observation is tied to an actual sampled frame; the system does not claim continuous action detection. VLM descriptions vary in wording and coarse vehicle type.

The final three-video analysis run included one output-limit failure on the empty scene, which recovered through the bounded retry queue. Analysis takes tens of seconds per short clip and can take longer with retries or queued work. Search timing is measured after indexing; it is not ingestion latency. The model can still fail on other footage, and the UI exposes analysis/index failures.

The same smoke run verified authorised private video access with a 64-byte HTTP Range (206). Playwright verified search results, private sampled previews, desktop layout (1440 px), mobile layout (390 px, document width 390 px), and original-video seeking to **2.667 seconds**. The playback check waited for a decoded frame, not only metadata. Screenshots are under `output/playwright/`.

Provenance, model digests, descriptions, scores and raw timings: `output/verification/local-ai-smoke.json`. Three older predefined fixture videos remain available in explicit keyword mode and are excluded from semantic coverage. Current semantic coverage is 3 indexed / 3 described segments; the 3 older videos need VLM analysis.

Software checks cover model digest/content invalidation, expired/foreign-township exclusion, half-open time intersections, Chinese/English query encoding, explicit date/zone handling, no vector disclosure through bootstrap, model endpoint redirects, cloud model references, membership revocation during an async search, recovered/lost index leases, low-frame-rate sampling, retention cleanup and duplicate/reanalysis jobs.

Argon findings were independently checked. Index heartbeat/progress/commit operations now use transactions and verify live ownership; missing or changed videos/descriptions cannot publish vectors; coverage also checks township ownership. The suggested auth-at-start-only approach was not adopted: search rechecks access after inference.

These three synthetic examples are a smoke test, **not a held-out CCTV accuracy, recall or Top-3 evaluation**. Closest candidates can miss query conditions; scores are rankings rather than confidence. Identity, brand, intent and responsibility remain unverified. Facial recognition, privacy masking and live camera ingestion remain unimplemented; report-to-search was added in the later workflow phase above.

---

# Baseline verification — 14 October 2026


Date: 14 October 2026 (Asia/Kuala_Lumpur). Environment: Windows, Node.js 24.11.1, SQLite WAL, bundled FFmpeg/FFprobe. No cloud calls or GitHub upload were used.

## Automated tests

`npm test`: **34 / 34 passed**, no skipped tests. The last run completed in approximately 4.7 seconds. Test data lives in uniquely created OS temporary directories and is cleaned after each suite; the user's local demonstration data is preserved.

| Suite | Passed | What it establishes |
| --- | ---: | --- |
| API integration | 20 | Login, photo reports, same/different-township object isolation, guard workflow, resident public-only feedback, private media, capacity, attendance idempotency, corrective ledger, disabled sessions, local-origin protection, valid/invalid MP4, date confirmation, searchable fixture timestamps, restricted clips, reassignment revocation and alert review states |
| Video validation | 7 | Strict JSON schema, bounded/ordered timestamps, visible temporal support, allowed event types, prolonged-lying duration, overlap coverage and lexical path confinement |
| Worker reliability | 7 | Exclusive claim, expired lease recovery, three-attempt bound, duplicate completion, honest failure for a real upload without a model, actual original/thumbnail/search cleanup and loopback-only model endpoints |

The integrated video test generates actual synthetic MP4 files, processes them through FFmpeg and the worker, checks original-video offsets, streams a 64-byte HTTP Range from a restricted guard clip, probes its duration, and checks that copying a fixture into the ordinary upload route does not grant fixture status.

## Synthetic fixture processing

- 3 locally generated MP4 files: walking (24 s), bicycle movement (24 s), safe posture change (36 s).
- 7 overlapping timestamped segments and 7 private thumbnails.
- 2 candidate alerts: possible fall at 6–9 s, and sustained lying at 9–36 s. Overlapping lying annotations retain all 3 source segment references.
- All 3 jobs completed in one attempt in the local fixture run.
- Re-running fixture preparation reused existing files and completed jobs without duplicating segments or alerts.

This is authored animation and predefined annotation. It validates software processing and indexing, not visual model detection accuracy.

## Independent review

Two reproduced defects were fixed and covered by tests:

1. A guard could retain private incident/evidence access after an incident was closed, reopened and assigned to another guard. Reopening/reassignment now revokes prior assignment authority while retaining historical outcomes; old tickets are rechecked against current access.
2. Creating an incident through a secondary route could overwrite a dismissed alert's review outcome. That route now requires a pending alert and rejects terminal review states.

Resolved media paths were additionally checked against a Windows directory junction; access outside the private directory was rejected. A one-day retention setting generated the correct expiry, and expiring an evidence clip removed that clip while retaining an unexpired source video.

## Build and browser checks

`npm run build` passed: TypeScript checks and Vite production bundling completed. CSS is approximately 49 KB and JavaScript approximately 263 KB before gzip. The dependency audit reported zero known vulnerabilities after the upload and development-server dependencies were updated.

Actual in-app browser checks passed at the default desktop size and at 390 × 844 for a mobile layout:

- All three role logins and logout.
- One complete report workflow through the visible UI: resident submit → management receive/create/assign → guard accept/arrive/resolve → management close → resident public timeline.
- Report-prefilled Clubhouse/time search returned two bicycle segments. The actual local video element reported duration 24 seconds, currentTime 12 seconds and readyState 4 after opening the 12-second result.
- Activity signup updated occupied places from 0 to 1. Attendance verification changed the past synthetic registration to attended, disabled its duplicate verification button, and showed 30 points in the resident account.
- Mobile navigation opens and closes; the collapsed side panel is excluded from the accessibility tree. No horizontal page overflow was observed (390-pixel viewport, 375-pixel content width including scrollbar allocation).
- Desktop and mobile layouts were visually inspected. A previously inaccessible logout button and incorrect greeting timezone were corrected during these checks.

The visible test created one clearly named synthetic report/incident, completed it, enrolled the demo resident in the facilities walk and awarded their past synthetic training attendance. These demonstration records remain available locally for inspection.

Screenshots: [management desktop](screenshots/management-desktop.jpg), [resident mobile](screenshots/resident-mobile.jpg).

## Not established

- Detection precision, recall, false alarms per hour or real search Top 3 performance.
- Genuine local-model inference: no Ollama executable/model was present in the inspected environment.
- Live CCTV processing, 24-hour availability, continuous-run resource behaviour or production readiness.
- Real-world crime reduction, customer adoption, partner agreements or user interview findings.

No numerical claims about those outcomes should be inferred from the software tests.
