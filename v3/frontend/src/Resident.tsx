import { useState, useEffect, type FormEvent, type ReactNode } from "react";
import {
  MapPin,
  MessageSquare,
  Clock3,
  ArrowRight,
  ArrowLeft,
  Check,
  ShieldCheck,
  Camera,
  LogOut,
  RefreshCw,
  Send,
  ChevronRight,
  X,
  Phone,
  CalendarDays,
  Award,
  Users,
  Gift,
  HeartHandshake,
  CirclePlus,
  ListChecks,
  Timer,
  Sunrise,
  Moon,
  CalendarClock,
  Plus,
} from "lucide-react";
import { api, json, dateTime, clockTime, localInput, toUTC, label, checkSession, showPoints } from "./api";
import { pollUpdates } from "./pollUpdates";
import type { User, Location, Lead, Activity, PointsSummary } from "./types";
import { Brand, Field, Empty } from "./components/shared";
import { EstateMap } from "./components/EstateMap";
import { Button } from "./components/ui/button";
import RubberSegment, { type SegmentItem } from "./components/RubberSegment";
import "./resident.css";
type Props = {
  user: User;
  onLogout: () => void;
};
type Tab = "new" | "reports" | "activities" | "points";
const subtitles: Record<Tab, string> = {
  new: showPoints
    ? "Three small steps. Your security team will follow up, and you earn points for every report."
    : "Three small steps. Your security team will follow up.",
  reports: "Status updates and replies from your property team.",
  activities: showPoints ? "Meet your neighbours and earn points for joining." : "Meet your neighbours at upcoming community events.",
  points: "Earned by helping keep the community safe and active.",
};
const STEPS = [
  { n: 1, name: "Where", icon: MapPin },
  { n: 2, name: "What", icon: MessageSquare },
  { n: 3, name: "When", icon: Clock3 },
];
const TIMES = [
  { value: "now", title: "Just now", hint: "Within the last 30 minutes", icon: Timer },
  { value: "morning", title: "This morning", hint: "06:00–12:00 today", icon: Sunrise },
  { value: "night", title: "Last night", hint: "19:00 yesterday–06:00 today", icon: Moon },
  { value: "custom", title: "Choose a time", hint: "Set your own time range", icon: CalendarClock },
];
const STAGES = ["received", "in_progress", "resolved"];
const isOpen = (lead: Lead) => lead.status === "received" || lead.status === "in_progress";
function greeting() {
  const hour = new Date().getHours();
  if (hour >= 5 && hour <= 11) return "Good morning";
  if (hour >= 12 && hour <= 17) return "Good afternoon";
  return "Good evening";
}
// Residents reach this view from the shared sign-in; App shows it only for resident accounts.
export default function Resident({ user, onLogout }: Props) {
  const [locations, setLocations] = useState<Location[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [points, setPoints] = useState<PointsSummary | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("new");
  const [step, setStep] = useState(1);
  const [loc, setLoc] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [when, setWhen] = useState("now");
  const [timeFrom, setTimeFrom] = useState(localInput());
  const [timeTo, setTimeTo] = useState(localInput());
  const [submitted, setSubmitted] = useState<Lead | null>(null);
  const [expanded, setExpanded] = useState("");
  const placeName = (id: string) => locations.find((l) => l.id === id)?.name ?? "your reported location";
  const helpedResolve = (lead: Lead) => !!lead.linked_case && lead.status === "resolved";
  const helped = leads.filter(helpedResolve).length;
  const active = leads.filter(isOpen).length;
  const resolved = leads.filter((l) => l.status === "resolved").length;
  const upcoming = activities.filter((a) => new Date(a.starts_at) > new Date()).length;
  const initials = user.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
  const load = async () => {
    try {
      const [result, nextActivities, nextPoints] = await Promise.all([
        api<Lead[] | { leads: Lead[] }>("/resident/leads"),
        api<Activity[]>("/activities"),
        showPoints ? api<PointsSummary>("/resident/points") : Promise.resolve(null),
      ]);
      setLeads(Array.isArray(result) ? result : result.leads);
      setActivities(nextActivities);
      setPoints(nextPoints);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    api<{ locations: Location[] }>("/resident/context")
      .then((r) => setLocations(r.locations))
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    load();
  }, [user.id]);
  useEffect(() => {
    if (import.meta.env.VITE_JAGAAI_POLL_UPDATES === "1") return pollUpdates(() => void load());
    const stream = new EventSource("/api/stream");
    stream.onerror = () => { void checkSession().catch(() => {}); };
    stream.addEventListener("refresh", () => load());
    return () => stream.close();
  }, []);
  // A new step starts at the stepper, so the resident is never left below the fold.
  useEffect(() => {
    if (window.scrollY <= 0) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  }, [step, submitted]);
  const openTab = (next: Tab) => {
    window.scrollTo(0, 0);
    setTab(next);
    if (next === "new") setSubmitted(null);
    if (next === "reports") load();
  };
  const act = async (task: () => Promise<unknown>) => {
    setError("");
    try {
      await task();
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const joinActivity = (activity: Activity, join: boolean) =>
    act(() => api(`/activities/${activity.id}/${join ? "join" : "leave"}`, { method: "POST" }));
  const redeem = (reward: PointsSummary["rewards"][number]) => {
    if (!window.confirm(`Redeem ${reward.points} points for "${reward.name}"?`)) return;
    act(() => api("/resident/points/redeem", { method: "POST", body: json({ reward_id: reward.id }) }));
  };
  const range = () => {
    const now = new Date();
    if (when === "custom") return [toUTC(timeFrom), toUTC(timeTo)];
    if (when === "now")
      return [
        new Date(now.getTime() - 30 * 60000).toISOString(),
        now.toISOString(),
      ];
    const myDate = new Date(now.getTime() + 8 * 3600000)
      .toISOString()
      .slice(0, 10);
    if (when === "morning")
      return [toUTC(myDate + "T06:00"), toUTC(myDate + "T12:00")];
    const yesterday = new Date(now.getTime() + 8 * 3600000 - 86400000)
      .toISOString()
      .slice(0, 10);
    return [toUTC(yesterday + "T19:00"), toUTC(myDate + "T06:00")];
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!loc || !text.trim()) return;
    setBusy(true);
    setError("");
    try {
      const [from, to] = range();
      if (new Date(from) > new Date(to))
        throw new Error("The end time must be after the start time.");
      const form = new FormData();
      form.set("location_id", loc);
      form.set("text", text);
      form.set("time_from", from);
      form.set("time_to", to);
      if (photo) form.set("photo", photo);
      const lead = await api<Lead>("/resident/leads", {
        method: "POST",
        body: form,
      });
      setSubmitted(lead);
      await load();
      setStep(1);
      setText("");
      setPhoto(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const titles: Record<Tab, ReactNode> = {
    new: "What did you notice?",
    reports: !leads.length ? (
      "No reports yet."
    ) : active ? (
      <>
        <em>{active}</em> {active === 1 ? "report is" : "reports are"} being followed up.
      </>
    ) : resolved ? (
      <>
        <em className="is-green">{resolved}</em> {resolved === 1 ? "report" : "reports"} resolved.
      </>
    ) : (
      "Your reports were reviewed."
    ),
    activities: upcoming ? (
      <>
        <em>{upcoming}</em> {upcoming === 1 ? "event" : "events"} coming up.
      </>
    ) : (
      "No events planned yet."
    ),
    points: points ? (
      <>
        <em className="is-amber">{points.balance}</em> points to spend.
      </>
    ) : (
      "Your points"
    ),
  };
  const dock: SegmentItem<Tab>[] = [
    { value: "new", label: "Report", icon: <CirclePlus /> },
    { value: "reports", label: "Progress", icon: <ListChecks />, count: active || undefined },
    { value: "activities", label: "Activities", icon: <CalendarDays /> },
    ...(showPoints ? [{ value: "points" as Tab, label: "Points", icon: <Award /> }] : []),
  ];
  const time = TIMES.find((t) => t.value === when);
  return (
    <div className="rp-app">
      <header className="rp-top">
        <Brand small />
        <div className="rp-top-actions">
          {showPoints && (
            <button
              type="button"
              className="rp-points-chip"
              onClick={() => openTab("points")}
              aria-label={`${points?.balance ?? 0} points. Open your points`}
            >
              <Award size={14} /> {points?.balance ?? "—"}
            </button>
          )}
          <span className="rp-avatar" title={user.name} aria-hidden="true">
            {initials}
          </span>
          <button type="button" className="rp-icon-btn" aria-label="Sign out" onClick={onLogout}>
            <LogOut size={18} />
          </button>
        </div>
      </header>
      <main className="rp-main">
        <div className="rp-view" key={tab}>
          <section className="rp-head">
            <p className="rp-label">
              {greeting()}, {user.name}
              {user.unit ? ` · ${user.unit}` : ""}
            </p>
            <h1>{titles[tab]}</h1>
            <p>{subtitles[tab]}</p>
          </section>
          {error && (
            <p className="rp-error" role="alert">
              {error}
            </p>
          )}
          {tab === "new" && submitted ? (
            <section className="rp-card rp-success">
              <span className="rp-success-mark">
                <Check size={30} strokeWidth={2.4} />
              </span>
              <p className="rp-label">Report sent</p>
              <h2>Your report has been received</h2>
              <p>
                The property security team will follow up. Please do not
                intervene or confront anyone yourself.
              </p>
              {showPoints &&
                (submitted.points_awarded ? (
                  <p className="rp-earned">
                    <Award size={15} /> +{submitted.points_awarded} points · thank you for reporting
                  </p>
                ) : (
                  <p className="rp-muted">
                    You have reached today’s points limit for reports. Thank you for reporting.
                  </p>
                ))}
              <dl className="rp-receipt">
                <div>
                  <dt>Reference</dt>
                  <dd className="rp-mono">{submitted.id.slice(0, 8).toUpperCase()}</dd>
                </div>
                <div>
                  <dt>Location</dt>
                  <dd>{placeName(submitted.location_id)}</dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>
                    <Status value="received" />
                  </dd>
                </div>
              </dl>
              <Button
                className="rp-block"
                onClick={() => {
                  openTab("reports");
                  setExpanded(submitted.id);
                  setSubmitted(null);
                }}
              >
                Track your report
                <ChevronRight size={17} />
              </Button>
              <Button variant="ghost" className="rp-block" onClick={() => setSubmitted(null)}>
                <Plus size={16} />
                Make another report
              </Button>
              <EmergencyNote />
            </section>
          ) : tab === "new" ? (
            <>
              <ol className="rp-steps" aria-label={`Step ${step} of 3`}>
                {STEPS.map(({ n, name, icon: Icon }) => (
                  <li key={n} className={step === n ? "active" : step > n ? "complete" : ""}>
                    <span>{step > n ? <Check size={14} strokeWidth={2.6} /> : <Icon size={14} />}</span>
                    <strong>{name}</strong>
                  </li>
                ))}
              </ol>
              <form onSubmit={submit} className="rp-card rp-form">
                <div className="rp-step" key={step}>
                  {step === 1 && (
                    <>
                      <div className="rp-form-head">
                        <p className="rp-label">Step 1 of 3</p>
                        <h2>Where did it happen?</h2>
                        <p>Tap a zone on the map, or choose it below.</p>
                      </div>
                      <EstateMap locations={locations} selected={loc} onSelect={setLoc} caption />
                      <div className="rp-zones">
                        {locations.map((l, i) => (
                          <button
                            type="button"
                            key={l.id}
                            className={l.id === loc ? "active" : ""}
                            aria-pressed={l.id === loc}
                            onClick={() => setLoc(l.id)}
                          >
                            <b aria-hidden="true">{l.id === loc ? <Check size={13} strokeWidth={3} /> : i + 1}</b>
                            <span>{l.name}</span>
                          </button>
                        ))}
                      </div>
                      <label className={"rp-photo" + (photo ? " has-photo" : "")}>
                        <span className="rp-photo-icon">
                          <Camera size={19} />
                        </span>
                        <span>
                          <strong>{photo ? photo.name : "Add a photo"}</strong>
                          <small>Optional. Share only what is needed.</small>
                        </span>
                        <input
                          type="file"
                          accept="image/jpeg,image/png,image/webp"
                          capture="environment"
                          onChange={(e) => setPhoto(e.target.files?.[0] || null)}
                        />
                        {photo ? (
                          <button
                            type="button"
                            aria-label="Remove photo"
                            onClick={(e) => {
                              e.preventDefault();
                              setPhoto(null);
                            }}
                          >
                            <X size={16} />
                          </button>
                        ) : (
                          <Plus size={18} className="rp-photo-add" aria-hidden="true" />
                        )}
                      </label>
                      <Button type="button" className="rp-block" disabled={!loc} onClick={() => setStep(2)}>
                        Continue
                        <ArrowRight size={17} />
                      </Button>
                    </>
                  )}
                  {step === 2 && (
                    <>
                      <div className="rp-form-head">
                        <p className="rp-label">Step 2 of 3 · {placeName(loc)}</p>
                        <h2>Tell us what happened</h2>
                        <p>
                          A short sentence is enough. Include any detail that
                          could help the security team.
                        </p>
                      </div>
                      <Field label="Your observation">
                        <textarea
                          autoFocus
                          required
                          minLength={3}
                          maxLength={2000}
                          value={text}
                          onChange={(e) => setText(e.target.value)}
                          placeholder="For example, I found a scratch on my car door…"
                        />
                      </Field>
                      <div className="rp-examples">
                        <span className="rp-label">Try</span>
                        {[
                          "My car door was scratched.",
                          "A bicycle is missing.",
                          "I noticed someone near the parked cars.",
                        ].map((s) => (
                          <button key={s} type="button" onClick={() => setText(s)}>
                            {s}
                          </button>
                        ))}
                      </div>
                      <div className="rp-actions">
                        <Button type="button" variant="outline" onClick={() => setStep(1)}>
                          <ArrowLeft size={16} />
                          Back
                        </Button>
                        <Button type="button" disabled={text.trim().length < 3} onClick={() => setStep(3)}>
                          Continue
                          <ArrowRight size={17} />
                        </Button>
                      </div>
                    </>
                  )}
                  {step === 3 && (
                    <>
                      <div className="rp-form-head">
                        <p className="rp-label">Step 3 of 3</p>
                        <h2>About when was it?</h2>
                        <p>
                          An approximate time helps the security team find the
                          right footage.
                        </p>
                      </div>
                      <div className="rp-times">
                        {TIMES.map(({ value, title, hint, icon: Icon }) => (
                          <label key={value} className={when === value ? "active" : ""}>
                            <input
                              type="radio"
                              name="when"
                              value={value}
                              checked={when === value}
                              onChange={() => setWhen(value)}
                            />
                            <Icon size={18} />
                            <strong>{title}</strong>
                            <small>{hint}</small>
                          </label>
                        ))}
                      </div>
                      {when === "custom" && (
                        <div className="rp-custom-time">
                          <Field label="From (Malaysia time)">
                            <input
                              type="datetime-local"
                              required
                              value={timeFrom}
                              onChange={(e) => setTimeFrom(e.target.value)}
                            />
                          </Field>
                          <Field label="To (Malaysia time)">
                            <input
                              type="datetime-local"
                              required
                              min={timeFrom}
                              value={timeTo}
                              onChange={(e) => setTimeTo(e.target.value)}
                            />
                          </Field>
                        </div>
                      )}
                      <div className="rp-summary">
                        <p className="rp-label">Your report</p>
                        <strong>
                          <MapPin size={15} />
                          {placeName(loc)}
                        </strong>
                        <blockquote>{text}</blockquote>
                        <span>
                          <Clock3 size={14} />
                          {when === "custom" ? "Custom time range" : `${time?.title} · ${time?.hint}`}
                        </span>
                      </div>
                      <div className="rp-notes">
                        <p className="rp-safety">
                          <ShieldCheck size={17} />
                          <span>
                            The property security team will follow up. Please do
                            not intervene or confront anyone yourself.
                          </span>
                        </p>
                        <EmergencyNote />
                      </div>
                      <div className="rp-actions">
                        <Button type="button" variant="outline" onClick={() => setStep(2)} disabled={busy}>
                          <ArrowLeft size={16} />
                          Back
                        </Button>
                        <Button type="submit" disabled={busy}>
                          {busy ? "Sending…" : "Send report"}
                          <Send size={16} />
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              </form>
            </>
          ) : tab === "activities" ? (
            <ResidentActivities activities={activities} onJoin={joinActivity} />
          ) : tab === "points" ? (
            <ResidentPoints points={points} onRedeem={redeem} />
          ) : (
            <div className="rp-reports">
              {leads.length > 0 && (
                <dl className="rp-card rp-stats">
                  <div>
                    <dt className="rp-label">Sent</dt>
                    <dd>{leads.length}</dd>
                  </div>
                  <div>
                    <dt className="rp-label">Following up</dt>
                    <dd className={active ? "is-blue" : ""}>{active}</dd>
                  </div>
                  <div>
                    <dt className="rp-label">Resolved</dt>
                    <dd className={resolved ? "is-green" : ""}>{resolved}</dd>
                  </div>
                </dl>
              )}
              {helped > 0 && (
                <p className="rp-impact">
                  <span>
                    <HeartHandshake size={19} />
                  </span>
                  <span>
                    <strong>
                      Your reports helped resolve {helped} {helped === 1 ? "case" : "cases"}.
                    </strong>
                    Thank you for looking out for your neighbours.
                  </span>
                </p>
              )}
              <div className="rp-section-head">
                <h2 className="rp-label">{leads.length} {leads.length === 1 ? "report" : "reports"}</h2>
                <Button variant="ghost" size="sm" onClick={load}>
                  <RefreshCw size={14} />
                  Refresh
                </Button>
              </div>
              {leads.length ? (
                leads.map((lead) => (
                  <article className={"rp-card rp-report" + (expanded === lead.id ? " is-open" : "")} key={lead.id}>
                    <button
                      className="rp-report-head"
                      onClick={() => setExpanded(expanded === lead.id ? "" : lead.id)}
                      aria-expanded={expanded === lead.id}
                    >
                      <span className="rp-report-meta">
                        <Status value={lead.status} />
                        <small className="rp-mono">{dateTime(lead.created_at)}</small>
                      </span>
                      <h3>{lead.text}</h3>
                      <span className="rp-report-loc">
                        <MapPin size={14} />
                        {placeName(lead.location_id)}
                      </span>
                      {lead.status !== "invalid" && <Track status={lead.status} />}
                      {helpedResolve(lead) && (
                        <span className="rp-impact-line">
                          <HeartHandshake size={14} />
                          Helped resolve a case at {placeName(lead.location_id)}
                        </span>
                      )}
                      <span className="rp-report-cta">
                        {lead.public_reply ? "Read the team’s reply" : "View report progress"}
                        <ChevronRight size={16} />
                      </span>
                    </button>
                    {expanded === lead.id && (
                      <div className="rp-report-body">
                        {lead.photo_url && (
                          <img
                            className="rp-report-photo"
                            src={lead.photo_url}
                            alt="Photo you attached to this report"
                            loading="lazy"
                          />
                        )}
                        <div className="rp-reply">
                          <span className="rp-reply-avatar" aria-hidden="true">
                            <ShieldCheck size={16} />
                          </span>
                          <div>
                            <strong>Property security team</strong>
                            <p>
                              {lead.public_reply ||
                                (lead.status === "invalid"
                                  ? showPoints
                                    ? "The security team reviewed this report and marked it as not valid, so it does not earn points."
                                    : "The security team reviewed this report and marked it as not valid."
                                  : helpedResolve(lead)
                                  ? `Your report helped the security team resolve a case at ${placeName(lead.location_id)}. Thank you for letting us know.`
                                  : lead.status === "resolved"
                                  ? "The team has completed follow-up on your report."
                                  : lead.linked_case
                                    ? "Your report is now part of an active case. The team is following up and will share an update here."
                                    : lead.status === "in_progress"
                                    ? "The team is following up on your report. Further updates will appear here."
                                    : "Your report has been received. The team will share an update here.")}
                            </p>
                          </div>
                        </div>
                        <p className="rp-report-time">
                          <span className="rp-label">Reported time</span>
                          <span className="rp-mono">
                            {dateTime(lead.time_from)} – {dateTime(lead.time_to)} MYT
                          </span>
                        </p>
                      </div>
                    )}
                  </article>
                ))
              ) : (
                <Empty
                  icon={MessageSquare}
                  title="No reports yet"
                  text="When you report an observation, its progress and the team’s reply appear here."
                  action={<Button onClick={() => openTab("new")}>Make a report</Button>}
                />
              )}
            </div>
          )}
        </div>
        <footer className="rp-footer">
          <ShieldCheck size={13} />
          <span>Private property reporting · JagaAI</span>
        </footer>
      </main>
      <nav className="rp-dock" aria-label="Resident sections">
        <RubberSegment
          semantics="tabs"
          block
          size="lg"
          radius={22}
          inset={6}
          aria-label="Resident sections"
          className="rp-dock-switch"
          value={tab}
          onChange={openTab}
          items={dock}
        />
      </nav>
    </div>
  );
}
function Status({ value }: { value: string }) {
  return (
    <span className={"rp-status is-" + value}>
      <i aria-hidden="true" />
      {label(value)}
    </span>
  );
}
// Received → In progress → Resolved: earlier stages are ticked, the current one is highlighted.
function Track({ status }: { status: string }) {
  const at = STAGES.indexOf(status);
  return (
    <ol className="rp-track" aria-label={`Progress: ${label(status)}`}>
      {STAGES.map((s, i) => {
        const done = i < at || (i === at && s === "resolved");
        return (
          <li key={s} className={done ? "done" : i === at ? "current" : ""}>
            <span aria-hidden="true">{done && <Check size={10} strokeWidth={3.2} />}</span>
            <small>{label(s)}</small>
          </li>
        );
      })}
    </ol>
  );
}
function EmergencyNote() {
  return (
    <p className="rp-emergency" role="note">
      <Phone size={15} />
      <span>
        This page is for non-urgent observations. If someone is in danger right
        now, call <a href="tel:999">999</a>.
      </span>
    </p>
  );
}
function ResidentActivities({
  activities,
  onJoin,
}: {
  activities: Activity[];
  onJoin: (activity: Activity, join: boolean) => void;
}) {
  if (!activities.length)
    return (
      <Empty
        icon={CalendarDays}
        title="No activities planned yet"
        text="Your management office will publish community events here."
      />
    );
  const tz = { timeZone: "Asia/Kuala_Lumpur" } as const;
  return (
    <div className="rp-activities">
      {activities.map((a) => {
        const date = new Date(a.starts_at);
        const full = !!a.capacity && a.signup_count >= a.capacity && !a.joined;
        const started = date <= new Date();
        const filled = a.capacity ? Math.min(100, (a.signup_count / a.capacity) * 100) : 0;
        return (
          <article className={"rp-card rp-activity" + (a.joined ? " is-joined" : "")} key={a.id}>
            <div className="rp-activity-date" aria-hidden="true">
              <span>{date.toLocaleDateString("en-MY", { weekday: "short", ...tz })}</span>
              <strong>{date.toLocaleDateString("en-MY", { day: "2-digit", ...tz })}</strong>
              <span>{date.toLocaleDateString("en-MY", { month: "short", ...tz })}</span>
            </div>
            <div className="rp-activity-body">
              <h3>{a.title}</h3>
              {a.description && <p>{a.description}</p>}
              <ul className="rp-activity-meta">
                <li>
                  <Clock3 size={13} />
                  <time dateTime={a.starts_at} title={dateTime(a.starts_at)}>
                    {clockTime(a.starts_at)}
                  </time>
                </li>
                <li>
                  <MapPin size={13} />
                  {a.location}
                </li>
              </ul>
              <div className="rp-capacity">
                <Users size={13} />
                <span className="rp-mono">
                  {a.signup_count}
                  {a.capacity ? ` / ${a.capacity}` : ""} going
                </span>
                {!!a.capacity && (
                  <span className="rp-bar" aria-hidden="true">
                    <i style={{ width: `${filled}%` }} />
                  </span>
                )}
              </div>
              <div className="rp-activity-foot">
                {showPoints && (
                  <span className="rp-pts">
                    <Award size={13} /> +{a.points} pts
                  </span>
                )}
                {a.attended ? (
                  <span className="rp-attended">
                    <Check size={14} /> Attended
                  </span>
                ) : a.joined ? (
                  <Button size="sm" variant="outline" disabled={started} onClick={() => onJoin(a, false)}>
                    <Check size={14} /> Going · Cancel
                  </Button>
                ) : (
                  <Button size="sm" disabled={full || started} onClick={() => onJoin(a, true)}>
                    {full ? "Full" : started ? "Closed" : "Join"}
                  </Button>
                )}
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}
function ResidentPoints({
  points,
  onRedeem,
}: {
  points: PointsSummary | null;
  onRedeem: (reward: PointsSummary["rewards"][number]) => void;
}) {
  if (!points)
    return <Empty icon={Award} title="Loading your points" text="One moment…" />;
  const next = [...points.rewards]
    .sort((a, b) => a.points - b.points)
    .find((r) => r.points > points.balance);
  return (
    <div className="rp-points">
      <section className="rp-balance">
        <div className="rp-balance-top">
          <span className="rp-label">Available balance</span>
          <Award size={20} />
        </div>
        <p className="rp-balance-value">
          <strong>{points.balance}</strong>
          <span>pts</span>
        </p>
        {next && (
          <div className="rp-balance-next">
            <span className="rp-bar" aria-hidden="true">
              <i style={{ width: `${(points.balance / next.points) * 100}%` }} />
            </span>
            <small>
              {next.points - points.balance} pts to <b>{next.name}</b>
            </small>
          </div>
        )}
        <dl className="rp-earn">
          <div>
            <dt>Per report</dt>
            <dd>+{points.report_points}</dd>
          </div>
          <div>
            <dt>Reports a day</dt>
            <dd>{points.report_points_per_day}</dd>
          </div>
          <div>
            <dt>Activities</dt>
            <dd>Bonus</dd>
          </div>
        </dl>
      </section>
      <h2 className="rp-label rp-section-title">Rewards</h2>
      <ul className="rp-rewards">
        {points.rewards.map((r) => {
          const ready = points.balance >= r.points;
          return (
            <li key={r.id} className={"rp-card" + (ready ? " is-ready" : "")}>
              <span className="rp-reward-icon">
                <Gift size={18} />
              </span>
              <span className="rp-reward-body">
                <strong>{r.name}</strong>
                <small className="rp-mono">{r.points} pts</small>
                <span className="rp-bar" aria-hidden="true">
                  <i style={{ width: `${Math.min(100, (points.balance / r.points) * 100)}%` }} />
                </span>
              </span>
              {ready ? (
                <Button size="sm" onClick={() => onRedeem(r)}>
                  Redeem
                </Button>
              ) : (
                <span className="rp-togo">{r.points - points.balance} to go</span>
              )}
            </li>
          );
        })}
      </ul>
      <h2 className="rp-label rp-section-title">History</h2>
      {points.history.length ? (
        <ul className="rp-card rp-history">
          {points.history.map((h) => (
            <li key={h.id}>
              <span className={"rp-history-dot" + (h.points < 0 ? " is-spent" : "")} aria-hidden="true">
                {h.points < 0 ? <Gift size={13} /> : <Plus size={13} strokeWidth={2.6} />}
              </span>
              <span>
                <strong>{h.reason}</strong>
                <small className="rp-mono">{dateTime(h.created_at)}</small>
              </span>
              <b className={h.points < 0 ? "is-spent" : ""}>
                {h.points > 0 ? "+" : ""}
                {h.points}
              </b>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rp-muted">No points yet. Make a report or join an activity to start.</p>
      )}
    </div>
  );
}
