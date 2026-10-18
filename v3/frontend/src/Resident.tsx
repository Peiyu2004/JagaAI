import { useState, useEffect, type FormEvent } from "react";
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
} from "lucide-react";
import { api, json, dateTime, localInput, toUTC, label, checkSession } from "./api";
import type { User, Location, Lead } from "./types";
import { Brand, Field, SiteMap, Badge, Empty } from "./components/shared";
import { Button } from "./components/ui/button";
type Props = {
  user: User | null | undefined;
  setUser: (user: User | null) => void;
  sessionError?: string;
};
export default function Resident({ user, setUser, sessionError = "" }: Props) {
  const [locations, setLocations] = useState<Location[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState(sessionError);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState("new");
  const [step, setStep] = useState(1);
  const [loc, setLoc] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [when, setWhen] = useState("now");
  const [timeFrom, setTimeFrom] = useState(localInput());
  const [timeTo, setTimeTo] = useState(localInput());
  const [submitted, setSubmitted] = useState<Lead | null>(null);
  const [expanded, setExpanded] = useState("");
  const resident = user?.role === "resident";
  const load = async () => {
    try {
      const result = await api<Lead[] | { leads: Lead[] }>("/resident/leads");
      setLeads(Array.isArray(result) ? result : result.leads);
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
    if (resident) load();
  }, [user?.id]);
  useEffect(() => {
    if (!resident) return;
    const stream = new EventSource("/api/stream");
    stream.onerror = () => { void checkSession().catch(() => {}); };
    stream.addEventListener("refresh", () => load());
    return () => stream.close();
  }, [resident]);
  const login = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api<{ user: User }>("/auth/resident", {
        method: "POST",
        body: json({ email, code }),
      });
      setUser(result.user);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const logout = async () => {
    try {
      await api("/auth/logout", { method: "POST" });
      setUser(null);
      setLeads([]);
    } catch (e) {
      setError((e as Error).message);
    }
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
    if (!resident || !loc || !text.trim()) return;
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
  return (
    <div className="resident-page">
      <header className="resident-header">
        <Brand small />
        {resident && (
          <button aria-label="Sign out" onClick={logout}>
            <LogOut size={19} />
          </button>
        )}
      </header>
      <main className="resident-main">
        {user === undefined ? (
          <Empty
            title="Opening your report page"
            text="Connecting to the local property workspace…"
          />
        ) : !resident ? (
          <>
            <div className="resident-intro">
              <span className="resident-intro-icon">
                <MessageSquare size={30} strokeWidth={1.4} />
              </span>
              <h1>
                A small observation.
                <br />A safer neighbourhood.
              </h1>
              <p>
                Tell your property security team what happened. Your report is
                private and you can follow the response here.
              </p>
            </div>
            <form className="resident-login stack-form" onSubmit={login}>
              <h2>Make a quick report</h2>
              <Field label="Your email">
                <input
                  type="email"
                  autoComplete="email"
                  value={email}
                  required
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                />
              </Field>
              <Field label="Verification code">
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  autoComplete="one-time-code"
                  value={code}
                  required
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  placeholder="6-digit code"
                />
              </Field>
              <div className="resident-dev-note">
                Local development sign-in: use code <strong>246810</strong>. No
                email is sent.
              </div>
              {error && (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
              <Button type="submit" disabled={busy}>
                {busy ? "Signing in…" : "Continue"}
                <ArrowRight size={17} />
              </Button>
            </form>
            <div className="resident-privacy">
              <ShieldCheck size={18} />
              <p>
                You see only your own reports and replies. Camera recordings are
                private to the security team.
              </p>
            </div>
          </>
        ) : (
          <>
            <div className="resident-welcome">
              <h1>{tab === "new" ? "What did you notice?" : "Your reports"}</h1>
              <p>
                {tab === "new"
                  ? "Three small steps. Your security team will follow up."
                  : "Status updates and replies from your property team."}
              </p>
            </div>
            <div className="resident-tabs">
              <button
                className={tab === "new" ? "active" : ""}
                onClick={() => {
                  setTab("new");
                  setSubmitted(null);
                }}
              >
                New report
              </button>
              <button
                className={tab === "reports" ? "active" : ""}
                onClick={() => {
                  setTab("reports");
                  load();
                }}
              >
                My reports <span>{leads.length}</span>
              </button>
            </div>
            {error && (
              <p className="form-error resident-error" role="alert">
                {error}
              </p>
            )}
            {tab === "new" && submitted ? (
              <div className="resident-success">
                <span>
                  <Check size={32} />
                </span>
                <h2>Your report has been received</h2>
                <p>
                  The property security team will follow up. Please do not
                  intervene or confront anyone yourself.
                </p>
                <EmergencyNote />
                <div>
                  <Badge value="received" />
                  <small>Report {submitted.id.slice(0, 8)}</small>
                </div>
                <Button
                  onClick={() => {
                    setTab("reports");
                    setExpanded(submitted.id);
                    setSubmitted(null);
                  }}
                >
                  Track your report
                  <ChevronRight size={17} />
                </Button>
              </div>
            ) : tab === "new" ? (
              <>
                <ol className="resident-steps">
                  {[
                    { n: 1, name: "Where", icon: MapPin },
                    { n: 2, name: "What", icon: MessageSquare },
                    { n: 3, name: "When", icon: Clock3 },
                  ].map(({ n, name, icon: Icon }) => (
                    <li
                      key={n}
                      className={
                        step === n ? "active" : step > n ? "complete" : ""
                      }
                    >
                      <span>
                        {step > n ? <Check size={16} /> : <Icon size={16} />}
                      </span>
                      <strong>{name}</strong>
                    </li>
                  ))}
                </ol>
                <form onSubmit={submit} className="resident-report-form">
                  {step === 1 && (
                    <>
                      <h2>Where did it happen?</h2>
                      <p>Tap a zone on the map, or choose it below.</p>
                      <SiteMap
                        locations={locations}
                        selected={loc}
                        onSelect={setLoc}
                      />
                      <div className="resident-locations">
                        {locations.map((l) => (
                          <button
                            type="button"
                            key={l.id}
                            className={l.id === loc ? "active" : ""}
                            onClick={() => setLoc(l.id)}
                          >
                            <MapPin size={17} />
                            <span>{l.name}</span>
                            {l.id === loc && <Check size={17} />}
                          </button>
                        ))}
                      </div>
                      <label className="resident-photo">
                        <Camera size={21} />
                        <span>
                          <strong>{photo ? photo.name : "Add a photo"}</strong>
                          <small>Optional. Share only what is needed.</small>
                        </span>
                        <input
                          type="file"
                          accept="image/jpeg,image/png,image/webp"
                          capture="environment"
                          onChange={(e) =>
                            setPhoto(e.target.files?.[0] || null)
                          }
                        />
                        {photo && (
                          <button
                            type="button"
                            aria-label="Remove photo"
                            onClick={(e) => {
                              e.preventDefault();
                              setPhoto(null);
                            }}
                          >
                            <X size={17} />
                          </button>
                        )}
                      </label>
                      <Button
                        type="button"
                        disabled={!loc}
                        onClick={() => setStep(2)}
                      >
                        Continue
                        <ArrowRight size={17} />
                      </Button>
                    </>
                  )}
                  {step === 2 && (
                    <>
                      <h2>Tell us what happened</h2>
                      <p>
                        A short sentence is enough. Include any detail that
                        could help the security team.
                      </p>
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
                      <div className="resident-examples">
                        <span>Examples</span>
                        {[
                          "My car door was scratched.",
                          "A bicycle is missing.",
                          "I noticed someone near the parked cars.",
                        ].map((s) => (
                          <button
                            key={s}
                            type="button"
                            onClick={() => setText(s)}
                          >
                            {s}
                          </button>
                        ))}
                      </div>
                      <div className="resident-step-actions">
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => setStep(1)}
                        >
                          <ArrowLeft size={16} />
                          Back
                        </Button>
                        <Button
                          type="button"
                          disabled={text.trim().length < 3}
                          onClick={() => setStep(3)}
                        >
                          Continue
                          <ArrowRight size={17} />
                        </Button>
                      </div>
                    </>
                  )}
                  {step === 3 && (
                    <>
                      <h2>About when was it?</h2>
                      <p>
                        An approximate time helps the security team find the
                        right footage.
                      </p>
                      <div className="resident-time-options">
                        {[
                          ["now", "Just now", "Within the last 30 minutes"],
                          ["morning", "This morning", "06:00–12:00 today"],
                          [
                            "night",
                            "Last night",
                            "19:00 yesterday–06:00 today",
                          ],
                          [
                            "custom",
                            "Choose a time",
                            "Set your own time range",
                          ],
                        ].map(([value, title, hint]) => (
                          <label
                            key={value}
                            className={when === value ? "active" : ""}
                          >
                            <input
                              type="radio"
                              name="when"
                              value={value}
                              checked={when === value}
                              onChange={() => setWhen(value)}
                            />
                            <span>
                              <strong>{title}</strong>
                              <small>{hint}</small>
                            </span>
                          </label>
                        ))}
                      </div>
                      {when === "custom" && (
                        <div className="stack-form">
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
                      <div className="resident-confirmation">
                        <MapPin size={16} />
                        <span>
                          <strong>
                            {locations.find((l) => l.id === loc)?.name}
                          </strong>
                          <p>{text}</p>
                        </span>
                      </div>
                      <div className="resident-safety">
                        <ShieldCheck size={19} />
                        <p>
                          The property security team will follow up. Please do
                          not intervene or confront anyone yourself.
                        </p>
                      </div>
                      <EmergencyNote />
                      <div className="resident-step-actions">
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => setStep(2)}
                          disabled={busy}
                        >
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
                </form>
              </>
            ) : (
              <div className="resident-reports">
                <div className="row-between">
                  <span>{leads.length} reports</span>
                  <Button variant="ghost" size="sm" onClick={load}>
                    <RefreshCw size={14} />
                    Refresh
                  </Button>
                </div>
                {leads.length ? (
                  leads.map((lead) => (
                    <article className="resident-report-card" key={lead.id}>
                      <button
                        onClick={() =>
                          setExpanded(expanded === lead.id ? "" : lead.id)
                        }
                        aria-expanded={expanded === lead.id}
                      >
                        <div className="row-between">
                          <Badge value={lead.status} />
                          <small>{dateTime(lead.created_at)}</small>
                        </div>
                        <h2>{lead.text}</h2>
                        <p>
                          <MapPin size={14} />
                          {
                            locations.find((l) => l.id === lead.location_id)
                              ?.name
                          }
                        </p>
                        <span className="resident-view-update">
                          {lead.public_reply
                            ? "Read the team’s reply"
                            : "View report progress"}
                          <ChevronRight size={15} />
                        </span>
                      </button>
                      {expanded === lead.id && (
                        <div className="resident-report-progress">
                          <ol>
                            {["received", "in_progress", "resolved"].map(
                              (s, i) => (
                                <li
                                  key={s}
                                  className={
                                    [
                                      "received",
                                      "in_progress",
                                      "resolved",
                                    ].indexOf(lead.status) >= i
                                      ? "complete"
                                      : ""
                                  }
                                >
                                  <span>
                                    <Check size={13} />
                                  </span>
                                  {label(s)}
                                </li>
                              ),
                            )}
                          </ol>
                          {lead.photo_url && (
                            <img
                              className="resident-report-photo"
                              src={lead.photo_url}
                              alt="Photo you attached to this report"
                              loading="lazy"
                            />
                          )}
                          <div className="resident-public-reply">
                            <strong>Property security team</strong>
                            <p>
                              {lead.public_reply ||
                                (lead.status === "resolved"
                                  ? "The team has completed follow-up on your report."
                                  : lead.status === "in_progress"
                                    ? "The team is following up on your report. Further updates will appear here."
                                    : "Your report has been received. The team will share an update here.")}
                            </p>
                          </div>
                          <small>
                            Reported time: {dateTime(lead.time_from)} –{" "}
                            {dateTime(lead.time_to)} MYT
                          </small>
                        </div>
                      )}
                    </article>
                  ))
                ) : (
                  <Empty
                    icon={MessageSquare}
                    title="No reports yet"
                    text="When you report an observation, its progress and the team’s reply appear here."
                    action={
                      <Button onClick={() => setTab("new")}>
                        Make a report
                      </Button>
                    }
                  />
                )}
              </div>
            )}
          </>
        )}
        <footer className="resident-footer">
          <ShieldCheck size={14} />
          <span>Private property reporting · JagaAI</span>
        </footer>
      </main>
    </div>
  );
}
function EmergencyNote() {
  return (
    <p className="resident-emergency" role="note">
      <Phone size={15} />
      <span>
        This page is for non-urgent observations. If someone is in danger right
        now, call <a href="tel:999">999</a>.
      </span>
    </p>
  );
}
