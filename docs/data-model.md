# Local data model

## Screenshot privacy additions (15 October 2026)

`privacyDrafts` stores one durable draft per still incident evidence photo: source hash/media, revision, extra normalized masks, model/count/region provenance, private preview media, retention deadline, status/attempts/owner/lease and processing errors. Upload and initial queue share a transaction. Revisions never replace a preview file in place; old copies are marked unavailable and removed by media cleanup.

`privacyViews` stores hashed, 15-minute preview receipts bound to user/session/draft/revision/copy. A used receipt permits exact idempotent retries of its current publication, but cannot republish after withdrawal. `screenshotShares` records a reviewed revision, its private copy media, public caption, actor/time and published/withdrawn/expired state. Audit remains after media cleanup.

Media records with `privacyDraftId`/`privacyRevision` require current source/version validation. Residents can request only published copies from incidents linked to their own reports. Their DTO includes an opaque public screenshot id, copy id, caption and share time, with no source/draft/evidence ids or detector details. Original evidence and CCTV remain private. Staff scope is rechecked against current assignment, including when using an earlier ticket.

---

SQLite `documents(kind,id,townshipId,data)` stores JSON documents. `(kind,id)` is unique. An index covers `(kind,townshipId)`. WAL permits independent API and worker connections; `BEGIN IMMEDIATE` serializes critical writes. All SQL value binding uses parameters.

| Kind | Identity / contents |
| --- | --- |
| users | User ID, email, salted password hash, role, active membership, township |
| sessions | Hashed opaque cookie token, user ID, expiry; raw cookie never stored |
| townships / locations / cameras | Township-scoped places and upload cameras |
| reports | Report ID and human number, reporter, time interval, photo IDs, public progress, incident reference |
| incidents | Official issue, location, priority, state, report and alert links |
| assignments | Incident, assigned guard/property staff, team, instructions, accepted/arrived times, result |
| incidentUpdates | Author, action, internal/public visibility, note, UTC timestamp |
| media | Private disk path, MIME type, owner/object links, expiry |
| mediaTickets | Opaque ticket authorization, session binding and short expiry |
| videos | Camera, recorded UTC start, duration, source, processing status, retention |
| analysisJobs | Video/version, durable state, attempts, owner and lease, errors/backoff |
| segments | Original-video offset range, absolute start, observations, analysis source/version |
| alerts | Candidate type, source segments, visible evidence, uncertainty, human review state |
| activities | Title, type, place, UTC start/end, capacity, points and publish state |
| registrations | One activity/user pair, registration and verification state |
| pointTransactions | Immutable award or corrective ledger, unique idempotency key |
| auditLogs | Actor, action, target and UTC timestamp; tokens omitted |

## Business invariants

- User role and township come from the server-side session and membership record, not the request body.
- Residents receive only their own reports and public incident progress. Guards/property staff receive assigned work and specifically linked evidence. Management permissions remain township-scoped.
- Reports, AI alerts and official incidents are distinct. Linking several sources to one incident avoids duplicate assignment.
- Internal notes are excluded from resident serializers. Photograph access checks report ownership or assigned task membership. CCTV access is management-only except specifically assigned event evidence.
- Attendance award and registration state update share one transaction. Capacity check and signup write share one transaction. Retry or duplicate attendance verification cannot issue another award.
- Segment timestamps use seconds in the original source. `absoluteStartAt` equals recording time plus segment start offset. Display converts UTC to Asia/Kuala_Lumpur.
- Worker writes use deterministic per-video/version segment identities and merge overlapping event intervals. Runtime failures retain an explicit failed state; no empty fabricated result is substituted.
- Synthetic sources are verified by SHA-256 against the local authored fixture manifest. Model name, source mode, prompt version and analysis version remain separate from human decisions.

SQLite is the local replacement for the plan's Firestore. It does not imply a Firebase project, cloud security rules or a deployed service exists.


## Local semantic retrieval additions (15 October 2026)

`segments` now stores real-model sampled descriptions/uncertainties, observation offsets, `analysisMode`, `analysisVersion`, `promptVersion`, `sampleCount`, model name and model digest. Search only uses the active analysis version and nonexpired, authorised originals. Observations represent individual sampled frames, not continuous event durations. Reviewed alerts retain their evidence snapshots.

`segmentEmbeddings` is a separate document kind, keyed by segment id, containing township/video/segment ids, embedding model/digest/dimension, a unit vector, a hash of the indexed description and creation time. Vectors are never included in bootstrap. SQLite JSON vectors and exact cosine ranking suit this local demo scale; this is not a benchmark for township-scale concurrency.

`indexJobs` stores one durable per-video indexing state: queued/processing/completed/failed, attempts, next retry, owner/lease, progress, error, model digest and timestamps. Heartbeats/progress/commit validate live ownership in transactions. A video can have a completed VLM analysis and a pending/failed index; coverage exposes that distinction. Retention removes vectors and index jobs with the original media and descriptions.

## Report-triggered retrieval additions (15 October 2026)

| Kind | Identity / contents |
| --- | --- |
| reportSearchJobs | Stable per-report identity, generation, query/time/location scope, coverage, queued/waiting/processing/completed/failed/cancelled state, owner/lease, attempts and dependency retries |
| reportCandidates | Report/generation/segment identity, bounded source offsets and absolute time, camera/source/description hashes, VLM summary and uncertainty snapshot, rank score, pending/approved/dismissed decision, human note/by/time |
| candidateViews | Hashed opaque receipt, reviewer and session binding, candidate/source snapshot, 15-minute expiry and review-use time |
| reportDispatches | One per report, request fingerprint, approved candidate ids, incident/assignment ids, dispatch actor/time |
| incidentEvidence | Approved candidate and report reference, bounded private media id, source offsets, AI snapshot and human review note; unavailable marker after expiration |

Report creation and its initial retrieval job share a transaction. Analysis/index queues are reused and woken when dependencies change. Waiting for media is distinct from a failed inference. A cancelled/closed report cannot publish a late asynchronous result. Registered camera scope is applied before vector ranking. Candidate source, description version, report scope, generation, retention and current camera registration are rechecked at preview/review/dispatch.

Preview media is private to management until an explicit dispatch attaches it to an incident; it inherits the source deadline. A staff member's current assignment grants only that evidence clip, and reassignment revokes old access/tickets. The dispatch transaction links or creates the incident, links the report, grants evidence access, creates the assignment and adds internal/public updates together. Retries cannot leave duplicate or partially linked work orders. Resident DTOs omit candidate ids, private evidence, internal notes and work instructions.

Retention purges expired candidate descriptions, observations, ranking data and AI evidence text along with media. Human review notes, decisions and case audit remain. No raw cookie or review token is stored in manifests or audit logs.
