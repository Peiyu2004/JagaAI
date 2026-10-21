import { useMemo, useRef, useState, type CSSProperties } from "react";
import {
  Printer,
  Clock3,
  Bell,
  Info,
  ScanEye,
  Play,
  CalendarClock,
  MapPin,
  FolderKanban,
  ListChecks,
  ChevronRight,
} from "lucide-react";
import { useApp } from "../context";
import { Empty } from "../components/shared";
import { Button } from "../components/ui/button";
import RubberSegment from "../components/RubberSegment";
import { CountUp } from "../components/command/CountUp";
import { useReveal } from "../components/useReveal";
import { label, dateTime, duration, cameraName } from "../api";
import type { Video, Alert, Camera } from "../types";

const span = (sec: number) =>
  sec >= 3600
    ? (sec / 3600).toFixed(1) + " h"
    : sec >= 60
      ? Math.round(sec / 60) + " min"
      : Math.round(sec) + " s";
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function sinceOf(range: string) {
  return range === "all" ? 0 : Date.now() - Number(range) * 86400000;
}
function readyVideos(videos: Video[], range: string) {
  const since = sinceOf(range);
  return videos.filter(
    (v) =>
      v.status === "ready" &&
      new Date(v.processed_at || v.recorded_at).getTime() > since,
  );
}
/** Alert windows inside one recording, overlaps merged. */
function windowsFor(video: Video, alerts: Alert[]) {
  const sorted = alerts
    .flatMap((a) =>
      a.event && a.event.video_id === video.id
        ? [
            [
              Math.max(0, a.event.start_sec),
              Math.min(video.duration_sec || Infinity, a.event.end_sec),
            ] as [number, number],
          ]
        : [],
    )
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [a, b] of sorted) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
}
function reviewWorkload(videos: Video[], alerts: Alert[], range: string) {
  const ready = readyVideos(videos, range);
  const footage = ready.reduce((n, v) => n + Math.max(0, v.duration_sec || 0), 0);
  let flagged = 0;
  for (const v of ready)
    for (const [a, b] of windowsFor(v, alerts)) flagged += b - a;
  return {
    count: ready.length,
    footage,
    flagged,
    reduction: footage ? Math.max(0, 1 - flagged / footage) : null,
  };
}
function footageTracks(videos: Video[], alerts: Alert[], cameras: Camera[], range: string) {
  return readyVideos(videos, range)
    .map((v) => {
      const windows = windowsFor(v, alerts);
      return {
        id: v.id,
        camera: cameraName(cameras.find((c) => c.id === v.camera_id)?.name),
        recordedAt: v.recorded_at,
        length: Math.max(0, v.duration_sec || 0),
        windows,
        flagged: windows.reduce((n, [a, b]) => n + (b - a), 0),
      };
    })
    .sort(
      (a, b) =>
        Number(b.flagged > 0) - Number(a.flagged > 0) ||
        new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime(),
    );
}

export default function Insights() {
  const { data, play, go } = useApp();
  const [range, setRange] = useState("all");
  const pageRef = useRef<HTMLDivElement>(null);
  useReveal(pageRef);
  const alerts = useMemo(
    () =>
      data.alerts.filter(
        (a) =>
          range === "all" ||
          new Date(a.created_at).getTime() >
            Date.now() - Number(range) * 86400000,
      ),
    [data.alerts, range],
  );
  const confirmed = alerts.filter((a) => a.status === "confirmed").length;
  const dismissed = alerts.filter((a) => a.status === "dismissed").length;
  const reviewed = confirmed + dismissed;
  const awaiting = alerts.length - reviewed;
  const rate = reviewed ? Math.round((confirmed / reviewed) * 100) : null;

  const heat = Array.from({ length: 7 }, () => Array(12).fill(0) as number[]);
  for (const alert of alerts) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Kuala_Lumpur",
      weekday: "short",
      hour: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(alert.created_at));
    const day = DAYS.indexOf(parts.find((p) => p.type === "weekday")?.value || "Mon");
    const hour = Number(parts.find((p) => p.type === "hour")?.value || 0);
    heat[day][Math.floor(hour / 2)]++;
  }
  const max = Math.max(1, ...heat.flat());
  let peak = { day: 0, hour: 0, count: 0 };
  heat.forEach((row, day) =>
    row.forEach((count, hour) => {
      if (count > peak.count) peak = { day, hour, count };
    }),
  );
  const peakLabel = `${DAYS[peak.day]} ${String(peak.hour * 2).padStart(2, "0")}:00–${String(peak.hour * 2 + 2).padStart(2, "0")}:00`;

  const work = reviewWorkload(data.videos, data.alerts, range);
  const tracks = footageTracks(data.videos, data.alerts, data.cameras, range);
  const shownTracks = tracks.slice(0, 6);
  const flaggedShare = work.footage
    ? Math.round((work.flagged / work.footage) * 1000) / 10
    : null;

  const locations = data.locations
    .map((loc) => ({
      name: loc.name,
      count: alerts.filter(
        (a) =>
          data.cameras.find((c) => c.id === a.event?.camera_id)?.location_id ===
          loc.id,
      ).length,
    }))
    .sort((a, b) => b.count - a.count);
  const topLocation = locations[0];
  const rules = [
    ["R1", "vehicle_loitering"],
    ["R3", "restricted_entry"],
  ].map(([id, type]) => {
    const own = alerts.filter((a) => a.event?.rule_id === id);
    const yes = own.filter((a) => a.status === "confirmed").length;
    const no = own.filter((a) => a.status === "dismissed").length;
    return { id, type, total: own.length, confirmed: yes, dismissed: no, pending: own.length - yes - no };
  });
  const stages = ["open", "assigned", "resolved", "closed"].map((status) => ({
    status,
    count: data.incidents.filter((i) => i.status === status).length,
  }));
  const settled = stages[2].count + stages[3].count;
  const coverage = data.summary.video_count
    ? data.summary.analysed_video_count / data.summary.video_count
    : 0;
  const periodLabel = range === "all" ? "All records" : `Last ${range} days`;
  const ring = 2 * Math.PI * 52;

  return (
    <div className="ins-page wx-reveal" ref={pageRef}>
      <div className="ins-toolbar no-print">
        <RubberSegment
          aria-label="Reporting period"
          className="ins-period"
          value={range}
          onChange={setRange}
          items={[
            { value: "all", label: "All records" },
            { value: "7", label: "7 days" },
            { value: "30", label: "30 days" },
          ]}
        />
        <span className="ins-toolbar-note">
          <CalendarClock size={14} />
          {periodLabel} · {alerts.length} alert{alerts.length === 1 ? "" : "s"} ·{" "}
          {work.count} analysed recording{work.count === 1 ? "" : "s"}
        </span>
        <Button variant="outline" onClick={() => window.print()}>
          <Printer size={16} /> Print / save PDF
        </Button>
      </div>
      <div className="print-heading">
        <h1>JagaAI security report</h1>
        <p>
          Serenia City · {periodLabel} · Generated{" "}
          {dateTime(new Date().toISOString())} MYT
        </p>
      </div>

      <div className="ins-layout">
        {/* HERO — the one number that matters: how much footage really needs a human. */}
        <section className="ins-hero" data-reveal aria-labelledby="ins-hero-title">
          {work.footage ? (
            <>
              <div className="ins-hero-head">
                <div className="ins-hero-copy">
                  <span className="ins-eyebrow">
                    <ScanEye size={14} /> Review effort · {periodLabel}
                  </span>
                  <h2 id="ins-hero-title">
                    Review <em>{span(work.flagged)}</em> of footage,
                    <br />
                    not <s>{span(work.footage)}</s>.
                  </h2>
                  <p>
                    {work.flagged
                      ? `Alert windows cover ${flaggedShare ?? 0}% of the ${span(work.footage)} analysed across ${work.count} recording${work.count === 1 ? "" : "s"}. Start with the amber clips — click one to play it.`
                      : `No alert windows overlap the ${span(work.footage)} analysed. Nothing needs viewing right now.`}
                  </p>
                </div>
                <div
                  className="ins-ring"
                  role="img"
                  aria-label={`${flaggedShare ?? 0}% of analysed footage is flagged for review`}
                  style={{ "--ring": ring, "--ring-on": ring * ((flaggedShare ?? 0) / 100) } as CSSProperties}
                >
                  <svg viewBox="0 0 132 132" aria-hidden="true">
                    <circle className="ins-ring-track" cx="66" cy="66" r="52" />
                    <circle className="ins-ring-arc" cx="66" cy="66" r="52" />
                  </svg>
                  <span className="ins-ring-value">
                    <strong>{flaggedShare ?? 0}%</strong>
                    <small>flagged</small>
                  </span>
                </div>
              </div>

              <div className="ins-figures">
                <div>
                  <span>Footage analysed</span>
                  <strong>{span(work.footage)}</strong>
                </div>
                <div className="is-flagged">
                  <span>Needs human eyes</span>
                  <strong>{span(work.flagged)}</strong>
                </div>
                <div className="is-saved">
                  <span>Viewing time saved</span>
                  <strong>
                    {work.reduction === null ? "—" : Math.round(work.reduction * 100) + "%"}
                  </strong>
                </div>
              </div>

              <div className="ins-tracks">
                <div className="ins-tracks-head" aria-hidden="true">
                  <span>Recording</span>
                  <span>Timeline · start → end</span>
                  <span>Flagged</span>
                </div>
                <ul>
                  {shownTracks.map((t, i) => (
                    <li
                      key={t.id}
                      className={"ins-track" + (t.flagged ? " has-flag" : "")}
                      style={{ "--i": i } as CSSProperties}
                    >
                      <span className="ins-track-meta">
                        <strong title={t.camera}>{t.camera}</strong>
                        <small>
                          {dateTime(t.recordedAt)} · {duration(t.length)}
                        </small>
                      </span>
                      <span
                        className="ins-track-bar"
                        role="group"
                        aria-label={`${t.camera}: ${t.windows.length} flagged window${t.windows.length === 1 ? "" : "s"}`}
                      >
                        {t.windows.map(([a, b]) => (
                          <button
                            key={a + "-" + b}
                            type="button"
                            className="ins-win"
                            style={{
                              left: (t.length ? (a / t.length) * 100 : 0) + "%",
                              width: Math.max(1.4, t.length ? ((b - a) / t.length) * 100 : 0) + "%",
                            }}
                            title={`Play ${duration(a)} – ${duration(b)}`}
                            aria-label={`Play ${t.camera} from ${duration(a)} to ${duration(b)}`}
                            onClick={() => play(t.id, a)}
                          >
                            <Play size={10} fill="currentColor" />
                          </button>
                        ))}
                      </span>
                      <span className={"ins-track-flag" + (t.flagged ? "" : " is-clear")}>
                        {t.flagged ? span(t.flagged) : "Clear"}
                      </span>
                    </li>
                  ))}
                </ul>
                {tracks.length > shownTracks.length && (
                  <p className="ins-tracks-more">
                    +{tracks.length - shownTracks.length} more analysed recording
                    {tracks.length - shownTracks.length === 1 ? "" : "s"} in this period
                  </p>
                )}
              </div>
              <p className="ins-hero-note">
                <Info size={13} />
                Measures viewing effort only; it is not a detection accuracy figure.
              </p>
            </>
          ) : (
            <Empty
              icon={ScanEye}
              title="No analysed footage in this period"
              text="Once recordings finish analysis, this shows how much footage needs human viewing."
            />
          )}
        </section>

        {/* SIDE RAIL — the supporting numbers, each one short and direct. */}
        <aside className="ins-rail" aria-label="Key figures">
          <section className="ins-card ins-outcomes" data-reveal style={{ "--i": 1 } as CSSProperties}>
            <span className="ins-eyebrow">
              <Bell size={14} /> Alerts
            </span>
            <div className="ins-big">
              <CountUp value={alerts.length} />
              <span className="sr-only">{alerts.length}</span>
              <small>recorded</small>
            </div>
            <div
              className="ins-stack"
              role="img"
              aria-label={`${confirmed} confirmed, ${dismissed} dismissed, ${awaiting} awaiting review`}
            >
              {alerts.length ? (
                <>
                  <span className="is-confirmed" style={{ flexGrow: confirmed }} />
                  <span className="is-dismissed" style={{ flexGrow: dismissed }} />
                  <span className="is-pending" style={{ flexGrow: awaiting }} />
                </>
              ) : (
                <span className="is-empty" />
              )}
            </div>
            <ul className="ins-legend">
              <li>
                <i className="is-confirmed" /> Confirmed <b>{confirmed}</b>
              </li>
              <li>
                <i className="is-dismissed" /> Dismissed <b>{dismissed}</b>
              </li>
              <li>
                <i className="is-pending" /> Awaiting review <b>{awaiting}</b>
              </li>
            </ul>
            <div className="ins-rate">
              <strong>{rate === null ? "—" : rate + "%"}</strong>
              <span>
                confirmation rate
                <small>
                  {confirmed} of {reviewed} reviewed alert{reviewed === 1 ? "" : "s"}
                </small>
              </span>
            </div>
            {awaiting > 0 && (
              <button type="button" className="ins-link" onClick={() => go("alerts")}>
                Review {awaiting} waiting <ChevronRight size={14} />
              </button>
            )}
          </section>

          <div className="ins-kpis" data-reveal style={{ "--i": 2 } as CSSProperties}>
            <section className="ins-card ins-kpi">
              <span className="ins-eyebrow">
                <Clock3 size={14} /> Median response
              </span>
              <strong>
                {data.summary.median_ack_sec === null ? "—" : span(data.summary.median_ack_sec)}
              </strong>
              <small>Alert created → human review</small>
            </section>
            <section className="ins-card ins-kpi">
              <span className="ins-eyebrow">
                <ScanEye size={14} /> Coverage
              </span>
              <strong>
                {data.summary.analysed_video_count}/{data.summary.video_count}
              </strong>
              <span className="ins-meter" aria-hidden="true">
                <span style={{ width: coverage * 100 + "%" }} />
              </span>
              <small>Recordings fully analysed</small>
            </section>
          </div>

          <section className="ins-card ins-rules" data-reveal style={{ "--i": 3 } as CSSProperties}>
            <span className="ins-eyebrow">
              <ListChecks size={14} /> Rule outcomes
            </span>
            <ul>
              {rules.map((r) => (
                <li key={r.id}>
                  <div className="ins-rule-top">
                    <span>
                      <b>{r.id}</b> {label(r.type)}
                    </span>
                    <strong>{r.total}</strong>
                  </div>
                  <div className="ins-stack is-thin" aria-hidden="true">
                    {r.total ? (
                      <>
                        <span className="is-confirmed" style={{ flexGrow: r.confirmed }} />
                        <span className="is-dismissed" style={{ flexGrow: r.dismissed }} />
                        <span className="is-pending" style={{ flexGrow: r.pending }} />
                      </>
                    ) : (
                      <span className="is-empty" />
                    )}
                  </div>
                  <small>
                    {r.confirmed} confirmed · {r.dismissed} dismissed
                    {r.pending ? ` · ${r.pending} waiting` : ""}
                  </small>
                </li>
              ))}
            </ul>
            <p className="ins-fine">A dismissal is a human decision, not a measured model error rate.</p>
          </section>

          <section className="ins-card ins-follow" data-reveal style={{ "--i": 4 } as CSSProperties}>
            <span className="ins-eyebrow">
              <FolderKanban size={14} /> Incident follow-up
            </span>
            {data.incidents.length ? (
              <>
                <ol className="ins-steps">
                  {stages.map((s) => (
                    <li key={s.status} className={s.count ? "has-items" : ""}>
                      <strong>{s.count}</strong>
                      <span>{label(s.status)}</span>
                    </li>
                  ))}
                </ol>
                <p className="ins-fine">
                  {settled
                    ? `${settled} of ${data.incidents.length} incidents resolved or closed.`
                    : `All ${data.incidents.length} incidents are still open or assigned.`}
                </p>
              </>
            ) : (
              <p className="ins-fine">
                No incident history yet. Outcomes appear after your team creates incidents.
              </p>
            )}
          </section>
        </aside>

        {/* PATTERNS — when and where, under the hero. */}
        <div className="ins-charts">
          <section className="ins-card ins-heat" data-reveal>
            <div className="ins-card-head">
              <span className="ins-eyebrow">
                <CalendarClock size={14} /> When alerts occur
              </span>
              <small>Malaysia time · 2-hour blocks</small>
            </div>
            <p className="insight-line">
              {alerts.length
                ? `Peak: ${peakLabel} with ${peak.count} alert${peak.count === 1 ? "" : "s"}. Use quieter windows for patrols and briefings.`
                : "No alerts in this period, so there is no time-of-day pattern yet."}
            </p>
            <div className="heatmap" role="region" aria-label="Alerts by day and time" tabIndex={0}>
              {heat.map((row, i) => (
                <div className="heat-row" key={i}>
                  <span>{DAYS[i]}</span>
                  {row.map((count, j) => (
                    <div
                      key={j}
                      className={count ? "is-hot" : ""}
                      title={`${DAY_NAMES[i]}, ${j * 2}:00–${j * 2 + 2}:00: ${count} alerts`}
                      style={{
                        background: count
                          ? `rgba(47,91,234,${0.18 + (count / max) * 0.72})`
                          : undefined,
                      }}
                    >
                      <span className="sr-only">{count}</span>
                    </div>
                  ))}
                </div>
              ))}
              <div className="heat-hours">
                <span>00:00</span>
                <span>06:00</span>
                <span>12:00</span>
                <span>18:00</span>
                <span>24:00</span>
              </div>
              <div className="heat-key">
                <span>Fewer</span>
                {[0, 0.25, 0.5, 0.75, 1].map((n) => (
                  <i
                    key={n}
                    style={{
                      background: n ? `rgba(47,91,234,${0.18 + n * 0.72})` : "#eef1f8",
                    }}
                  />
                ))}
                <span>More</span>
              </div>
            </div>
          </section>

          <section className="ins-card ins-where" data-reveal style={{ "--i": 1 } as CSSProperties}>
            <div className="ins-card-head">
              <span className="ins-eyebrow">
                <MapPin size={14} /> Where
              </span>
              <small>Alerts by zone</small>
            </div>
            <p className="insight-line">
              {topLocation?.count
                ? `${topLocation.name} has the most alerts (${topLocation.count}). Compare with patrol coverage and camera placement.`
                : "No zone has recorded an alert in this period."}
            </p>
            <ul className="ins-bars">
              {locations.map((loc, i) => {
                const pct = alerts.length ? Math.round((loc.count / alerts.length) * 100) : 0;
                return (
                  <li key={loc.name} className={i === 0 && loc.count ? "is-top" : ""}>
                    <div>
                      <span title={loc.name}>{loc.name}</span>
                      <strong>
                        {loc.count}
                        <small>{pct}%</small>
                      </strong>
                    </div>
                    <span className="ins-bar">
                      <span style={{ width: pct + "%" }} />
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        </div>
      </div>

      <div className="info-strip report-method" data-reveal>
        <Info size={17} />
        <p>
          Counts come from saved workspace records. Confirmation rate uses
          reviewed alerts only ({confirmed}/{reviewed}); pending alerts are
          excluded. A dismissed alert is a human review outcome, not a measured
          model error rate. Timing uses the stored alert creation time.
        </p>
      </div>
    </div>
  );
}
