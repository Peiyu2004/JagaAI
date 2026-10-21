import { useEffect, useState, type FormEvent } from "react";
import { BellRing, Check, Clock3, MessageCircle, PhoneCall, Send, ShieldCheck, Smartphone, X } from "lucide-react";
import { api, dateTime, json, label } from "../api";
import { useApp } from "../context";
import type { GuardDispatch, NotificationConfig, NotificationPolicy } from "../types";
import { Badge, Empty, Field, Panel } from "./shared";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { VoiceCallDemo } from "./VoiceCallDemo";

const channelName = { whatsapp: "WhatsApp", voice: "Automatic call", sms: "SMS backup" };
const channelIcon = { whatsapp: MessageCircle, voice: PhoneCall, sms: Smartphone };
const statusName: Record<string, string> = {
  active: "Awaiting acceptance", unacknowledged: "Follow-up required", acknowledged: "Accepted",
  suppressed: "Within cooldown", cancelled: "Stopped", submitted: "Submitted to provider",
  simulated: "Simulated only", queued: "Scheduled", unknown: "Delivery uncertain", "in-progress": "Answered",
  phone_speech: "Phone voice reply", phone_keypad: "Phone keypad",
};
const readable = (value: string) => statusName[value] || label(value);

export function DispatchRecord({ dispatch }: { dispatch: GuardDispatch }) {
  const { run } = useApp();
  const [recording, setRecording] = useState(false);
  const [guard, setGuard] = useState(dispatch.primary_guard_id);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const open = ["active", "unacknowledged"].includes(dispatch.status) && new Date(dispatch.expires_at).getTime() > Date.now();
  const action = async (path: string, body?: unknown) => {
    if (busy) return;
    setBusy(true);
    const ok = await run(() => api(`/notifications/${dispatch.id}/${path}`, { method: "POST", body: body ? json(body) : undefined }), path === "cancel" ? "Pending notifications stopped" : "Guard acceptance recorded");
    setBusy(false);
    if (ok) setRecording(false);
  };
  return <div className="gn-record">
    <div className="gn-record-head">
      <span className={"gn-state gn-state-" + dispatch.status}><ShieldCheck size={15}/>{readable(dispatch.status)}</span>
      <span className={"gn-mode " + (dispatch.mode === "simulate" ? "is-simulation" : "")}>{dispatch.mode === "simulate" ? "Simulation" : "Live"}</span>
    </div>
    {dispatch.mode === "simulate" && <p className="gn-simulation">No real messages or calls are sent. Acceptance is saved as a simulation.</p>}
    {dispatch.acknowledged_at && <div className="gn-accepted"><Check size={18}/><div><strong>{dispatch.acknowledged_name} accepted</strong><small>{dateTime(dispatch.acknowledged_at)} MYT · {readable(dispatch.acknowledged_via)}{dispatch.recorded_by && ` · Recorded by ${dispatch.recorded_by}`}</small></div></div>}
    {dispatch.reason && <p className="gn-note">{dispatch.reason}</p>}
    <ol className="gn-deliveries" aria-label="Notification progress">
      {dispatch.attempts.map(row => {
        const Icon = channelIcon[row.channel];
        const state = row.provider_status || row.status;
        return <li key={row.id} className={"gn-attempt is-" + row.status}>
          <span className="gn-channel"><Icon size={16}/></span>
          <div><strong>{channelName[row.channel]}</strong><small>{row.guard_name}{row.stage === "escalation" ? " · Escalation contact" : " · Duty contact"}</small>
            {row.error && <p role="status" className="gn-error">{row.error}</p>}
            {row.history.length > 1 && <details className="gn-events"><summary>Status history</summary>{row.history.map((entry, i) => <small key={i}>{dateTime(entry.at)} · {readable(entry.status)}</small>)}</details>}
          </div>
          <span className="gn-attempt-state"><strong>{readable(state)}</strong><small>{row.status === "queued" ? "Due " : ""}{dateTime(row.status === "queued" ? row.due_at : row.updated_at)}</small></span>
        </li>;
      })}
    </ol>
    <p className="gn-note">Delivery and call completion do not confirm acceptance.</p>
    {dispatch.mode === "simulate" && (open || dispatch.status === "acknowledged") && <div className="gn-actions"><VoiceCallDemo dispatch={dispatch}/></div>}
    {!!dispatch.voice_calls?.length && <details className="gn-call-history"><summary>Call transcripts ({dispatch.voice_calls.length})</summary>{dispatch.voice_calls.map(call => <div key={call.id}>
      <strong>{dateTime(call.started_at)} MYT · {dispatch.mode === "simulate" ? "Simulation" : "Phone"}</strong>
      <small>{call.ended_at ? label(call.end_reason) : "Call in progress · Maximum 90 seconds"}</small>
      {call.turns.map(turn => <div key={turn.index}>{turn.input && <p><strong>Guard:</strong> {turn.input}</p>}<p><strong>JagaAI:</strong> {turn.reply}</p></div>)}
    </div>)}</details>}
    {open && <div className="gn-actions">
      {dispatch.preview_url && <a className="btn btn-outline btn-sm" href={dispatch.preview_url} target="_blank" rel="noreferrer">Open simulated guard page</a>}
      <Button variant="outline" size="sm" disabled={busy} onClick={() => { setConfirmed(false); setRecording(true); }}>Record acceptance</Button>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => action("cancel")}><X size={14}/>Stop pending</Button>
    </div>}
    <Dialog open={recording} onOpenChange={setRecording} title="Record a guard's acceptance" description="Use this when a guard confirms directly to the control room. Your name is saved with the record.">
      <form className="stack-form" onSubmit={e => { e.preventDefault(); if (confirmed) action("acknowledge", {guard_id: guard}); }}>
        <Field label="Guard who accepted"><select value={guard} onChange={e => setGuard(e.target.value)}><option value={dispatch.primary_guard_id}>{dispatch.primary_name}</option>{dispatch.escalation_guard_id && <option value={dispatch.escalation_guard_id}>{dispatch.escalation_name}</option>}</select></Field>
        <label className="gn-check"><input type="checkbox" required checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/><span>The guard confirmed they will attend.</span></label>
        <Button type="submit" disabled={!confirmed || busy}>{busy ? "Saving…" : dispatch.mode === "simulate" ? "Record simulated acceptance" : "Record acceptance"}</Button>
      </form>
    </Dialog>
  </div>;
}

export function NotificationPanel({ alertId, incidentId, dismissed = false }: { alertId?: string; incidentId?: string; dismissed?: boolean }) {
  const { data, run, go } = useApp();
  const [rows, setRows] = useState<GuardDispatch[]>([]);
  const [config, setConfig] = useState<NotificationConfig | null>(null);
  const [guard, setGuard] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let current = true;
    setError("");
    Promise.all([api<GuardDispatch[]>(`/notifications?${alertId ? "alert_id=" + encodeURIComponent(alertId) : "incident_id=" + encodeURIComponent(incidentId || "")}`), api<NotificationConfig>("/notifications/config")])
      .then(([history, settings]) => { if (current) { setRows(history); setConfig(settings); } })
      .catch(e => { if (current) setError(e.message); });
    return () => { current = false; };
  }, [data, alertId, incidentId]);
  useEffect(() => { setRows([]); setConfig(null); setGuard(""); }, [alertId, incidentId]);
  const send = async () => {
    if (busy || !alertId) return;
    setBusy(true);
    await run(async () => {
      const row = await api<GuardDispatch>(`/alerts/${alertId}/notify`, {method: "POST", body: json({guard_id: guard || undefined})});
      setRows([row]);
    }, config?.policy.mode === "simulate" ? "Simulation scheduled" : "Guard notification scheduled");
    setBusy(false);
  };
  return <section className="gn-panel" aria-label="Guard notification">
    <h3><BellRing size={16}/>Guard notification</h3>
    {error ? <p className="gn-error" role="alert">{error}</p> : rows.length ? rows.map(row => <DispatchRecord key={row.id} dispatch={row}/>) : <>
      <p className="gn-note">{dismissed ? "This alert is dismissed. No new notification can be sent." : "No guard notification recorded. Live triggers follow the notification policy in Settings."}</p>
      {alertId && !dismissed && config && <div className="gn-compose">
        <Field label="Notify guard"><select aria-label="Guard to notify" value={guard || config.policy.primary_guard_id || ""} onChange={e => setGuard(e.target.value)}><option value="">Choose a guard</option>{data.guards.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select></Field>
        <Button size="sm" disabled={busy || !(guard || config.policy.primary_guard_id)} onClick={send}><Send size={14}/>{busy ? "Scheduling…" : config.policy.mode === "simulate" ? "Simulate notification" : "Send guard notification"}</Button>
        {config.policy.mode === "simulate" && <small className="gn-note">Simulation mode. No real messages or calls.</small>}
      </div>}
      {(!data.guards.length || !config?.policy.primary_guard_id) && <Button variant="ghost" size="sm" onClick={() => go("settings")}>Set up duty contacts</Button>}
    </>}
  </section>;
}

export function NotificationSettings() {
  const { data, run } = useApp();
  const admin = data.user.role === "admin";
  const [config, setConfig] = useState<NotificationConfig | null>(null);
  const [draft, setDraft] = useState<NotificationPolicy | null>(null);
  const [history, setHistory] = useState<GuardDispatch[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let current = true;
    Promise.all([api<NotificationConfig>("/notifications/config"), api<GuardDispatch[]>("/notifications")]).then(([settings, rows]) => {
      if (current) {
        const {id: _id, ...policy} = settings.policy;
        setConfig(settings); setDraft(previous => previous || policy); setHistory(rows); setError("");
      }
    }).catch(e => { if (current) setError(e.message); });
    return () => { current = false; };
  }, [data]);
  const change = <K extends keyof NotificationPolicy>(key: K, value: NotificationPolicy[K]) => setDraft(previous => previous ? {...previous, [key]: value} : previous);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft || busy) return;
    setBusy(true);
    await run(async () => {
      const saved = await api<NotificationConfig>("/notifications/config", {method: "PUT", body: json(draft)});
      const {id: _id, ...policy} = saved.policy;
      setConfig(saved); setDraft(policy);
    }, "Notification policy saved");
    setBusy(false);
  };
  const dirty = draft && config && Object.keys(draft).some(key => draft[key as keyof NotificationPolicy] !== config.policy[key as keyof NotificationPolicy]);
  if (error) return <div className="error-banner" role="alert">{error}</div>;
  if (!draft || !config) return <p className="muted" role="status">Loading notifications…</p>;
  return <div className="gn-settings" role="tabpanel" id="settings-notifications" aria-label="Notifications">
    <div className="gn-settings-main">
      <Panel className="set-card" title="Reach the guard on duty" action={<span className={"gn-mode " + (draft.mode === "simulate" ? "is-simulation" : "")}>{draft.mode === "simulate" ? "Simulation" : "Live"}</span>}>
        <p className="panel-description">A message first, a call if no one accepts, then an escalation contact. Acceptance stops pending notifications.</p>
        <form className="stack-form" onSubmit={save}>
          <fieldset disabled={!admin || busy} className="gn-fieldset">
            <div className="gn-modes" role="radiogroup" aria-label="Notification mode">
              <label className={draft.mode === "simulate" ? "is-selected" : ""}><input type="radio" name="notification-mode" value="simulate" checked={draft.mode === "simulate"} onChange={() => change("mode", "simulate")}/><span><strong>Simulation</strong><small>Exercise the full flow without contacting anyone.</small></span></label>
              <label className={draft.mode === "live" ? "is-selected" : ""}><input type="radio" name="notification-mode" value="live" checked={draft.mode === "live"} onChange={() => change("mode", "live")}/><span><strong>Live notifications</strong><small>Send real messages and calls through your provider.</small></span></label>
            </div>
            <div className="form-grid">
              <Field label="Duty contact" hint="Update this contact at each shift change."><select required={draft.enabled || draft.mode === "live"} value={draft.primary_guard_id || ""} onChange={e => change("primary_guard_id", e.target.value || null)}><option value="">Choose a guard</option>{data.guards.map(g => <option key={g.id} value={g.id}>{g.name} · {g.shift}</option>)}</select></Field>
              <Field label="Escalation contact" hint="Choose a different guard or supervisor in the roster."><select value={draft.escalation_guard_id || ""} onChange={e => change("escalation_guard_id", e.target.value || null)}><option value="">No escalation contact</option>{data.guards.filter(g => g.id !== draft.primary_guard_id).map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select></Field>
            </div>
            <div className="form-grid">
              <Field label="Call if not accepted after (seconds)"><input type="number" required min={15} max={1800} value={draft.call_after_sec} onChange={e => change("call_after_sec", Number(e.target.value))}/></Field>
              <Field label="Escalate if not accepted after (seconds)"><input type="number" required min={Math.max(30, draft.call_after_sec + 1)} max={3600} value={draft.escalate_after_sec} onChange={e => change("escalate_after_sec", Number(e.target.value))}/></Field>
            </div>
            <Field label="Repeat alert cooldown (seconds)" hint="Automatic alerts from the same camera and rule share a cooldown."><input type="number" required min={60} max={3600} value={draft.cooldown_sec} onChange={e => change("cooldown_sec", Number(e.target.value))}/></Field>
            <Field label="Call language" hint="Say received / 收到 or press 1 to accept. Ask the alert location or situation. Every call ends within 90 seconds."><select value={draft.voice_language} onChange={e => change("voice_language", e.target.value as NotificationPolicy["voice_language"])}><option value="zh-CN">Mandarin Chinese / 中文</option><option value="en-US">English</option></select></Field>
            <label className="gn-check"><input type="checkbox" checked={draft.urgent_call} onChange={e => change("urgent_call", e.target.checked)}/><span><strong>Call immediately for urgent alerts</strong><small>Other priorities use the delay above.</small></span></label>
            <label className="gn-check"><input type="checkbox" checked={draft.sms_fallback} onChange={e => change("sms_fallback", e.target.checked)}/><span><strong>Use SMS as a backup</strong><small>Send a short summary if WhatsApp fails or delivery remains unconfirmed. SMS contains no links or phone numbers.</small></span></label>
            <label className="gn-check gn-auto"><input type="checkbox" checked={draft.enabled} onChange={e => change("enabled", e.target.checked)}/><span><strong>Notify automatically for new live triggers</strong><small>Uploaded recordings are excluded. Simulated camera replays never send real notifications.</small></span></label>
          </fieldset>
          <div className="gn-note"><ShieldCheck size={15}/> The guard receives a request to verify the event. Acceptance does not confirm the AI detection.</div>
          {admin ? <div className="gn-actions"><Button type="submit" disabled={busy || !dirty}>{busy ? "Saving…" : "Save notification policy"}</Button>{dirty && <small className="gn-note">Unsaved changes</small>}</div> : <p className="gn-note">Only administrators can change notification settings.</p>}
          {dirty && history.some(row => ["active", "unacknowledged"].includes(row.status)) && <p className="gn-note">Saving a new policy stops pending plans created with the previous settings.</p>}
        </form>
      </Panel>
      <Panel className="set-card" title="Notification & acceptance records" action={<span className="panel-subtle">Latest {history.length}</span>}>
        {history.length ? <div className="gn-history">{history.map(row => <details key={row.id}><summary><span><strong>{row.location}</strong><small>{row.primary_name} · {dateTime(row.created_at)} MYT</small></span><span className={"gn-state gn-state-" + row.status}>{readable(row.status)}</span></summary><DispatchRecord dispatch={row}/></details>)}</div> : <Empty compact icon={BellRing} title="No notifications yet" text="Choose a duty contact, save the policy, then simulate a notification from an alert."/>}
      </Panel>
    </div>
    <aside className="gn-settings-rail">
      <Panel className="set-card" title="Response sequence">
        <ol className="gn-sequence"><li><MessageCircle size={20}/><div><strong>Send WhatsApp</strong><small>Event, location, time and a guard acceptance link.</small></div></li><li><PhoneCall size={20}/><div><strong>Call after {draft.call_after_sec} seconds</strong><small>Ask where or what happened. Say received or press 1 to accept. Maximum 90 seconds.</small></div></li><li><BellRing size={20}/><div><strong>Escalate after {draft.escalate_after_sec} seconds</strong><small>{draft.escalation_guard_id ? "Message the escalation contact, then call if still unaccepted." : "Choose an escalation contact to enable this step."}</small></div></li><li><Check size={20}/><div><strong>Record acceptance</strong><small>Save who accepted, when and through which channel.</small></div></li></ol>
      </Panel>
      <Panel className="set-card" title="Live service setup" action={<Badge value={config.provider.ready ? "resolved" : "pending"}>{config.provider.ready ? "Configured" : "Setup needed"}</Badge>}>
        <p className="gn-note">{config.provider.ready ? "Configuration is present. Confirm sender approval and test delivery before operational use." : "Simulation is available now. To send real notifications, configure these on the server:"}</p>
        {!!config.provider.missing.length && <ul className="gn-setup-list">{config.provider.missing.map(name => <li key={name}>{name}</li>)}</ul>}
        {config.provider.ready && config.provider.channels && <p className="gn-note">Live channels: {(["whatsapp", "voice", "sms"] as const).filter(key => config.provider.channels?.[key]).map(key => ({ whatsapp: "WhatsApp", voice: "Calls", sms: "SMS backup" })[key]).join(", ")}. Channels without a sender number are left out of Live plans; rehearse them in Simulation.</p>}
        <p className="gn-note">Live mode also needs an approved WhatsApp template, consenting contacts and a public HTTPS address reachable from guard phones.</p>
        <a className="gn-doc-link" href="https://www.twilio.com/docs/whatsapp/tutorial/send-whatsapp-notification-messages-templates" target="_blank" rel="noreferrer">WhatsApp setup guide</a>
      </Panel>
      <div className="gn-quiet-note"><Clock3 size={16}/><p>If no guard accepts, the record stays marked for control room follow-up.</p></div>
    </aside>
  </div>;
}
