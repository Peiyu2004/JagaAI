import RubberSegment from "../components/RubberSegment";
import { useState, useEffect, useRef, type FormEvent } from "react";
import {
  Bell,
  Camera,
  Check,
  Info,
  Link,
  Play,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { useApp } from "../context";
import { api, json, dateTime, duration, label, relativeTime, cameraName as displayCameraName } from "../api";
import { Empty, Badge, Field, VideoPlayer } from "../components/shared";
import type { Alert } from "../types";
import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";
import { SlideConfirm } from "../components/SlideConfirm";

const REASONS = [
  {
    label: "Normal activity",
    text: "Normal activity: the person had a legitimate reason to be there (resident, staff or contractor).",
  },
  {
    label: "Duplicate trigger",
    text: "Duplicate trigger: the same event is already covered by another alert.",
  },
  {
    label: "Wrong detection",
    text: "Wrong detection: the recording does not show the configured behaviour.",
  },
];

const focusCard = (id: string) =>
  requestAnimationFrame(() =>
    document
      .querySelector(`[data-alert-id="${id}"]`)
      ?.scrollIntoView({ block: "nearest" }),
  );

const secs = (n: number) =>
  n >= 60
    ? `${Math.floor(n / 60)} min ${Math.round(n % 60)} s`
    : `${Math.round(n * 10) / 10} s`;

function evidenceRows(m: Record<string, unknown>) {
  const rows: { name: string; value: string; wide?: boolean }[] = [];
  const used = new Set<string>();
  const add = (key: string, name: string, value: string, wide = false) => {
    used.add(key);
    rows.push({ name, value, wide });
  };
  used.add("crossed_line");
  used.add("entered_zone");
  if (m.crossed_line === true)
    rows.push({
      name: "What triggered it",
      value: "Crossed the configured boundary line",
      wide: true,
    });
  if (m.entered_zone === true)
    rows.push({
      name: "What triggered it",
      value: "Entered the restricted area",
      wide: true,
    });
  if (typeof m.dwell_sec === "number")
    add("dwell_sec", "Time in parking zone", secs(m.dwell_sec));
  if (typeof m.distinct_vehicles === "number")
    add(
      "distinct_vehicles",
      "Different vehicles approached",
      String(m.distinct_vehicles),
    );
  if (typeof m.threshold_sec === "number")
    add("threshold_sec", "Alert threshold", secs(m.threshold_sec));
  if (typeof m.active_hours === "string")
    add(
      "active_hours",
      "Rule active hours",
      m.active_hours === "00:00–00:00" ? "All day" : m.active_hours + " MYT",
    );
  if (m.person_check && typeof m.person_check === "object") {
    const c = m.person_check as { passed?: boolean; score?: number };
    add(
      "person_check",
      "Person re-check",
      (c.passed ? "Passed" : "Not passed") +
        (typeof c.score === "number" ? ` · score ${c.score.toFixed(2)}` : ""),
    );
  }
  if (m.track_id !== undefined)
    add("track_id", "Tracked person", "ID " + String(m.track_id));
  for (const [k, v] of Object.entries(m))
    if (!used.has(k))
      rows.push({
        name: label(k),
        value:
          typeof v === "boolean"
            ? v
              ? "Yes"
              : "No"
            : v && typeof v === "object"
              ? JSON.stringify(v)
              : String(v),
      });
  return rows;
}

const seek = (t: number) => {
  const video = document.querySelector<HTMLVideoElement>(
    ".review-stage video, .review-main video",
  );
  if (!video) return;
  video.currentTime = t;
  video.play().catch(() => {});
};

export default function Alerts() {
  const { data, run, alertTarget } = useApp();
  const [filter, setFilter] = useState(() => {
    const target = data.alerts.find((a) => a.id === alertTarget);
    return target?.status || "pending";
  });
  const [selected, setSelected] = useState(alertTarget || "");
  const [mode, setMode] = useState<"confirm" | "dismiss" | "link" | null>(null);
  const [reason, setReason] = useState("");
  const [incident, setIncident] = useState("");
  const [busy, setBusy] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const reviewLock = useRef(false);
  const reviewTarget = useRef("");
  const reviewRef = useRef<HTMLDivElement>(null);
  const appliedTarget = useRef("");

  const alerts = data.alerts
    .filter((a) => a.status === filter)
    .sort(
      (a, b) =>
        (({ urgent: 0, high: 1, normal: 2 })[a.priority] ?? 3) -
        ({ urgent: 0, high: 1, normal: 2 }[b.priority] ?? 3),
    );
  const alert = (alerts.find((a) => a.id === selected) || alerts[0]) as Alert;
  const event = alert?.event;
  const video = data.videos.find((v) => v.id === event?.video_id);
  const reviewAlert = data.alerts.find((a) => a.id === reviewTarget.current);
  const pendingTotal = data.alerts.filter((a) => a.status === "pending").length;
  const currentIndex = alerts.findIndex((a) => a.id === alert?.id);
  const frame =
    alert?.scene?.keyframe_url ||
    event?.keyframes?.find((url) => url.startsWith("/api/")) ||
    video?.thumbnail_url;
  const frames = (event?.keyframes || []).filter((url) =>
    url.startsWith("/api/"),
  );

  useEffect(() => {
    if (!alertTarget) {
      appliedTarget.current = "";
      return;
    }
    if (appliedTarget.current === alertTarget) return;
    const target = data.alerts.find((a) => a.id === alertTarget);
    if (!target) return;
    appliedTarget.current = alertTarget;
    setFilter(target.status);
    setSelected(target.id);
    focusCard(target.id);
  }, [alertTarget, data.alerts]);

  const openReview = (value: "confirm" | "dismiss" | "link") => {
    if (!alert || reviewLock.current) return;
    reviewTarget.current = alert.id;
    setReviewed(false);
    setMode(value);
  };

  const review = async (action: string, holdMs = 0): Promise<boolean> => {
    const target = data.alerts.find((a) => a.id === reviewTarget.current);
    if (
      !target ||
      target.status !== "pending" ||
      reviewLock.current ||
      (action === "confirm" && !reviewed)
    )
      return false;
    reviewLock.current = true;
    const i = alerts.findIndex((a) => a.id === target.id);
    const next = alerts[i + 1] || alerts[i - 1];
    setBusy(true);
    let ok = false;
    try {
      ok = await run(
        () =>
          api("/alerts/" + target.id + "/review", {
            method: "POST",
            body: json({
              action,
              dismiss_reason: reason,
              incident_id: incident || undefined,
            }),
          }),
        action === "confirm"
          ? "Alert confirmed and incident created"
          : action === "link"
            ? "Alert linked to incident"
            : "Alert dismissed",
      );
      if (ok) {
        const close = () => {
          setMode(null);
          setReason("");
          setSelected(next?.id || "");
          if (next) focusCard(next.id);
        };
        // The slide-to-confirm keeps the dialog up a moment so its success state is seen.
        if (holdMs > 0) window.setTimeout(close, holdMs);
        else close();
      }
    } finally {
      reviewLock.current = false;
      setBusy(false);
    }
    return ok;
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('input,textarea,select,[contenteditable="true"]')) return;
      const k = e.key.toLowerCase();
      if (mode) {
        if (mode === "dismiss" && ["1", "2", "3"].includes(k)) {
          e.preventDefault();
          setReason(REASONS[Number(k) - 1].text);
        }
        return;
      }
      if (document.querySelector('[role="dialog"]') || !alert) return;
      if (t && t !== document.body && !t.closest(".review-workspace")) return;
      if (k === "j" || k === "k") {
        const i = alerts.findIndex((a) => a.id === alert.id);
        const n =
          alerts[
            Math.max(0, Math.min(alerts.length - 1, i + (k === "j" ? 1 : -1)))
          ];
        e.preventDefault();
        setSelected(n.id);
        focusCard(n.id);
        return;
      }
      if (k === " ") {
        if (t?.closest("button,a,video")) return;
        const v = document.querySelector<HTMLVideoElement>(
          ".review-stage video, .review-main video",
        );
        if (v) {
          e.preventDefault();
          if (v.paused) v.play().catch(() => {});
          else v.pause();
        }
        return;
      }
      if (alert.status !== "pending" || busy) return;
      if (k === "c") {
        e.preventDefault();
        openReview("confirm");
      } else if (k === "d") {
        e.preventDefault();
        openReview("dismiss");
      } else if (k === "l" && data.incidents.length) {
        e.preventDefault();
        openReview("link");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (mode) review(mode);
  };

  return (
    <>
      <div className="alert-toolbar">
        <RubberSegment
          semantics="tabs"
          aria-label="Alert status"
          className="alert-switch"
          value={filter}
          onChange={(status) => {
            setFilter(status);
            setSelected("");
          }}
          items={["pending", "confirmed", "dismissed"].map((status) => ({
            value: status,
            label: status === "pending" ? "Pending" : label(status),
            count: data.alerts.filter((a) => a.status === status).length,
          }))}
        />
        <div className="review-progress">
          <span className={"live-dot " + (pendingTotal ? "" : "off")} />
          {filter === "pending"
            ? `${pendingTotal} pending review`
            : `${alerts.length} ${label(filter).toLowerCase()}`}
          {alerts.length > 0 && (
            <strong>
              {currentIndex + 1} of {alerts.length}
            </strong>
          )}
        </div>
      </div>

      {!alerts.length ? (
        <div className="panel empty-panel">
          <Empty
            icon={Bell}
            title={
              filter === "pending"
                ? "No alerts awaiting review"
                : "No " + filter + " alerts"
            }
            text={
              filter === "pending"
                ? "Alerts are created only when a recording triggers an enabled rule. Start by uploading a recording in Cameras."
                : "Reviewed alerts will appear here with the recorded decision."
            }
            action={
              filter === "pending" ? (
                <Button
                  variant="outline"
                  onClick={() => (location.hash = "cameras")}
                >
                  Open cameras
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className="review-workspace" ref={reviewRef}>
          <aside className="review-queue" aria-label="Alert queue">
            <div className="review-queue-head">
              <strong>Queue</strong>
              <span>{alerts.length}</span>
            </div>
            <div className="review-queue-list">
              {alerts.map((item) => {
                const itemVideo = data.videos.find(
                  (v) => v.id === item.event?.video_id,
                );
                const itemFrame =
                  item.scene?.keyframe_url ||
                  item.event?.keyframes?.find((url) =>
                    url.startsWith("/api/"),
                  ) ||
                  itemVideo?.thumbnail_url;
                return (
                  <button
                    key={item.id}
                    data-alert-id={item.id}
                    onClick={() => setSelected(item.id)}
                    aria-current={item.id === alert?.id ? "true" : undefined}
                    className={
                      "review-queue-row " +
                      (item.id === alert?.id ? "active" : "")
                    }
                  >
                    <span className="review-queue-thumb">
                      {itemFrame ? (
                        <img src={itemFrame} alt="" loading="lazy" />
                      ) : (
                        <Camera size={16} />
                      )}
                    </span>
                    <span className="review-queue-body">
                      <span className="review-queue-title">
                        <strong>{label(item.event?.type || "alert")}</strong>
                        <Badge value={item.priority} />
                      </span>
                      <small>
                        {displayCameraName(
                          data.cameras.find(
                            (c) => c.id === item.event?.camera_id,
                          )?.name,
                        )}{" "}
                        · {relativeTime(item.created_at)}
                      </small>
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="review-queue-foot">
              <span>
                <kbd>J</kbd>
                <kbd>K</kbd> move
              </span>
              <span>
                <kbd>C</kbd> review
              </span>
            </div>
          </aside>

          <section className="review-main">
            <div className="review-main-head">
              <div>
                <span className="record-id">
                  Alert {alert.id.slice(0, 8)}
                </span>
                <h2>{label(event?.type || "alert")}</h2>
                <p>
                  {displayCameraName(
                    data.cameras.find((c) => c.id === event?.camera_id)?.name,
                  )}{" "}
                  · {dateTime(alert.created_at)} MYT ·{" "}
                  {duration(event?.start_sec || 0)} –{" "}
                  {duration(event?.end_sec || 0)}
                </p>
              </div>
              <Badge value={alert.status} />
            </div>
            <div className="review-stage">
              {video ? (
                <VideoPlayer video={video} at={event?.start_sec} poster={frame} />
              ) : (
                <Empty
                  compact
                  icon={Play}
                  title="Recording unavailable"
                  text="The review record remains, but its source video may have expired."
                />
              )}
            </div>
            {frames.length > 0 && (
              <div className="keyframe-strip">
                <div className="keyframe-strip-head">
                  <strong>Trigger frames</strong>
                  <span>Click a frame to move the video</span>
                </div>
                <div className="keyframe-list">
                  {frames.slice(0, 4).map((url) => (
                    <button
                      type="button"
                      key={url}
                      disabled={!video}
                      onClick={() => seek(event?.start_sec || 0)}
                      aria-label={
                        "Trigger frame at " + duration(event?.end_sec || 0) +
                        "; play recording from " + duration(event?.start_sec || 0)
                      }
                    >
                      <img
                        src={url}
                        alt={
                          "Annotated frame at " +
                          duration(event?.end_sec || 0)
                        }
                        loading="lazy"
                      />
                      <span>
                        <Play size={11} /> {duration(event?.end_sec || 0)}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </section>

          <aside className="review-side" aria-label="Alert evidence" tabIndex={0}>
            <section className="evidence-panel">
              <h3>
                <Info size={16} /> Why this alert was raised
              </h3>
              <p>
                Rule {event?.rule_id}, version {event?.rule_version}. The
                recorded measurements below triggered the configured behaviour
                rule.
              </p>
              <dl className="metrics-list">
                {evidenceRows(event?.metrics || {}).map((row, i) => (
                  <div key={i} className={row.wide ? "metric-wide" : ""}>
                    <dt>{row.name}</dt>
                    <dd>{row.value}</dd>
                  </div>
                ))}
              </dl>
              <div className="verification-note">
                <ShieldCheck size={15} />
                {event?.verification && typeof event.verification === "object"
                  ? String(
                      (event.verification as { note?: string }).note ||
                        "Review the original recording before taking action.",
                    )
                  : typeof event.verification === "string"
                    ? event.verification
                    : "No model verification recorded. Review the original footage."}
              </div>
            </section>

            {alert.scene && (
              <section className="scene-note">
                <Sparkles size={16} />
                <div>
                  <strong>
                    What the local AI saw ·{" "}
                    {duration(alert.scene.observed_at_sec)}
                  </strong>
                  <p>{alert.scene.text}</p>
                  <small>
                    {alert.scene.model} · Sampled frame description. It gives
                    context only and does not confirm the rule.
                  </small>
                </div>
              </section>
            )}

            <div className="review-side-foot">
              <span className="record-ref">
                Record <span className="record-id">{alert.id.slice(0, 8)}</span>
              </span>
              <span>{relativeTime(alert.created_at)}</span>
            </div>
          </aside>

          <div className="review-actions">
            {alert.status === "pending" ? (
              <>
                <div className="review-action-main">
                  <Button
                    disabled={busy}
                    aria-keyshortcuts="C"
                    onClick={() => openReview("confirm")}
                  >
                    <Check size={16} /> Confirm & create incident
                  </Button>
                  <Button
                    variant="outline"
                    aria-keyshortcuts="L"
                    disabled={busy || !data.incidents.length}
                    onClick={() => openReview("link")}
                  >
                    <Link size={16} /> Link to incident
                  </Button>
                  <Button
                    variant="ghost"
                    aria-keyshortcuts="D"
                    disabled={busy}
                    onClick={() => openReview("dismiss")}
                  >
                    <X size={16} /> Dismiss
                  </Button>
                </div>
                <div className="review-action-meta">
                  <span className="shortcut-hint">
                    <span>
                      <kbd>J</kbd>
                      <kbd>K</kbd> next
                    </span>
                    <span>
                      <kbd>Space</kbd> play
                    </span>
                    <span>
                      <kbd>C</kbd> confirm
                    </span>
                    <span>
                      <kbd>D</kbd> dismiss
                    </span>
                  </span>
                </div>
              </>
            ) : (
              <div className="info-strip review-decision">
                <ShieldCheck size={17} />
                {alert.status === "dismissed"
                  ? "Dismissed: " + alert.dismiss_reason
                  : "Human review confirmed. Continue follow-up in Incidents."}
              </div>
            )}
          </div>
        </div>
      )}

      <Dialog
        open={!!mode}
        onOpenChange={(v) => {
          if (!v && !reviewLock.current) setMode(null);
        }}
        title={
          mode === "confirm"
            ? "Confirm this alert?"
            : mode === "dismiss"
              ? "Dismiss this alert"
              : "Link to an existing incident"
        }
        description={
          mode === "confirm"
            ? "Review the selected recording before confirming the alert and creating an incident."
            : mode === "dismiss"
              ? "A reason is required and will remain in the audit record."
              : "Keep related evidence together in one incident record."
        }
      >
        <form className="stack-form" onSubmit={submit}>
          {mode === "confirm" ? (
            <>
              <div className="confirm-alert-summary">
                <strong>{label(reviewAlert?.event?.type || "alert")}</strong>
                <p>
                  {
                    data.cameras.find(
                      (c) => c.id === reviewAlert?.event?.camera_id,
                    )?.name
                  }
                </p>
                <small>
                  Alert {reviewAlert?.id.slice(0, 8)} ·{" "}
                  {dateTime(reviewAlert?.created_at)} MYT
                </small>
              </div>
              <label className="review-confirmation">
                <input
                  type="checkbox"
                  checked={reviewed}
                  onChange={(e) => setReviewed(e.target.checked)}
                />
                <span>
                  I reviewed the original recording and confirm this alert.
                </span>
              </label>
            </>
          ) : mode === "dismiss" ? (
            <>
              <div
                className="reason-presets"
                role="group"
                aria-label="Common reasons"
              >
                {REASONS.map((r, i) => (
                  <button
                    type="button"
                    key={r.label}
                    aria-pressed={reason === r.text}
                    className={reason === r.text ? "active" : ""}
                    onClick={() => setReason(r.text)}
                  >
                    <kbd>{i + 1}</kbd>
                    {r.label}
                  </button>
                ))}
              </div>
              <Field label="Reason for dismissal">
                <textarea
                  required
                  minLength={3}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Pick a common reason above or explain what you observed in the original footage…"
                />
              </Field>
            </>
          ) : (
            <Field label="Incident">
              <select
                required
                value={incident}
                onChange={(e) => setIncident(e.target.value)}
              >
                <option value="">Select an incident</option>
                {data.incidents.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.title}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {mode === "confirm" ? (
            <SlideConfirm
              className="review-slide"
              label="Slide to confirm & create incident"
              doneLabel="Incident created"
              errorLabel="Couldn't confirm. Try again"
              disabled={!reviewed}
              disabledHint="Tick the box above after reviewing the recording to unlock."
              height={60}
              onConfirm={() =>
                review("confirm", 1100).then((ok) => {
                  if (!ok) throw new Error("The alert was not confirmed.");
                })
              }
            />
          ) : (
            <Button disabled={busy} type="submit">
              {busy ? "Saving…" : mode === "dismiss" ? "Save dismissal" : "Link alert"}
            </Button>
          )}
        </form>
      </Dialog>
    </>
  );
}
