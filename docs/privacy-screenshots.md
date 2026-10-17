# Local screenshot masking · 15 October 2026

Staff evidence photos now produce a separate private screenshot copy with detected faces and plates covered. Staff review that copy, add any missing covers, and explicitly send it to residents whose reports are linked to the incident. Originals stay in internal evidence. This delivery covers still screenshots; it does not redact entire videos or identify people or plate numbers.

## Use the workflow

1. Sign in as **Property team**, open **My assignments**, and open an assigned incident. Upload one to three JPEG, PNG or WebP evidence photos using **Add evidence photos**. Local masking starts automatically. Management can also prepare a copy of an existing evidence photo.
2. Under **Share a privacy-masked screenshot**, wait for Ready and choose **Review masked screenshot**. All detected faces and plates are covered, including those of the reporting resident; no identity classification is performed. A region count of zero is not proof that nothing sensitive is visible.
3. Drag on the preview to add extra opaque covers. **Undo extra cover** removes an unsaved additional cover; automatic covers stay in place. **Cover entire image** is available. Apply extra covers and reopen the resulting preview. Up to 40 extra rectangles are allowed.
4. Write a public resident caption and confirm you checked the screenshot. **Send masked screenshot to residents** publishes only the reviewed copy in **Treatment screenshots** on linked residents' reports and incident progress. No email, external message or remote upload is sent.
5. **Withdraw resident screenshot** removes resident access. Previously issued server tickets are rechecked on use. Sending after withdrawal requires opening a fresh preview. Unshared Ready copies can be rebuilt with **Rebuild local masking**.

The local sample is **[Privacy QA] Screenshot handoff**, report **JG-20261015-FE00CD**. It uses public test imagery with one detected face, one detected plate and an extra cover applied through the browser. Its caption explicitly states that no real inspection occurred. The previous report/retrieval demos remain intact.

## Local setup and models

The machine already has Python 3.13, NumPy 2.2.6, OpenCV 4.11, ONNX Runtime 1.20.1 and Pillow 11.2.1. `PRIVACY_PYTHON` can select a local Python executable. For a new machine, install `scripts/requirements-privacy.txt` and run:

```powershell
npm run privacy:setup
npm run dev
```

Setup downloads and checks these files into `.runtime/privacy-models/`. Runtime verifies them again and never downloads models or calls a remote inference endpoint. CPU inference avoids competing for the local VLM's GPU memory.

| Model | Source | SHA-256 |
| --- | --- | --- |
| YuNet face detector, March 2023 | [OpenCV Zoo](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) | `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4` |
| YOLOv9-t 640 plate detector, end-to-end ONNX | [Open Image Models](https://github.com/ankandrew/open-image-models) | `c3c1026ca7d0585dd88084d68182dd897113712fa734ae1557ca70174440c076` |

Upstream license notices are saved under `docs/licenses/`. The face test image comes from [scikit-image's public-domain astronaut sample](https://scikit-image.org/docs/0.25.x/api/skimage.data.html#skimage.data.astronaut); the vehicle sample comes from [fast-alpr's test asset](https://github.com/ankandrew/fast-alpr/blob/master/assets/test_image.png). Their local composite is marked **LOCAL PRIVACY QA**, and its file-source manifest is in `.runtime/privacy-test-assets/sources.json`. No resident image was supplied to Argon; its review used implementation text only.

## Processing and boundaries

- Still images only, at most 8 MB per upload and 24 megapixels decoded; output is at most 1600 pixels per side. EXIF orientation is applied, transparency flattened on white, and the output is a new JPEG without source metadata. Animated GIF/APNG/WebP inputs are withheld rather than sharing one unexamined frame.
- Local detectors use conservative padded boxes and solid pixel replacement. This is detection for concealment, with no face database, face embeddings or plate OCR. Poor lighting, distant objects, unusual plates and occlusion can cause misses; Malaysian CCTV recall has not been measured. Staff must inspect the copy, including any other sensitive content or text.
- Original evidence and preview are separate private media records. The resident serializer returns an opaque public screenshot identity, copy media id, caption and time. It omits source ids, internal evidence descriptions, masks, model output and worker errors.
- Preview receipts expire in 15 minutes and bind reviewer, session, draft revision and copy media. Exact duplicate sharing requests do not duplicate records. Rebuilding/applying masks invalidates old receipts and publications, marks old preview files for deletion, and requires reviewing the new version.
- Worker claims use transactions, leases, heartbeat, bounded attempts and recovery. Source hashes are checked before/after processing and again before preview/sharing/resident playback. Model failures produce explicit pending/failed states; no original-image fallback exists.
- New evidence photos and derived copies use the same configurable retention deadline (default seven days). Old photos without a deadline receive a seven-day copy deadline when first prepared; retries do not extend it. The normal worker cleanup removes expired originals/copies and superseded previews; human share/withdraw audit remains. Withdrawal revokes resident access while retaining private evidence until its retention deadline.

## Verification

`npm run build` and all **77 tests** passed, including 13 screenshot privacy integration tests. The suite covers real opaque pixel replacement/EXIF removal, original isolation, linked-resident and assignment scopes, preview session binding, review gating, idempotency, withdrawal, revision/source invalidation, retries, lost leases and retention. Workflow tests otherwise use a detector double; real face/plate inference is checked separately on the public test composite.

Playwright exercised upload → automatic masking → preview → drag extra cover → apply/reopen → review/share → resident display. Both staff and resident dialogs fit a 390-pixel viewport without horizontal overflow. Screenshots are in `output/playwright/privacy-*.png`.

After exercising that labelled demo, `npm run verify:privacy` performs read-only business checks and downloads the **already-local** resident copy through its authorized local endpoint for pixel/metadata verification. It saves `output/verification/privacy-smoke.json` and `privacy-shared-qa.jpg`. The command does not approve, share or withdraw anything. `npm run demo:privacy` creates/reuses the labelled case and assignment; it does not upload or publish images.

These are software and small-sample checks, not an accuracy benchmark or a claim of legal compliance. No GitHub upload, cloud deployment or cloud image processing occurred.
