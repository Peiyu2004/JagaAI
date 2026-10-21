# JagaAI v3 implementation contract

New code only, staged under `jagaai/v3`. Do not change the legacy project or its data.
Python API 127.0.0.1:8766, Vite 127.0.0.1:5174 proxies `/api` to it.
JSON uses snake_case. IDs are strings. Dates are timezone-aware UTC ISO strings.
The UI formats dates in Asia/Kuala_Lumpur. Staff statuses are English lowercase values.
Errors: HTTP appropriate status with `{"detail":"message"}`. All APIs below are under `/api`.

## Types

- User: id, email, name, role (`resident`/`guard`/`manager`/`admin`), unit. The role is assigned
  by the server and decides which workspace opens; nobody picks a role at sign-in.
  Accounts listings add status (`active`/`pending`/`disabled`), phone, created_at.
- Location: id, name, aliases (string[]), map_area (number[])
- Camera: id, name, location_id, status, source_type, rules (object), stream_url (password masked as `***`), stream_enabled, segment_sec, live (recorder status or null)
- Video: id, camera_id, filename, recorded_at, duration_sec, status
  (`uploaded`/`queued`/`processing`/`ready`/`failed`), error, analysis_source,
  description_status, expires_at. Media: `/api/videos/{id}/media`.
- Event: id, video_id, camera_id, type (`vehicle_loitering`/`restricted_entry`),
  start_sec, end_sec, metrics (object), rule_id, rule_version, verification,
  keyframes (string[]), created_at. No fall events.
- Alert: id, event_id, status (`pending`/`confirmed`/`dismissed`), priority
  (`urgent`/`high`/`normal`), dismiss_reason, created_at, event (Event object)
- Lead: id, location_id, time_from, time_to, text, status (`received`/`in_progress`/`resolved`/`invalid`),
  public_reply, incident_id, created_at, photo_url. Never expose resident_id in public responses.
- Guard: id, name, shift, phone, notification_opt_in. A dispatch contact for notifications;
  guards who sign in have a separate User account with role `guard`.
- Task: id, title, detail, location_id, priority, status (`open`/`in_progress`/`done`),
  assignee_id, created_by, source (`alert:<id>`, `lead:<id>` or free text), note, created_at, updated_at.
- Activity: id, title, description, location, starts_at, capacity (nullable), points,
  status (`published`/`cancelled`), signup_count, joined, attended; managers also see attendees.
- PointEntry: id, points (negative for redemptions), reason, created_at.
- Incident: id, title, location_id, priority, status (`open`/`assigned`/`resolved`/`closed`),
  guard_id, outcome, created_at, updated_at, evidence (object[]), timeline (object[]).

## Auth and bootstrap

Access levels below: **staff** = guard, manager or admin; **manager** = manager or admin;
**admin** = admin only; **resident** = resident only. Disabled or pending accounts lose access at once.

- GET `/health` public: status, service, ai (object). Never claims a model is ready without checking.
- GET `/auth/me`: `{user: User|null}`. Cookie authentication.
- POST `/auth/login`: `{email,password}` -> `{user}` and HttpOnly session cookie. One sign-in page for every role.
- POST `/auth/register` public: `{name,email,phone,unit,password}` creates a `pending` resident;
  a manager approves it under Accounts before it can sign in.
- POST `/auth/logout`: clears cookie.
- GET `/bootstrap` staff: `{user,locations,cameras,videos,events,alerts,leads,incidents,guards,summary,settings}`.
  No fabricated AI events seeded. `summary` contains alert_count, open_incidents, new_leads,
  median_ack_sec (nullable), video_count, analysed_video_count, pending_video_count.
- GET `/stream` authenticated SSE refresh events (`event: refresh`, JSON data); heartbeat and reconnect.
- GET `/updates` authenticated: `{revision}` for hosts where SSE is unreliable (the Colab build polls this).

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
- PUT `/cameras/{id}/rules` (manager): `{rules:object}` -> Camera; rule IDs R1/R3 only in M1.
- PUT `/cameras/{id}/stream` (admin): `{url?:string|null, enabled:boolean, segment_sec:30|60|120|300}` -> Camera. `url` is `rtsp://`, `rtsps://`, `http(s)://` or `demo:<uploaded video id>` (replays that recording in real time as a simulated camera). Omit `url` to keep the saved address; `""` removes it. A masked address is refused.
- GET `/live` (staff): recorder status for each camera that has a stream address. Each finished segment becomes a Video with `source:"live"` and enters the normal analysis queue.
- GET `/settings` (staff): settings, guards, users (users admin only), audit_logs (admin only).
- PATCH `/settings`: admin-only `{retention_days?,search_threshold?}`.
- POST `/guards` (manager): `{name,shift,phone}`. PATCH `/guards/{id}` same.
- POST `/users`: admin-only `{email,password,name,role}` (`guard`, `manager` or `admin`).
- GET `/leads/{id}/photo` (staff): the photo a resident attached, if any.

## Accounts and tasks

- GET `/accounts` (manager): every account with status. POST `/accounts` (manager):
  `{name,email,phone?,password,role}`; managers create residents and guards, admins also managers and admins.
- PATCH `/accounts/{id}` (manager): `{status?,role?}`, e.g. approve a pending resident or disable an account.
- POST `/tasks` (staff): `{title,detail?,location_id?,priority?,assignee_id?,source?}` -> Task.
- PATCH `/tasks/{id}` (staff): `{status?,assignee_id?,note?}` -> Task.

## Resident workflow

- GET `/resident/context` public: `{locations}` (no surveillance metadata).
- GET `/resident/leads` resident: own leads only, public fields only.
- POST `/resident/leads` multipart: location_id, time_from, time_to, text, optional photo -> public Lead,
  plus `points_awarded` (10 per report, for the first 3 reports of each Malaysian day).
- GET `/resident/leads/{id}` resident: own public Lead only.
- Public Lead fields: id, location_id, time_from, time_to, text, status, public_reply, created_at,
  linked_case (bool: the report joined a case, never which incident).
  Never camera IDs, media, incident outcome/evidence, internal notes, or other residents.

## Activities and points

- GET `/activities` (any signed-in user): upcoming community activities with sign-up counts.
- POST `/activities` (manager): `{title,description?,location,starts_at,capacity?,points?}`.
  PATCH `/activities/{id}` (manager): `{status}` (`published`/`cancelled`).
- POST `/activities/{id}/join` and `/leave` (resident): before the activity starts, within capacity.
- POST `/activities/{id}/attendance` (manager): `{user_id,attended}`; attending awards the activity's points once.
- GET `/resident/points` (resident): `{balance,history,rewards,report_points,report_points_per_day}`.
- POST `/resident/points/redeem` (resident): `{reward_id}`; refused if the balance is too low.

## Guard notifications

Simulation by default; see `docs/guard-notifications.md` for Twilio setup and what is verified.

- GET `/notifications/config` (staff), PUT (admin): policy `{enabled,mode,primary_guard_id,
  escalation_guard_id,call_after_sec,escalate_after_sec,cooldown_sec,...}`.
- GET `/notifications` (staff): dispatch history. POST `/alerts/{id}/notify` (staff): `{guard_id?}` starts a dispatch.
- POST `/notifications/{id}/cancel` and `/acknowledge` (staff).
- POST `/guard/notification` and `/guard/accept` public but scoped: `{dispatch_id,guard_id,token}` from the
  guard's link; shows the alert summary and records acceptance.
- `/notifications/{id}/voice-demo`, `/notifications/voice-demo/{call_id}[/turn|/end]` (staff): the
  in-browser call rehearsal. `/notifications/twilio/*` are Twilio callbacks with signature checks.

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
One sign-in page; staff get the workstation pages their role allows, residents get the phone-first
resident app. No resident-to-staff navigation.
Show an honest empty state if no videos were analysed. Demo label in footer, not repeated chrome.
No R2/fall detection, fake VLM confirmations, identity/intent labels, cloud inference or AGPL packages.
Scope of this implementation: M1 runnable core plus lightweight M2 page shells backed by real data.
Training material may be prepared for M2 but no claim that training/evaluation was completed.
