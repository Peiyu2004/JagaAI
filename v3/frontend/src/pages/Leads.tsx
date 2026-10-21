import RubberSegment from "../components/RubberSegment";
import { useState, useEffect, useRef, type FormEvent } from "react";
import {
  MessageSquare,
  MapPin,
  Clock3,
  Search,
  Plus,
  Link,
  Send,
  ShieldCheck,
  Check,
  ArrowRight,
  Inbox,
  CalendarClock,
  FolderKanban,
  ImageIcon,
} from "lucide-react";
import { useApp } from "../context";
import { api, json, dateTime, label, relativeTime, showPoints } from "../api";
import { Field, Badge, Empty } from "../components/shared";
import { EstateMap } from "../components/EstateMap";
import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";
import { REPLY_TEMPLATES } from "../components/replyTemplates";
import type { Camera, Lead, Location } from "../types";
import "../reports.css";

const STATUSES = ["received", "in_progress", "resolved", "invalid"];
const STEPS = [
  { id: "received", name: "Received", note: "Report logged" },
  { id: "in_progress", name: "In progress", note: "Team following up" },
  { id: "resolved", name: "Resolved", note: "Outcome shared" },
];

const myt = (options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("en-MY", { timeZone: "Asia/Kuala_Lumpur", hour12: false, ...options });
const clockFmt = myt({ hour: "2-digit", minute: "2-digit" });
const dateFmt = myt({ day: "numeric" });
const monthFmt = myt({ month: "short" });
const clock = (v: string) => clockFmt.format(new Date(v));
const span = (from: string, to: string) => {
  const min = (new Date(to).getTime() - new Date(from).getTime()) / 60000;
  if (!Number.isFinite(min) || min <= 0) return "";
  return min < 60 ? Math.round(min) + " min" : Math.round(min / 6) / 10 + " h";
};
// "20 Oct", "20–21 Oct" or "31 Oct – 1 Nov".
const days = (from: string, to: string) => {
  const [d1, d2] = [from, to].map((v) => dateFmt.format(new Date(v)));
  const [m1, m2] = [from, to].map((v) => monthFmt.format(new Date(v)));
  if (m1 !== m2) return `${d1} ${m1} – ${d2} ${m2}`;
  return d1 === d2 ? `${d1} ${m1}` : `${d1}–${d2} ${m1}`;
};

// The report's window as "19:00 – 06:00" over "20–21 Oct · 11 h window".
function windowText(lead: Lead) {
  const length = span(lead.time_from, lead.time_to);
  return {
    hours: `${clock(lead.time_from)} – ${clock(lead.time_to)}`,
    days: days(lead.time_from, lead.time_to) + (length ? ` · ${length} window` : ""),
  };
}

function ZoneMap({
  locations,
  cameras,
  selected,
}: {
  locations: Location[];
  cameras: Camera[];
  selected: string;
}) {
  if (!locations.some((l) => l.id === selected && l.map_area?.length === 4)) return null;
  return (
    <section className="rr-map" aria-label="Where the resident saw it">
      <div className="rr-map-head">
        <span className="rr-eyebrow">
          <MapPin size={13} /> Where it was seen
        </span>
        <span className="rr-eyebrow is-quiet">Schematic</span>
      </div>
      <EstateMap
        className="rr-map-canvas"
        locations={locations}
        cameras={cameras}
        selected={selected}
        labels="name"
        fill
      />
    </section>
  );
}

function Progress({ status }: { status: string }) {
  const at = STEPS.findIndex((s) => s.id === status);
  return (
    <div className={"rr-steps" + (status === "invalid" ? " is-invalid" : "")}>
      <ol aria-label="Report progress">
        {STEPS.map((step, i) => (
          <li
            key={step.id}
            className={i < at ? "is-done" : i === at ? "is-current" : ""}
            aria-current={i === at ? "step" : undefined}
          >
            <span className="rr-step-dot">{i < at || (i === at && step.id === "resolved") ? <Check size={11} strokeWidth={3} /> : null}</span>
            <span className="rr-step-text">
              <strong>{step.name}</strong>
              <small>{step.note}</small>
            </span>
          </li>
        ))}
      </ol>
      {status === "invalid" && (
        <p className="rr-steps-note">
          Marked not valid. The resident sees this status
          {showPoints ? " and the points this report earned are withdrawn." : "."}
        </p>
      )}
    </div>
  );
}

export default function Leads() {
  const { data, run, search, go } = useApp();
  const [selected, setSelected] = useState("");
  const [filter, setFilter] = useState("all");
  const [reply, setReply] = useState("");
  const [status, setStatus] = useState("received");
  const [linkId, setLinkId] = useState("");
  const [mode, setMode] = useState<"new" | "link" | null>(null);
  const [title, setTitle] = useState("");
  const [copied, setCopied] = useState(false);
  const residentUrl = location.origin + "/resident";
  const copyResidentLink = async () => {
    try {
      await navigator.clipboard.writeText(residentUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2200);
    } catch {
      setCopied(false);
    }
  };
  const creationKey = useRef("");
  const linkLock = useRef(false);
  const [linkBusy, setLinkBusy] = useState(false);
  const leads = data.leads.filter(
    (l) => filter === "all" || l.status === filter,
  );
  const lead = leads.find((l) => l.id === selected) || leads[0];
  const place = (id?: string) => data.locations.find((l) => l.id === id)?.name || "Unknown location";
  const newCount = data.leads.filter((l) => l.status === "received").length;
  const index = leads.findIndex((l) => l.id === lead?.id);
  const zoneCameras = data.cameras.filter((c) => c.location_id === lead?.location_id);
  const openIncidents = data.incidents.filter(
    (i) => i.location_id === lead?.location_id && i.status !== "closed",
  );
  const incident = data.incidents.find((i) => i.id === lead?.incident_id);
  const when = lead ? windowText(lead) : null;
  useEffect(() => {
    setReply(lead?.public_reply || "");
    setStatus(lead?.status || "received");
    setTitle((lead?.text || "").slice(0, 180));
  }, [lead?.id, lead?.status, lead?.public_reply]);
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (lead)
      run(
        () =>
          api("/leads/" + lead.id, {
            method: "PATCH",
            body: json({ status, public_reply: reply }),
          }),
        "Resident update saved",
      );
  };
  const link = async (e: FormEvent) => {
    e.preventDefault();
    if (!lead || linkLock.current) return;
    linkLock.current = true;
    setLinkBusy(true);
    try {
      const ok = await run(
        () =>
          mode === "new"
            ? api("/incidents", {
                method: "POST",
                headers: { "Idempotency-Key": creationKey.current },
                body: json({
                  title,
                  location_id: lead.location_id,
                  priority: "normal",
                  lead_id: lead.id,
                }),
              })
            : api("/leads/" + lead.id + "/link", {
                method: "POST",
                body: json({ incident_id: linkId }),
              }),
        mode === "new"
          ? "Incident created from resident lead"
          : "Lead linked to incident",
      );
      if (ok) setMode(null);
    } finally {
      linkLock.current = false;
      setLinkBusy(false);
    }
  };
  return (
    <>
      <div className="rr-toolbar">
        <RubberSegment
          semantics="tabs"
          aria-label="Lead status"
          className="lead-switch"
          value={filter}
          onChange={setFilter}
          items={["all", ...STATUSES].map((s) => ({
            value: s,
            label: s === "all" ? "All leads" : label(s),
            count: data.leads.filter((l) => s === "all" || l.status === s).length,
          }))}
        />
        {data.leads.length > 0 && (
          <div className="rr-toolbar-meta">
            <span className="review-progress">
              <span className={"live-dot " + (newCount ? "off" : "")} />
              {newCount ? `${newCount} new to answer` : "Every report answered"}
              {leads.length > 0 && (
                <strong>
                  {index + 1} of {leads.length}
                </strong>
              )}
            </span>
            <Button variant="outline" size="sm" onClick={copyResidentLink}>
              {copied ? <Check size={14} /> : <Link size={14} />}
              {copied ? "Copied" : "Copy resident link"}
            </Button>
          </div>
        )}
      </div>
      {!data.leads.length ? (
        <section className="panel resident-entry-panel">
          <div className="resident-entry-head">
            <span className="empty-icon">
              <MessageSquare size={25} strokeWidth={1.4} />
            </span>
            <div>
              <h2>No resident leads yet</h2>
              <p>
                Residents can report a location, an observation and an
                approximate time from their phone. Leads appear here with the
                photo, map reference and time window attached.
              </p>
            </div>
          </div>
          <div className="resident-entry-link">
            <div>
              <strong>Resident entry</strong>
              <code>{residentUrl}</code>
              <small>
                Share this link on a noticeboard or send it to residents. Only
                their own report and public replies are visible.
              </small>
            </div>
            <div className="resident-entry-actions">
              <Button variant="outline" onClick={copyResidentLink}>
                {copied ? <Check size={15} /> : <Link size={15} />}
                {copied ? "Copied" : "Copy link"}
              </Button>
              <Button asChild>
                <a href="/resident" target="_blank" rel="noreferrer">
                  Open resident view <ArrowRight size={15} />
                </a>
              </Button>
            </div>
          </div>
        </section>
      ) : !lead ? (
        <div className="panel empty-panel">
          <Empty
            icon={Inbox}
            title={`No ${label(filter).toLowerCase()} reports`}
            text="Reports move between these tabs as your team updates them."
          />
        </div>
      ) : (
        <div className="rr-workspace">
          <aside className="rr-inbox" aria-label="Resident reports">
            <div className="rr-inbox-head">
              <span className="rr-eyebrow">
                <Inbox size={13} /> Inbox
              </span>
              <span className="rr-count">{leads.length}</span>
            </div>
            <div className="rr-inbox-list">
              {leads.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  aria-current={l.id === lead.id ? "true" : undefined}
                  className={"rr-inbox-row" + (l.id === lead.id ? " active" : "")}
                  onClick={() => setSelected(l.id)}
                >
                  <span className={"rr-avatar is-" + l.status}>
                    {l.photo_url ? (
                      <img src={l.photo_url} alt="" loading="lazy" />
                    ) : (
                      <MessageSquare size={16} />
                    )}
                  </span>
                  <span className="rr-inbox-body">
                    <span className="rr-inbox-top">
                      <span className={"rr-pill is-" + l.status}>{label(l.status)}</span>
                      <small>{relativeTime(l.created_at)}</small>
                    </span>
                    <strong>{l.text}</strong>
                    <small className="rr-inbox-place">
                      <MapPin size={12} /> {place(l.location_id)}
                      {l.incident_id && (
                        <span className="rr-inbox-linked" title="Linked to an incident">
                          <FolderKanban size={12} />
                        </span>
                      )}
                    </small>
                  </span>
                </button>
              ))}
            </div>
            <div className="rr-inbox-foot">
              <ShieldCheck size={13} /> Residents see text replies only
            </div>
          </aside>

          <section className="rr-report" aria-label="Report detail">
            <header className="rr-report-head">
              <span className="rr-eyebrow">
                <MessageSquare size={13} /> Resident report
                <span className="record-id">{lead.id.slice(0, 8)}</span>
              </span>
              <Badge value={lead.status} />
            </header>
            <h2 className="rr-report-title">{lead.text}</h2>
            <Progress status={lead.status} />
            <div className="rr-facts">
              <div>
                <span>
                  <MapPin size={13} /> Location
                </span>
                <strong>{place(lead.location_id)}</strong>
                <small>
                  {zoneCameras.length} camera{zoneCameras.length === 1 ? "" : "s"} in this zone
                </small>
              </div>
              <div className="is-window">
                <span>
                  <Clock3 size={13} /> Seen between · MYT
                </span>
                <strong>{when?.hours}</strong>
                <small>{when?.days}</small>
              </div>
              <div>
                <span>
                  <CalendarClock size={13} /> Reported
                </span>
                <strong>{relativeTime(lead.created_at)}</strong>
                <small>{dateTime(lead.created_at)} MYT</small>
              </div>
            </div>
            {lead.photo_url && (
              <figure className="rr-photo">
                <img src={lead.photo_url} alt="Photo supplied with the resident report" />
                <figcaption>
                  <ImageIcon size={13} /> Photo from the resident
                </figcaption>
              </figure>
            )}
            <ZoneMap locations={data.locations} cameras={data.cameras} selected={lead.location_id} />
          </section>

          <aside className="rr-side" aria-label="Response">
            <form className="rr-reply" onSubmit={save}>
              <div className="rr-reply-head">
                <span className="rr-eyebrow">
                  <Send size={13} /> Response
                </span>
                <h3>Update the resident</h3>
                <span>
                  <ShieldCheck size={13} /> Text only. No footage shared.
                </span>
              </div>
              <fieldset className="rr-status-pick" disabled={!!lead.incident_id}>
                <legend>Report status</legend>
                <div>
                  {STATUSES.map((s) => (
                    <label key={s} className={"is-" + s + (status === s ? " active" : "")}>
                      <input
                        type="radio"
                        name="lead-status"
                        value={s}
                        checked={status === s}
                        onChange={() => setStatus(s)}
                      />
                      <i aria-hidden="true" />
                      {label(s)}
                    </label>
                  ))}
                </div>
                {(lead.incident_id || (status === "invalid" && showPoints)) && (
                  <small>
                    {lead.incident_id
                      ? "Status follows the linked incident. Update it in Incidents."
                      : "The resident loses the points this report earned. Choosing another status gives them back."}
                  </small>
                )}
              </fieldset>
              <div className="reply-templates rr-templates" role="group" aria-label="Reply templates">
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
              <Field
                label="Public reply"
                hint="Visible to the resident. Keep internal notes in the incident."
              >
                <textarea
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  placeholder="Tell the resident what your team has done or what happens next…"
                />
              </Field>
              <div className="rr-reply-submit">
                <Button type="submit">
                  <Send size={16} /> Save resident update
                </Button>
              </div>
            </form>
          </aside>

          <div className="rr-actions">
            <div className="rr-actions-main">
              <Button
                onClick={() =>
                  search({
                    query: lead.text.slice(0, 1000),
                    location_id: lead.location_id,
                    time_from: lead.time_from,
                    time_to: lead.time_to,
                  })
                }
              >
                <Search size={16} /> Search recordings for this lead
              </Button>
              {lead.incident_id ? (
                <>
                  <span className="rr-linked">
                    <Check size={14} strokeWidth={2.6} /> Linked to incident
                  </span>
                  {incident && (
                    <button
                      type="button"
                      className="rr-case-open"
                      title="Open in Incidents"
                      onClick={() => go("incidents")}
                    >
                      <FolderKanban size={14} />
                      <span>{incident.title}</span>
                      <Badge value={incident.status} />
                      <ArrowRight size={14} />
                    </button>
                  )}
                </>
              ) : (
                <>
                  <Button
                    variant="outline"
                    title="Start an incident record to assign a guard"
                    onClick={() => {
                      creationKey.current = crypto.randomUUID();
                      setMode("new");
                    }}
                  >
                    <Plus size={16} /> Create incident
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={!openIncidents.length}
                    title={
                      openIncidents.length
                        ? "Add this report to an open incident at " + place(lead.location_id)
                        : "No open incident at " + place(lead.location_id)
                    }
                    onClick={() => setMode("link")}
                  >
                    <Link size={16} /> Link
                  </Button>
                </>
              )}
            </div>
            <span className="rr-actions-meta">
              Searches {zoneCameras.length} camera{zoneCameras.length === 1 ? "" : "s"} at{" "}
              {place(lead.location_id)} · {when?.hours}
            </span>
          </div>
        </div>
      )}
      <Dialog
        open={!!mode}
        onOpenChange={(v) => {
          if (!v && !linkLock.current) setMode(null);
        }}
        title={mode === "new" ? "Create an incident" : "Link to an incident"}
        description="The resident lead stays attached to the incident for follow-up."
      >
        <form className="stack-form" onSubmit={link}>
          {mode === "new" ? (
            <Field label="Incident title">
              <input
                value={title}
                maxLength={180}
                minLength={3}
                required
                onChange={(e) => setTitle(e.target.value)}
              />
            </Field>
          ) : (
            <Field label="Incident">
              <select
                required
                value={linkId}
                onChange={(e) => setLinkId(e.target.value)}
              >
                <option value="">Choose an incident</option>
                {openIncidents.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.title}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Button type="submit" disabled={linkBusy}>
            {linkBusy
              ? "Saving…"
              : mode === "new"
                ? "Create incident"
                : "Link lead"}
          </Button>
        </form>
      </Dialog>
    </>
  );
}
