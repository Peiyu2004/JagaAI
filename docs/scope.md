# Scope update — still screenshot privacy, 15 October 2026

Added automatic local face/plate detection and opaque masking for incident evidence screenshots, plus staff preview, extra covers, explicit publication and withdrawal. Linked residents receive only the reviewed image copy and public caption. They cannot access the original evidence, processing data or internal review interface. Detection failures withhold sharing; changes invalidate old revisions/tickets. Source and derived media retention is enforced.

This phase covers still JPEG/PNG/WebP screenshots, not full-video anonymization, identity recognition, plate OCR or a legal-compliance certification. Models, photos, inference and business data remain on this computer. Runtime has no remote inference or download fallback. The older scope records below are historical; their privacy-masking exclusions are superseded here. See `docs/privacy-screenshots.md`.

---

# Scope update — report-triggered retrieval, 15 October 2026

Resident submissions now trigger durable local footage retrieval, including any missing VLM analysis and indexing. Management reviews private bounded candidates and explicitly links approved evidence to a new/existing incident and a property/security assignment. A fourth role, property team (`maintenance`), uses the assigned-task workflow. Residents receive sanitized retrieval progress and public case updates, without recordings or internal review details.

Retrieval covers uploaded, unexpired recordings from cameras registered at the report's exact location in the same township. There is no geographic-radius lookup or live RTSP ingestion. A point time expands by two minutes either side; a submitted interval is limited to 31 days. Each run covers at most 50 recordings and returns at most three nonoverlapping candidate clips, constrained to the report window. Coverage gaps/failures remain explicit. Waiting jobs can resume after a matching upload; manual incident handling remains available.

Approval requires opening a scoped clip, a review note and an explicit acknowledgement. The 15-minute receipt is bound to the reviewer session and current source/description snapshot. Dispatch revalidates current source/scope and commits evidence, report link and assignment atomically. One dispatch is recorded per report; exact retries reuse it, and subsequent reassignment uses the incident workspace. Assigned staff receive approved clips only. Retention removes clip files and AI text while preserving human decisions.

The local-only execution boundary remains unchanged. No GitHub, cloud database or cloud inference was introduced. Privacy masking, face identification, automatic points, production provisioning and real-world CCTV accuracy validation remain outside this phase.

---

# VLM/search scope update — 15 October 2026

The revised proposal's local VLM and semantic-search phase is implemented. Real local vision captions and multilingual embeddings replace the default keyword experience when configured with `AI_MODE=ollama`. Explicit keyword mode remains available for baseline synthetic fixtures. Semantic retrieval is management-only, township-scoped, expiration-aware, and returns unverified candidates linked to private original playback. Runtime/model setup, limitations and validation are in README and docs/test-results.md.

The baseline scope below is retained for historical context; its statements that local vision is merely optional/uninstalled, search is keyword-only, or only three roles exist are superseded by these updates. Other proposed modules are outside this delivery.

---

# Local MVP scope

The user's instruction is the execution boundary: develop on this computer only, never upload to GitHub. The supplied development plan is a requirements reference, not permission to create cloud projects, contact people, publish a site or upload CCTV to an AI service.

## Implementation choices

- React + TypeScript + Vite front end, Express + TypeScript API and independent Node worker.
- SQLite WAL replaces Firestore for this local prototype. Private disk files replace Cloud Storage. Password hashes and expiring, HttpOnly cookie sessions replace Firebase Authentication.
- API, front end and worker are bound to the loopback interface. Browser assets, icons and fonts are bundled locally. Runtime does not call a cloud service.
- Three roles and township/object authorization are enforced on the server for each business and media request. Deactivated members cannot use old sessions or media tickets.
- Synthetic records and captioned synthetic videos support a repeatable demonstration. Predefined fixture analysis is clearly labelled and is keyed by file content. It does not demonstrate visual model accuracy.
- The optional visual adapter uses an already installed local Ollama model. Only loopback destinations are accepted. A real uploaded video without a configured local vision model fails with an actionable message.
- CCTV ingestion is MP4 upload and playback. Live cameras and 24-hour operation are outside this delivery.

## Local acceptance

1. A resident can submit a report and photo, management can link and assign an incident, a guard can accept/arrive/resolve, management can close, and the resident sees public progress.
2. A synthetic MP4 can pass real format probing, enter the durable worker queue, create timestamped fixture search records and labelled candidate alerts, and play at a result timestamp.
3. Management can publish an activity, residents can join within capacity, attendance verification can award a single ledger entry, and duplicate verification cannot award twice.
4. Access and object isolation are verified by integration tests. Media is never exposed as a static public folder. Worker state survives an interrupted lease.

## Work requiring external evidence

- Authorised camera footage and a labelled, independent holdout set.
- Local vision model installation and real footage evaluation; no accuracy, recall, cost or latency claims until measured.
- Property management / guard interviews, authorisation, privacy arrangements and responsibility assignment.
- Longer soak testing and actual live CCTV integration.
- A later decision about cloud services, if the user chooses to change the local-only boundary.
