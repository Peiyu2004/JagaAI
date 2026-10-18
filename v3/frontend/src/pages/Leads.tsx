import { tabKeys } from "../components/tabKeys";
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
} from "lucide-react";
import { useApp } from "../context";
import { api, json, dateTime } from "../api";
import { Panel, Field, Badge, SiteMap } from "../components/shared";
import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";
export default function Leads() {
  const { data, run, search } = useApp();
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
      <div className="tabs tabs-wrap" role="tablist" onKeyDown={tabKeys} aria-label="Lead status">
        {["all", "received", "in_progress", "resolved"].map((s) => (
          <button
            key={s}
            role="tab"
            aria-selected={filter === s}
              tabIndex={filter === s ? 0 : -1}
            className={filter === s ? "active" : ""}
            onClick={() => setFilter(s)}
          >
            {s === "all"
              ? "All leads"
              : s === "in_progress"
                ? "In progress"
                : s[0].toUpperCase() + s.slice(1)}
            <span>
              {data.leads.filter((l) => s === "all" || l.status === s).length}
            </span>
          </button>
        ))}
      </div>
      {leads.length ? (
        <div className="split-layout">
          <div className="selection-list">
            {leads.map((l) => (
              <button
                key={l.id}
                className={
                  "selection-card lead-card " +
                  (l.id === lead?.id ? "active" : "")
                }
                onClick={() => setSelected(l.id)}
              >
                <span className="lead-card-thumb">
                  {l.photo_url ? (
                    <img src={l.photo_url} alt="" loading="lazy" />
                  ) : (
                    <MessageSquare size={18} />
                  )}
                </span>
                <span className="lead-card-body">
                  <span className="row-between">
                    <Badge value={l.status} />
                    <small>{dateTime(l.created_at)}</small>
                  </span>
                  <strong>{l.text}</strong>
                  <p>
                    {
                      data.locations.find((loc) => loc.id === l.location_id)
                        ?.name
                    }
                  </p>
                </span>
              </button>
            ))}
          </div>
          {lead && (
            <Panel className="detail-panel">
              <div className="detail-title">
                <div>
                  <span className="record-id">Lead {lead.id.slice(0, 10)}</span>
                  <h2>{lead.text}</h2>
                </div>
                <Badge value={lead.status} />
              </div>
              <div className="lead-metadata">
                <span>
                  <MapPin size={17} />
                  {data.locations.find((l) => l.id === lead.location_id)?.name}
                </span>
                <span>
                  <Clock3 size={17} />
                  {dateTime(lead.time_from)} – {dateTime(lead.time_to)} MYT
                </span>
              </div>
              <SiteMap locations={data.locations} selected={lead.location_id} />
              {lead.photo_url && (
                <div className="lead-photo">
                  <img
                    src={lead.photo_url}
                    alt="Photo supplied with the resident report"
                  />
                </div>
              )}
              <div className="detail-actions">
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
                {!lead.incident_id && (
                  <>
                    <Button
                      variant="outline"
                      onClick={() => {
                        creationKey.current = crypto.randomUUID();
                        setMode("new");
                      }}
                    >
                      <Plus size={16} /> Create incident
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={
                        !data.incidents.some(
                          (i) =>
                            i.location_id === lead.location_id &&
                            i.status !== "closed",
                        )
                      }
                      onClick={() => setMode("link")}
                    >
                      <Link size={16} /> Link
                    </Button>
                  </>
                )}
                {lead.incident_id && (
                  <Badge value="confirmed">Linked to incident</Badge>
                )}
              </div>
              <form className="resident-reply-form" onSubmit={save}>
                <div className="section-title">
                  <h3>Update the resident</h3>
                  <span>
                    <ShieldCheck size={14} /> Text only. No footage shared.
                  </span>
                </div>
                <Field
                  label="Report status"
                  hint={
                    lead.incident_id
                      ? "Status follows the linked incident. Update it in Incidents."
                      : undefined
                  }
                >
                  <select
                    disabled={!!lead.incident_id}
                    value={status}
                    onChange={(e) => setStatus(e.target.value)}
                  >
                    <option value="received">Received</option>
                    <option value="in_progress">In progress</option>
                    <option value="resolved">Resolved</option>
                  </select>
                </Field>
                <Field
                  label="Public reply"
                  hint="The resident can see this message. Keep internal notes in the incident record."
                >
                  <textarea
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    placeholder="Tell the resident what your team has done or what happens next…"
                  />
                </Field>
                <Button type="submit">
                  <Send size={16} /> Save resident update
                </Button>
              </form>
            </Panel>
          )}
        </div>
      ) : (
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
                {data.incidents
                  .filter(
                    (i) =>
                      i.location_id === lead?.location_id &&
                      i.status !== "closed",
                  )
                  .map((i) => (
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
