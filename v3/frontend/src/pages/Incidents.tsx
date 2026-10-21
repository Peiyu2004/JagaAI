import { useState, useEffect, useRef, type FormEvent } from "react";
import { NotificationPanel } from "../components/GuardNotifications";
import {
  Plus,
  FolderKanban,
  MapPin,
  UserRound,
  Clock3,
  Play,
  Check,
  Radio,
  Bell,
  MessageSquare,
  ArrowRight,
} from "lucide-react";
import { useApp } from "../context";
import { api, json, dateTime, label, duration } from "../api";
import { Field, Empty, Badge } from "../components/shared";
import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";
import type { Incident } from "../types";
import { REPLY_TEMPLATES } from "../components/replyTemplates";
const columns = [
  { id: "open", name: "Open" },
  { id: "assigned", name: "Assigned" },
  { id: "resolved", name: "Resolved" },
  { id: "closed", name: "Closed" },
];
export default function Incidents() {
  const { data, run, go } = useApp();
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [creatingBusy, setCreatingBusy] = useState(false);
  const creatingLock = useRef(false);
  const creationKey = useRef("");
  const [title, setTitle] = useState("");
  const [loc, setLoc] = useState(data.locations[0]?.id || "");
  const [priority, setPriority] = useState("normal");
  const selectedIncident = data.incidents.find((i) => i.id === selected);
  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (creatingLock.current) return;
    creatingLock.current = true;
    setCreatingBusy(true);
    try {
      const ok = await run(
        () =>
          api("/incidents", {
            method: "POST",
            headers: { "Idempotency-Key": creationKey.current },
            body: json({ title, location_id: loc, priority }),
          }),
        "Incident created",
      );
      if (ok) {
        setCreating(false);
        setTitle("");
      }
    } finally {
      creatingLock.current = false;
      setCreatingBusy(false);
    }
  };
  return (
    <>
      <div className="page-tools">
        <span>{data.incidents.length} incident records</span>
        {data.incidents.length > 0 && (
          <Button
            onClick={() => {
              creationKey.current = crypto.randomUUID();
              setCreating(true);
            }}
          >
            <Plus size={16} /> New incident
          </Button>
        )}
      </div>
      {!data.incidents.length ? (
        <section className="panel incident-empty">
          <div className="incident-empty-head">
            <span className="empty-icon">
              <FolderKanban size={26} strokeWidth={1.4} />
            </span>
            <div>
              <h2>No incidents yet</h2>
              <p>
                An incident is the shared record for a case: who is handling it,
                what was found, and how the resident was updated. Start from the
                work already in the workspace.
              </p>
            </div>
          </div>
          <div className="incident-start-grid">
            <button type="button" onClick={() => go("alerts")}>
              <Bell size={19} />
              <span>
                <strong>From an alert</strong>
                <small>Review the evidence, then confirm it into an incident.</small>
              </span>
              <ArrowRight size={16} />
            </button>
            <button type="button" onClick={() => go("leads")}>
              <MessageSquare size={19} />
              <span>
                <strong>From a resident lead</strong>
                <small>Turn a resident observation into a tracked case.</small>
              </span>
              <ArrowRight size={16} />
            </button>
            <button
              type="button"
              onClick={() => {
                creationKey.current = crypto.randomUUID();
                setCreating(true);
              }}
            >
              <Plus size={19} />
              <span>
                <strong>Create manually</strong>
                <small>Record something your team observed directly.</small>
              </span>
              <ArrowRight size={16} />
            </button>
          </div>
          <div className="incident-empty-foot">
            <Radio size={16} />
            <span>
              Guards are assigned by radio or phone; they do not need a login.
            </span>
          </div>
        </section>
      ) : (
        <div className="board-grid">
          {columns.map((col) => {
            const items = data.incidents.filter((i) => i.status === col.id);
            return (
              <section className={"board-column board-" + col.id} key={col.id}>
                <div className="board-head">
                  <span className="status-dot" />
                  <h2>{col.name}</h2>
                  <span>{items.length}</span>
                </div>
                <div className="board-body">
                  {items.map((i) => (
                    <button
                      key={i.id}
                      className="incident-card"
                      onClick={() => setSelected(i.id)}
                    >
                      <div className="row-between">
                        <span className="record-id">{i.id.slice(0, 8)}</span>
                        <Badge value={i.priority} />
                      </div>
                      <strong>{i.title}</strong>
                      <p>
                        <MapPin size={13} />
                        {
                          data.locations.find((l) => l.id === i.location_id)
                            ?.name
                        }
                      </p>
                      <div className="incident-card-footer">
                        <span>
                          <UserRound size={13} />
                          {data.guards.find((g) => g.id === i.guard_id)?.name ||
                            "Unassigned"}
                        </span>
                        <small>{dateTime(i.updated_at)}</small>
                      </div>
                    </button>
                  ))}
                  {!items.length && (
                    <div className="board-empty">
                      <span>None</span>
                    </div>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}
      <Dialog
        open={creating}
        onOpenChange={(open) => {
          if (!creatingLock.current) setCreating(open);
        }}
        title="Create an incident"
        description="Start a record for an observation that needs follow-up."
      >
        <form className="stack-form" onSubmit={create}>
          <Field label="Incident title">
            <input
              required
              minLength={3}
              maxLength={180}
              disabled={creatingBusy}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Describe the issue clearly"
            />
          </Field>
          <div className="form-grid">
            <Field label="Location">
              <select
                required
                disabled={creatingBusy}
                value={loc}
                onChange={(e) => setLoc(e.target.value)}
              >
                {data.locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Priority">
              <select
                disabled={creatingBusy}
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
              >
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </Field>
          </div>
          <Button type="submit" disabled={creatingBusy}>
            {creatingBusy ? "Creating…" : "Create incident"}
          </Button>
        </form>
      </Dialog>
      <Dialog
        open={!!selectedIncident}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        title={selectedIncident?.title || "Incident"}
        description="Assignment, evidence and follow-up record."
      >
        {selectedIncident && <IncidentDetail incident={selectedIncident} />}
      </Dialog>
    </>
  );
}
function IncidentDetail({ incident }: { incident: Incident }) {
  const { data, run, play } = useApp();
  const [guard, setGuard] = useState(incident.guard_id || "");
  const [status, setStatus] = useState(incident.status);
  const [outcome, setOutcome] = useState(incident.outcome || "");
  const [reply, setReply] = useState("");
  useEffect(() => {
    setGuard(incident.guard_id || "");
    setStatus(incident.status);
    setOutcome(incident.outcome || "");
  }, [incident.id, incident.guard_id, incident.status, incident.outcome]);
  const save = (e: FormEvent) => {
    e.preventDefault();
    run(
      () =>
        api("/incidents/" + incident.id, {
          method: "PATCH",
          body: json({
            guard_id: guard || null,
            status,
            outcome,
            public_reply: reply || undefined,
          }),
        }),
      "Incident record updated",
    );
  };
  return (
    <div className="incident-detail">
      <div className="lead-metadata">
        <Badge value={incident.priority} />
        <span>
          <Clock3 size={15} />
          {dateTime(incident.created_at)} MYT
        </span>
      </div>
      {incident.status === "closed" && (
        <div className="info-strip">
          <Check size={16} />
          This incident is closed. The record is kept for review.
        </div>
      )}
      <form className="stack-form" onSubmit={save}>
        <fieldset
          disabled={incident.status === "closed"}
          className="incident-fieldset"
        >
          <div className="form-grid">
            <Field label="Status">
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                {columns.map((c) => (
                  <option
                    key={c.id}
                    value={c.id}
                    disabled={
                      (c.id === "closed" &&
                        incident.status !== "resolved" &&
                        incident.status !== "closed") ||
                      (incident.status === "resolved" &&
                        (c.id === "open" || c.id === "assigned"))
                    }
                  >
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Responsible guard">
              <select
                value={guard}
                onChange={(e) => {
                  setGuard(e.target.value);
                  if (status === "open" && e.target.value)
                    setStatus("assigned");
                  if (status === "assigned" && !e.target.value)
                    setStatus("open");
                }}
              >
                <option value="">Unassigned</option>
                {data.guards.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name} · {g.shift}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {guard && (
            <div className="info-strip">
              <Radio size={16} />
              Contact {data.guards.find((g) => g.id === guard)?.name}: {data.guards.find((g) => g.id === guard)?.phone}. Check the notification record below for acceptance.
            </div>
          )}
          <Field label="Internal outcome">
            <textarea
              value={outcome}
              onChange={(e) => setOutcome(e.target.value)}
              required={status === "resolved" || status === "closed"}
              placeholder="Record the action taken and the outcome…"
            />
          </Field>
          {data.leads.some((l) => l.incident_id === incident.id) && (
            <div
              className="reply-templates"
              role="group"
              aria-label="Reply templates"
            >
              <span>Quick replies</span>
              {REPLY_TEMPLATES.map((t) => (
                <button
                  type="button"
                  key={t.label}
                  aria-pressed={reply === t.text}
                  className={reply === t.text ? "active" : ""}
                  onClick={() => setReply(t.text)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}
          {data.leads.some((l) => l.incident_id === incident.id) && (
            <Field
              label="Reply to linked resident"
              hint="Only this text and the report status will be shared with the resident."
            >
              <textarea
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                placeholder="Optional public update. Pick a quick reply above or write your own…"
              />
            </Field>
          )}
          <Button type="submit">
            <Check size={16} /> Save incident record
          </Button>
        </fieldset>
      </form>
      <NotificationPanel incidentId={incident.id}/>
      <h3 className="section-heading">Evidence</h3>
      {incident.evidence?.length ? (
        <div className="evidence-list">
          {incident.evidence.map((e, i) => {
            const videoId = String(e.video_id || "");
            const alert = data.alerts.find((a) => a.id === e.alert_id);
            const ev = alert?.event;
            return (
              <div key={i}>
                <span>
                  <strong>
                    {e.lead_id
                      ? "Resident lead"
                      : e.alert_id
                        ? "Confirmed alert"
                        : "Recording"}
                  </strong>
                  <small>
                    {String(e.lead_id || e.alert_id || videoId).slice(0, 12)}
                    {e.start_sec !== undefined
                      ? " · " + duration(Number(e.start_sec))
                      : ""}
                  </small>
                </span>
                {(videoId || ev) && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      play(
                        videoId || ev!.video_id,
                        Number(e.start_sec || ev?.start_sec || 0),
                      )
                    }
                  >
                    <Play size={14} /> Play
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <Empty
          compact
          icon={FolderKanban}
          title="No evidence attached"
          text="Evidence is attached when you create or link an alert or resident lead."
        />
      )}
      <h3 className="section-heading">Record timeline</h3>
      <div className="record-timeline">
        {incident.timeline?.length ? (
          incident.timeline.map((item, i) => (
            <div key={i}>
              <span className="activity-node" />
              <span>
                <strong>
                  {label(
                    String(item.action || item.status || "Record updated"),
                  )}
                </strong>
                <small>
                  {dateTime(
                    String(item.created_at || item.at || incident.updated_at),
                  )}
                </small>
                {!!(item.text || item.note) && (
                  <p>{String(item.text || item.note)}</p>
                )}
              </span>
            </div>
          ))
        ) : (
          <p className="muted">
            Created {dateTime(incident.created_at)}. Future updates appear here.
          </p>
        )}
      </div>
    </div>
  );
}
