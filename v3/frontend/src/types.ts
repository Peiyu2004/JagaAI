export type Role = "resident" | "guard" | "manager" | "admin";
export type User = {
  id: string;
  email: string;
  name: string;
  role: Role;
  unit?: string;
};
export type Account = User & {
  status: "active" | "pending" | "disabled";
  phone: string;
  created_at: string;
};
export type Task = {
  id: string;
  title: string;
  detail: string;
  location_id: string | null;
  priority: string;
  status: "open" | "in_progress" | "done";
  assignee_id: string | null;
  created_by: string | null;
  source: string;
  note: string;
  created_at: string;
  updated_at: string;
};
export type StaffMember = { id: string; name: string; role: Role };
export type Activity = {
  id: string;
  title: string;
  description: string;
  location: string;
  starts_at: string;
  capacity: number | null;
  points: number;
  status: "published" | "cancelled";
  signup_count: number;
  joined: boolean;
  attended: boolean;
  attendees?: { user_id: string; name: string; unit: string; attended: boolean }[];
};
export type PointsSummary = {
  balance: number;
  history: { id: string; points: number; reason: string; created_at: string }[];
  rewards: { id: string; name: string; points: number }[];
  report_points: number;
  report_points_per_day: number;
};
export type Location = {
  id: string;
  name: string;
  aliases: string[];
  map_area: number[];
};
export type Rule = {
  enabled?: boolean;
  loiter_sec?: number;
  window_sec?: number;
  min_vehicles?: number;
  min_dwell_sec?: number;
  active_start?: string;
  active_end?: string;
  zone?: number[][];
  line?: number[][] | null;
};
export type LiveStatus = {
  running: boolean;
  started_at: string | null;
  last_segment_at: string | null;
  segments: number;
  skipped: number;
  error: string | null;
  restarts: number;
};
export type Camera = {
  id: string;
  name: string;
  location_id: string;
  status: string;
  source_type: string;
  rules: Record<string, Rule>;
  stream_url?: string | null;
  stream_enabled?: boolean;
  segment_sec?: number;
  live?: LiveStatus | null;
};
export type Video = {
  id: string;
  camera_id: string;
  filename: string;
  source?: string;
  recorded_at: string;
  duration_sec: number;
  status: string;
  error?: string;
  analysis_source?: string;
  description_status?: string;
  expires_at?: string;
  thumbnail_url?: string | null;
  analysis_metrics?: Record<string, unknown>;
  processed_at?: string;
};
export type Event = {
  id: string;
  video_id: string;
  camera_id: string;
  type: string;
  start_sec: number;
  end_sec: number;
  metrics: Record<string, unknown>;
  rule_id: string;
  rule_version: string;
  verification: unknown;
  keyframes: string[];
  created_at: string;
};
export type AlertScene = {
  text: string;
  model: string;
  observed_at_sec: number;
  offset_sec: number;
  keyframe_url: string | null;
};
export type Alert = {
  id: string;
  event_id: string;
  status: string;
  priority: string;
  dismiss_reason: string;
  created_at: string;
  event: Event;
  scene?: AlertScene | null;
};
export type Lead = {
  id: string;
  location_id: string;
  time_from: string;
  time_to: string;
  text: string;
  status: string;
  public_reply?: string;
  incident_id?: string;
  linked_case?: boolean;
  // Only on the response to sending a report.
  points_awarded?: number;
  created_at: string;
  photo_url?: string;
};
export type Guard = { id: string; name: string; shift: string; phone: string; notification_opt_in: boolean };
export type Incident = {
  id: string;
  title: string;
  location_id: string;
  priority: string;
  status: string;
  guard_id?: string;
  outcome?: string;
  created_at: string;
  updated_at: string;
  evidence: Record<string, unknown>[];
  timeline: Record<string, unknown>[];
};
export type Settings = { retention_days: number; search_threshold: number };
export type NotificationPolicy = {
  enabled: boolean;
  mode: "simulate" | "live";
  primary_guard_id: string | null;
  escalation_guard_id: string | null;
  call_after_sec: number;
  escalate_after_sec: number;
  cooldown_sec: number;
  urgent_call: boolean;
  sms_fallback: boolean;
  voice_language: "zh-CN" | "en-US";
};
export type NotificationConfig = {
  policy: NotificationPolicy & { id?: string };
  provider: { ready: boolean; missing: string[]; channels?: { whatsapp: boolean; voice: boolean; sms: boolean } };
};
export type NotificationAttempt = {
  id: string; stage: string; channel: "whatsapp" | "voice" | "sms";
  guard_id: string; guard_name: string; due_at: string; status: string;
  provider_status: string; error: string; updated_at: string;
  history: {status: string; at: string}[];
};
export type GuardDispatch = {
  id: string; alert_id: string; incident_id: string | null; mode: "simulate" | "live";
  title: string; location: string; priority: string; status: string; reason: string;
  primary_guard_id: string; primary_name: string; escalation_guard_id: string | null; escalation_name: string;
  acknowledged_by: string | null; acknowledged_name: string; acknowledged_at: string | null;
  acknowledged_via: string; recorded_by: string; created_at: string; expires_at: string;
  attempts: NotificationAttempt[]; preview_url?: string;
  voice_language: "zh-CN" | "en-US";
  voice_calls: VoiceCallRecord[];
};
export type VoiceCallRecord = {
  id: string; attempt_id: string; started_at: string; ended_at: string | null; end_reason: string;
  turns: { index: number; at: string; input: string; intent: string; reply: string }[];
};
export type VoiceCallDemo = VoiceCallRecord & {
  language: "zh-CN" | "en-US"; mode: "simulate"; deadline: string; remaining_sec: number;
  status: string; acknowledged_name: string;
};
export type Bootstrap = {
  user: User;
  locations: Location[];
  cameras: Camera[];
  videos: Video[];
  events: Event[];
  alerts: Alert[];
  leads: Lead[];
  incidents: Incident[];
  guards: Guard[];
  tasks: Task[];
  staff: StaffMember[];
  summary: {
    alert_count: number;
    open_incidents: number;
    new_leads: number;
    median_ack_sec: number | null;
    video_count: number;
    analysed_video_count: number;
    pending_video_count: number;
    open_tasks: number;
    my_tasks: number;
    pending_residents: number;
  };
  settings: Settings;
};
export type SearchPreset = {
  query: string;
  location_id?: string | null;
  time_from?: string | null;
  time_to?: string | null;
};
export type Related = {
  video_id: string;
  camera_id: string;
  start_sec: number;
  end_sec: number;
  text: string;
  score: number;
  model: string;
  analysis_source: string;
  unmet_conditions?: string[];
  observed_at_sec?: number;
  keyframe_url?: string | null;
  match_basis?: "similarity" | "visible_attributes" | null;
};
export type SearchResult = {
  supported: boolean;
  message: string;
  interpreted: {
    attribute_search_phrase?: string | null;
    location_id?: string;
    time_from?: string;
    time_to?: string;
    behaviour?: string;
    appearance?: string | string[];
  };
  events: Event[];
  related: Related[];
  nearest: Related[];
  coverage: { analysed: number; total: number; pending: number };
  threshold: number;
};
