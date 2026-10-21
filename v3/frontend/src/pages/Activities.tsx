import { useEffect, useState, type FormEvent } from "react";
import { Plus, CalendarDays, MapPin, Users, Award, ChevronDown, Check } from "lucide-react";
import { useApp } from "../context";
import { api, json, dateTime, localInput, toUTC, showPoints } from "../api";
import type { Activity } from "../types";
import { Field, Empty, Badge } from "../components/shared";
import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";

const inDays = (days: number) => localInput(new Date(Date.now() + days * 86400000).toISOString());
const blank = () => ({ title: "", description: "", location: "Clubhouse hall", starts_at: inDays(7), capacity: "30", points: "20" });

export default function Activities() {
  const { data, run } = useApp();
  const [items, setItems] = useState<Activity[] | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState("");
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState(blank);
  const load = () =>
    api<Activity[]>("/activities")
      .then((r) => {
        setItems(r);
        setError("");
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, [data]);
  const create = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await run(
      () =>
        api("/activities", {
          method: "POST",
          body: json({
            title: draft.title,
            description: draft.description,
            location: draft.location,
            starts_at: toUTC(draft.starts_at),
            capacity: draft.capacity ? Number(draft.capacity) : null,
            // While points are hidden, new activities award none.
            points: showPoints ? Number(draft.points || 0) : 0,
          }),
        }),
      "Activity published to residents",
    );
    if (ok) {
      setCreating(false);
      setDraft(blank());
    }
  };
  const attendance = (activity: Activity, user_id: string, attended: boolean) =>
    run(
      () =>
        api(`/activities/${activity.id}/attendance`, {
          method: "POST",
          body: json({ user_id, attended }),
        }),
      attended
        ? showPoints ? `Attendance recorded · +${activity.points} points` : "Attendance recorded"
        : "Attendance removed",
    );
  const setStatus = (activity: Activity, status: string) =>
    run(
      () => api("/activities/" + activity.id, { method: "PATCH", body: json({ status }) }),
      status === "cancelled" ? "Activity cancelled" : "Activity restored",
    );
  const upcoming = (items || []).filter((a) => new Date(a.starts_at) >= new Date(Date.now() - 86400000));
  const past = (items || []).filter((a) => new Date(a.starts_at) < new Date(Date.now() - 86400000));
  return (
    <div className="role-page">
      <div className="role-toolbar">
        <p className="role-lede">
          {showPoints
            ? "Residents see published activities in their app, sign up, and earn points when you record their attendance."
            : "Residents see published activities in their app and sign up. Record attendance after each activity."}
        </p>
        <Button onClick={() => setCreating(true)}>
          <Plus size={16} /> New activity
        </Button>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {items && !items.length && (
        <Empty
          icon={CalendarDays}
          title="No activities yet"
          text="Publish a clean-up, briefing or workshop to invite residents."
        />
      )}
      {[
        ["Upcoming", upcoming],
        ["Earlier", past],
      ].map(([heading, list]) =>
        (list as Activity[]).length ? (
          <section key={heading as string} className="activity-section">
            <h2 className="role-heading">{heading as string}</h2>
            <div className="activity-grid">
              {(list as Activity[]).map((a) => {
                const date = new Date(a.starts_at);
                return (
                  <article key={a.id} className={"activity-card" + (a.status === "cancelled" ? " is-cancelled" : "")}>
                    <div className="activity-date" aria-hidden="true">
                      <strong>{date.toLocaleDateString("en-MY", { day: "2-digit", timeZone: "Asia/Kuala_Lumpur" })}</strong>
                      <span>{date.toLocaleDateString("en-MY", { month: "short", timeZone: "Asia/Kuala_Lumpur" })}</span>
                    </div>
                    <div className="activity-body">
                      <div className="task-badges">
                        <Badge value={a.status} />
                        {showPoints && <span className="activity-points"><Award size={13} /> {a.points} pts</span>}
                      </div>
                      <h3>{a.title}</h3>
                      {a.description && <p>{a.description}</p>}
                      <div className="task-meta">
                        <span><CalendarDays size={13} />{dateTime(a.starts_at)}</span>
                        <span><MapPin size={13} />{a.location}</span>
                        <span><Users size={13} />{a.signup_count}{a.capacity ? ` / ${a.capacity}` : ""} signed up</span>
                      </div>
                      <div className="activity-actions">
                        <Button
                          size="sm"
                          variant="outline"
                          aria-expanded={open === a.id}
                          onClick={() => setOpen(open === a.id ? "" : a.id)}
                        >
                          Attendees <ChevronDown size={14} className={open === a.id ? "is-flipped" : ""} />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setStatus(a, a.status === "cancelled" ? "published" : "cancelled")}
                        >
                          {a.status === "cancelled" ? "Restore" : "Cancel activity"}
                        </Button>
                      </div>
                      {open === a.id && (
                        a.attendees?.length ? (
                          <ul className="attendee-list">
                            {a.attendees.map((p) => (
                              <li key={p.user_id}>
                                <span>
                                  <strong>{p.name}</strong>
                                  <small>{p.unit ? "Unit " + p.unit : "Resident"}</small>
                                </span>
                                <label className="attendee-check">
                                  <input
                                    type="checkbox"
                                    checked={p.attended}
                                    onChange={(e) => attendance(a, p.user_id, e.target.checked)}
                                  />
                                  <span>{p.attended ? <><Check size={13} /> Attended</> : "Mark attended"}</span>
                                </label>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="attendee-empty">No sign-ups yet.</p>
                        )
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        ) : null,
      )}
      <Dialog
        open={creating}
        onOpenChange={setCreating}
        title="New community activity"
        description="Published straight to the resident app."
      >
        <form className="stack-form" onSubmit={create}>
          <Field label="Title">
            <input
              required
              minLength={3}
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              placeholder="For example, Merdeka family games"
            />
          </Field>
          <Field label="Description" hint="Optional">
            <textarea
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          </Field>
          <div className="form-pair">
            <Field label="Starts (Malaysia time)">
              <input
                type="datetime-local"
                required
                value={draft.starts_at}
                onChange={(e) => setDraft({ ...draft, starts_at: e.target.value })}
              />
            </Field>
            <Field label="Location">
              <input
                required
                value={draft.location}
                onChange={(e) => setDraft({ ...draft, location: e.target.value })}
              />
            </Field>
          </div>
          <div className="form-pair">
            <Field label="Capacity" hint="Leave empty for no limit">
              <input
                type="number"
                min={1}
                value={draft.capacity}
                onChange={(e) => setDraft({ ...draft, capacity: e.target.value })}
              />
            </Field>
            {showPoints && (
              <Field label="Points for attending">
                <input
                  type="number"
                  min={0}
                  max={500}
                  required
                  value={draft.points}
                  onChange={(e) => setDraft({ ...draft, points: e.target.value })}
                />
              </Field>
            )}
          </div>
          <Button type="submit">Publish activity</Button>
        </form>
      </Dialog>
    </div>
  );
}
