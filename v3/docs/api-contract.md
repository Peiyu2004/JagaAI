# JagaAI v3 implementation contract

New code only, staged under `jagaai/v3`. Do not change the legacy project or its data.
Python API 127.0.0.1:8766, Vite 127.0.0.1:5174 proxies `/api` to it.
JSON uses snake_case. IDs are strings. Dates are timezone-aware UTC ISO strings.
The UI formats dates in Asia/Kuala_Lumpur. Staff statuses are English lowercase values.
Errors: HTTP appropriate status with `{"detail":"message"}`. All APIs below are under `/api`.

## Types

- User: id, email, name, role (`admin`/`supervisor`/`resident`)
- Location: id, name, aliases (string[]), map_area (number[])
- Camera: id, name, location_id, status, source_type, rules (object)
- Video: id, camera_id, filename, recorded_at, duration_sec, status
  (`uploaded`/`queued`/`processing`/`ready`/`failed`), error, analysis_source,
  description_status, expires_at. Media: `/api/videos/{id}/media`.
- Event: id, video_id, camera_id, type (`vehicle_loitering`/`restricted_entry`),
  start_sec, end_sec, metrics (object), rule_id, rule_version, verification,
  keyframes (string[]), created_at. No fall events.
- Alert: id, event_id, status (`pending`/`confirmed`/`dismissed`), priority
  (`urgent`/`high`/`normal`), dismiss_reason, created_at, event (Event object)
- Lead: id, location_id, time_from, time_to, text, status (`received`/`in_progress`/`resolved`),
  public_reply, incident_id, created_at, photo_url. Never expose resident_id in public responses.
- Guard: id, name, shift, phone. Guards have no login accounts.
- Incident: id, title, location_id, priority, status (`open`/`assigned`/`resolved`/`closed`),
  guard_id, outcome, created_at, updated_at, evidence (object[]), timeline (object[]).

## Auth and bootstrap

- GET `/health` public: status, service, ai (object). Never claims a model is ready without checking.
- GET `/auth/me`: `{user: User|null}`. Cookie authentication.
- POST `/auth/login`: `{email,password}` -> `{user}` and HttpOnly session cookie.
- POST `/auth/resident`: `{email,code}` -> `{user}` and cookie. Development-only fixed code
  `246810` explicitly labelled on the resident login page. No external email is sent.
- POST `/auth/logout`: clears cookie.
- GET `/bootstrap` staff: `{user,locations,cameras,videos,events,alerts,leads,incidents,guards,summary,settings}`.
  No fabricated AI events seeded. `summary` contains alert_count, open_incidents, new_leads,
  median_ack_sec (nullable), video_count, analysed_video_count, pending_video_count.
- GET `/stream` authenticated SSE refresh events (`event: refresh`, JSON data); heartbeat and reconnect.

## Staff workflow

- POST `/alerts/{id}/review`: `{action:"confirm"|"dismiss"|"link",dismiss_reason?,incident_id?}`
  -> `{alert,incident?}`. Confirm creates/links incident atomically; dismiss needs a reason.
- POST `/incidents`: `{title,location_id,priority,guard_id?,alert_id?,lead_id?}` -> Incident.
- PATCH `/incidents/{id}`: `{status?,guard_id?,outcome?,public_reply?}` -> Incident.
- POST `/leads/{id}/link`: `{incident_id}` -> Lead.
- PATCH `/leads/{id}`: `{status?,public_reply?}` -> Lead.
- POST `/search`: `{query,location_id?,time_from?,time_to?}` ->
  `{supported:bool,message,interpreted:{location_id,time_from,time_to,behaviour,appearance},
    events:Event[],related:object[],nearest:object[],coverage:{analysed,total,pending},threshold:number}`.
  Related entries: video_id, camera_id, start_sec, end_sec, text, score, model, analysis_source.
  Unsupported fighting/fall/theft-intent explicitly reported, not empty-match wording.
- POST `/videos` multipart: file, camera_id, recorded_at (ISO) -> Video.
- POST `/videos/{id}/analyse` -> Video (queued, idempotent).
- GET `/videos/{id}/media`: staff-only Range capable original MP4, audited.
- PUT `/cameras/{id}/rules`: `{rules:object}` -> Camera; rule IDs R1/R3 only in M1.
- GET `/settings`: settings, guards, users (users admin only), audit_logs (admin only).
- PATCH `/settings`: admin-only `{retention_days?,search_threshold?}`.
- POST `/guards`: admin-only `{name,shift,phone}`. PATCH `/guards/{id}` same.
- POST `/users`: admin-only `{email,password,name,role}` (`admin` or `supervisor`).

## Resident workflow

- GET `/resident/context` public: `{locations}` (no surveillance metadata).
- GET `/resident/leads` resident: own leads only, public fields only.
- POST `/resident/leads` multipart: location_id, time_from, time_to, text, optional photo -> public Lead.
- GET `/resident/leads/{id}` resident: own public Lead only.
- Public Lead fields: id, location_id, time_from, time_to, text, status, public_reply, created_at.
  Never camera IDs, media, incident outcome/evidence, internal notes, or other residents.

## Worker boundary (root agent owns)

Backend uses SQLModel and exposes `app.worker.process_video(video_id)` lazily to a background
worker. Root implements this module plus `app.vision` and `app.search`.
Do not auto-call the worker until implemented; use a lazy import with a clear queued state.
Root search signature: `search(session, payload: dict) -> dict`, `parse_query(query, locations,
now=None) -> dict`. Backend passes its SQLModel session and calls this from POST /search.
Root vision code writes using backend model classes. Backend agent must send model/module
names and field details promptly. Model directory: `../../.runtime` relative to v3.
Use a fresh SQLite DB at `v3/data/jagaai-v3.sqlite`; never open or migrate the legacy database.

## Product and verification

Use the approved standalone HTML as visual reference, not as legacy application code.
React + TS + Tailwind + shadcn/ui components, lucide icons, offline embedded/local IBM Plex fonts.
Eight management pages plus a genuinely separate resident route. No resident-to-admin navigation.
Show an honest empty state if no videos were analysed. Demo label in footer, not repeated chrome.
No R2/fall detection, fake VLM confirmations, identity/intent labels, cloud inference or AGPL packages.
Scope of this implementation: M1 runnable core plus lightweight M2 page shells backed by real data.
Training material may be prepared for M2 but no claim that training/evaluation was completed.
