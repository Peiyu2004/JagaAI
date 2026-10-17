# Five-minute local demonstration

Use the role buttons at login; each selects its local demo account. All named people, issue records, activities and animation footage are synthetic.

## Current addition: privacy-masked treatment screenshots

Choose **Property team → My assignments → [Privacy QA] Screenshot handoff**. The existing public test composite has automatically covered face/plate regions and one extra cover added in browser QA. Use **Review masked screenshot** to inspect it; the already-published copy appears for Resident in report **JG-20261015-FE00CD → Treatment screenshots**. Uploading a new still evidence photo automatically prepares another private copy. Staff must preview, add any missing covers, write a public caption and acknowledge review before sending. **Withdraw resident screenshot** removes resident access. Full steps, model setup and limits are in [privacy-screenshots.md](privacy-screenshots.md).

## Current flow: resident report → local AI → reviewed evidence → property work order

1. Start `npm run dev` and open http://127.0.0.1:5173. Choose **Management**. Open **Community reports** and report **JG-20261015-AB3449** at Zone B Parking. This pending synthetic report is ready for review; no action has been approved for you.
2. In **Report → footage → response**, check the displayed Malaysia-time scope and coverage. Click **View bounded clip**. The five-second excerpt comes from seconds 2–7 of an eight-second animation; compare visible red clothing/white vehicle with the model's description and limitations.
3. Write an evidence note stating what is visible and uncertain, tick **I have reviewed this clip and its visibility limits**, and approve or dismiss. To continue this simulated demo, approve a relevant clip; do not infer damage, identity, intent or responsibility from it.
4. In **Link evidence & dispatch**, create a clearly labelled synthetic incident (or select an active same-location case), choose **Ravi · Demo property team**, set priority and write simulated inspection instructions. Click **Link approved clips & dispatch** once. The linked evidence and work order commit together; exact duplicate requests reuse the dispatch.
5. Sign out, choose **Property team**, and open **My assignments**. Play the approved bounded clip, accept the assignment, mark arrival and submit a result. Label notes as synthetic testing: no physical inspection has taken place. This account has no global footage search or access to the original eight-second recording.
6. Management opens the incident and closes it after reviewing the result. Resident opens the linked report to see public progress; footage, AI review notes and work instructions remain private.

To demonstrate the automatic stage from a new submission, run `npm run demo:report -- --new-report` while services are running. It reuses the labelled uploaded video and submits another resident report without approving or dispatching it. The first run uploaded a fresh copy and automatically triggered real local VLM analysis plus indexing in about 44.4 seconds; later runs may reuse completed analysis. Manifest: `data/report-workflow-demo/manifest.json`.

For a manual submission, use Resident → **My reports** with Zone B Parking and the uploaded video's actual recording window (the prepared demo uses 14 October 2026, 21:00:02–21:00:07, Malaysia time). The worker starts automatically. An unrelated location/time waits for matching recordings; there is no live camera feed. On another day, check the manifest/window and retention rather than assuming yesterday's media is still available.

The already completed synthetic QA case remains available separately as report **JG-20261015-15D71F**. Run `npm run verify:report` to read its verification result; this command does not perform review, dispatch or state transitions. Screenshots and results are in `output/playwright/` and `output/verification/report-workflow-smoke.json`.

The sections below retain the earlier baseline demonstrations.

---

## 1. Resident report → official follow-up

1. Sign in as Resident. Open Reports and submit a maintenance issue with a location, time interval and optional photograph.
2. Sign out; sign in as Management. Open the new report, create an incident or link an existing one, and assign the demo guard.
3. Sign in as Guard. Open My tasks, accept, mark arrival and submit a public result.
4. Management reviews the result and closes the incident with a note.
5. Resident opens their report to see public progress. Internal notes and other residents' reports are excluded by the server.

## 2. Report → candidate footage

1. Management opens the seeded bicycle report (`JG-DEMO-001`) and uses Search footage.
2. The report supplies its Clubhouse location and recorded time interval. Search the locally indexed bicycle animation.
3. Open the matching segment; playback seeks to its offset in the actual local MP4.
4. The result says an animated person moves a bicycle. Ownership and permission cannot be inferred.

## 3. Candidate alert → human review

1. Open Alerts for review. The safe posture-change animation generates `possible_fall` and `prolonged_lying` fixture candidates.
2. Read evidence and uncertainty, and play the corresponding local source.
3. Confirm into an official incident, associate an existing incident, or dismiss with a reason.
4. If assigned to a guard, provide only the authorised evidence clip. Residents do not receive CCTV.

This is an animation and a predefined annotation. It verifies the queue, timestamp, review and assignment workflow; it does not validate a real fall detector.

## 4. Participation → contribution

1. Resident joins an upcoming facilities walk. Capacity and duplicate signup are checked in a transaction.
2. Management opens the past synthetic safety training and verifies the pre-registered resident's attendance.
3. Repeat verification: the resident still has only one 30-point award.
4. Resident views the ledger. A later cancellation preserves the award and records a correcting entry.

## 5. State the evidence

Show `docs/test-results.md`: software permissions, concurrency and failure paths were tested. Real camera footage, model detection accuracy, user interviews, live ingestion and 24-hour stability have not been validated. Do not present synthetic fixtures as live CCTV or measured AI performance.
