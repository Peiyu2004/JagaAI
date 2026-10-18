import { useMemo, useState } from "react";
import {
  Printer,
  ChartNoAxesCombined,
  Clock3,
  CircleCheck,
  Bell,
  Info,
  ScanEye,
} from "lucide-react";
import { useApp } from "../context";
import { Panel, Empty } from "../components/shared";
import { Button } from "../components/ui/button";
import { label, dateTime } from "../api";
const span = (sec: number) =>
  sec >= 3600
    ? (sec / 3600).toFixed(1) + " h"
    : sec >= 60
      ? Math.round(sec / 60) + " min"
      : Math.round(sec) + " s";
function reviewWorkload(
  videos: {
    id: string;
    status: string;
    duration_sec: number;
    recorded_at: string;
    processed_at?: string;
  }[],
  alerts: {
    event?: { video_id: string; start_sec: number; end_sec: number };
  }[],
  range: string,
) {
  const since = range === "all" ? 0 : Date.now() - Number(range) * 86400000;
  const ready = videos.filter(
    (v) =>
      v.status === "ready" &&
      new Date(v.processed_at || v.recorded_at).getTime() > since,
  );
  const footage = ready.reduce(
    (n, v) => n + Math.max(0, v.duration_sec || 0),
    0,
  );
  let flagged = 0;
  for (const v of ready) {
    const windows = alerts
      .flatMap((a) =>
        a.event && a.event.video_id === v.id
          ? [
              [
                Math.max(0, a.event.start_sec),
                Math.min(v.duration_sec || Infinity, a.event.end_sec),
              ],
            ]
          : [],
      )
      .filter(([a, b]) => b > a)
      .sort((a, b) => a[0] - b[0]);
    let end = -1;
    for (const [a, b] of windows) {
      if (a > end) flagged += b - a;
      else if (b > end) flagged += b - end;
      end = Math.max(end, b);
    }
  }
  return {
    count: ready.length,
    footage,
    flagged,
    reduction: footage ? Math.max(0, 1 - flagged / footage) : null,
  };
}
export default function Insights() {
  const { data } = useApp();
  const [range, setRange] = useState("all");
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
  const heat = Array.from({ length: 7 }, () => Array(12).fill(0) as number[]);
  for (const alert of alerts) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Kuala_Lumpur",
      weekday: "short",
      hour: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(alert.created_at));
    const day = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(
      parts.find((p) => p.type === "weekday")?.value || "Mon",
    );
    const hour = Number(parts.find((p) => p.type === "hour")?.value || 0);
    heat[day][Math.floor(hour / 2)]++;
  }
  const max = Math.max(1, ...heat.flat());
  const work = reviewWorkload(data.videos, data.alerts, range);
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
  let peak = { day: 0, hour: 0, count: 0 };
  heat.forEach((row, day) =>
    row.forEach((count, hour) => {
      if (count > peak.count) peak = { day, hour, count };
    }),
  );
  const peakLabel = `${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][peak.day]} ${String(peak.hour * 2).padStart(2, "0")}:00–${String(peak.hour * 2 + 2).padStart(2, "0")}:00`;
  const periodLabel =
    range === "all" ? "All records" : `Last ${range} days`;
  return (
    <>
      <div className="page-tools no-print">
        <label className="inline-label">
          Reporting period
          <select value={range} onChange={(e) => setRange(e.target.value)}>
            <option value="all">All records</option>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
          </select>
        </label>
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
      <div className="stat-grid">
        {[
          {
            name: "Reviewed confirmation rate",
            value: reviewed
              ? Math.round((confirmed / reviewed) * 100) + "%"
              : "—",
            detail: `${confirmed} confirmed / ${reviewed} reviewed alerts`,
            icon: CircleCheck,
          },
          {
            name: "Alerts recorded",
            value: alerts.length,
            detail: `${dismissed} dismissed · ${alerts.length - reviewed} awaiting review`,
            icon: Bell,
          },
          {
            name: "Median acknowledgement",
            value:
              data.summary.median_ack_sec === null
                ? "—"
                : Math.round(data.summary.median_ack_sec / 60) + " min",
            detail: "From alert creation to human review",
            icon: Clock3,
          },
          {
            name: "Analysed coverage",
            value: `${data.summary.analysed_video_count}/${data.summary.video_count}`,
            detail: "Recordings with completed analysis",
            icon: ChartNoAxesCombined,
          },
        ].map(({ name, value, detail, icon: Icon }) => (
          <div className="stat" key={name}>
            <div className="stat-top">
              <span>{name}</span>
              <Icon size={18} />
            </div>
            <strong>{value}</strong>
            <small>{detail}</small>
          </div>
        ))}
      </div>
      <Panel
        className="workload-panel"
        title="Review workload"
        action={
          <span className="panel-subtle">{work.count} analysed recordings</span>
        }
      >
        {work.footage ? (
          <div className="workload-body">
            <p className="insight-line">
              {work.flagged
                ? `${span(work.flagged)} of ${span(work.footage)} analysed footage (${flaggedShare ?? 0}%) falls inside alert windows.`
                : "No alert windows overlap this footage."}{" "}
              Reviewers can start with the flagged clips instead of watching
              everything end to end.
            </p>
            <div className="workload-figures">
              <div>
                <span>Footage analysed</span>
                <strong>{span(work.footage)}</strong>
                <small>Total length of analysed recordings</small>
              </div>
              <div>
                <span>Flagged for human review</span>
                <strong>{span(work.flagged)}</strong>
                <small>Alert windows, overlaps merged</small>
              </div>
              <div className="workload-lead">
                <span>Flagged share</span>
                <strong>
                  {flaggedShare === null ? "—" : flaggedShare + "%"}
                </strong>
                <small>Flagged clip length vs total footage analysed</small>
              </div>
            </div>
            <div
              className="workload-bar"
              role="img"
              aria-label={`${span(work.flagged)} flagged out of ${span(work.footage)} analysed`}
            >
              <span
                style={{
                  width:
                    Math.max(
                      work.flagged ? 0.6 : 0,
                      (work.flagged / work.footage) * 100,
                    ) + "%",
                }}
              />
            </div>
            <div className="workload-bar-labels">
              <span>{span(work.flagged)} flagged</span>
              <span>{span(work.footage)} analysed</span>
            </div>
            <p className="workload-note">
              <ScanEye size={15} />
              Supervisors review {span(work.flagged)} of flagged clips instead
              of watching {span(work.footage)} of recordings. This measures
              viewing effort only; it is not a detection accuracy figure.
            </p>
          </div>
        ) : (
          <Empty
            compact
            icon={ScanEye}
            title="No analysed footage in this period"
            text="Once recordings finish analysis, this shows how much footage needs human viewing."
          />
        )}
      </Panel>
      <div className="insights-grid">
        <Panel
          title="When alerts occur"
          action={
            <span className="panel-subtle">
              Malaysia time · 2-hour intervals
            </span>
          }
        >
          <p className="insight-line">
            {alerts.length
              ? `Peak activity: ${peakLabel} with ${peak.count} alert${peak.count === 1 ? "" : "s"}. Use quieter windows for patrols and briefings.`
              : "No alerts in this period, so there is no time-of-day pattern to show yet."}
          </p>
          <div className="heatmap" role="region" aria-label="Alerts by day and time" tabIndex={0}>
            {heat.map((row, i) => (
              <div className="heat-row" key={i}>
                <span>
                  {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][i]}
                </span>
                {row.map((count, j) => (
                  <div
                    key={j}
                    title={`${["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][i]}, ${j * 2}:00–${j * 2 + 2}:00: ${count} alerts`}
                    style={{
                      background: count
                        ? `rgba(36,91,231,${0.16 + (count / max) * 0.74})`
                        : "#edf0f5",
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
              <span>Fewer alerts</span>
              {[0, 0.25, 0.5, 0.75, 1].map((n) => (
                <i
                  key={n}
                  style={{
                    background: n
                      ? `rgba(36,91,231,${0.16 + n * 0.74})`
                      : "#edf0f5",
                  }}
                />
              ))}
              <span>More alerts</span>
            </div>
          </div>
          {!alerts.length && (
            <p className="chart-empty-note">
              No alert data in this period. Empty cells represent zero recorded
              alerts.
            </p>
          )}
        </Panel>
        <Panel title="Alerts by location">
          <p className="insight-line">
            {topLocation?.count
              ? `${topLocation.name} has the most recorded alerts (${topLocation.count}). Compare this with patrol coverage and camera placement.`
              : "No location has recorded an alert in this period."}
          </p>
          <div className="location-bars">
            {locations.map((loc) => (
              <div key={loc.name}>
                <div>
                  <span>{loc.name}</span>
                  <strong>{loc.count}</strong>
                </div>
                <div className="bar-track">
                  <span
                    style={{
                      width:
                        (alerts.length
                          ? (loc.count / alerts.length) * 100
                          : 0) + "%",
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </Panel>
        <Panel title="Rule review outcomes">
          <p className="insight-line">
            {reviewed
              ? `${confirmed} of ${reviewed} reviewed alerts were confirmed; ${dismissed} were dismissed. A dismissal is a human decision, not a measured model error rate.`
              : "No reviewed alerts yet. Confirmation and dismissal outcomes will appear once the team reviews the queue."}
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Behaviour rule</th>
                  <th>Alerts</th>
                  <th>Confirmed</th>
                  <th>Dismissed</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ["R1", "vehicle_loitering"],
                  ["R3", "restricted_entry"],
                ].map(([id, type]) => (
                  <tr key={id}>
                    <td>
                      <strong>{id}</strong> {label(type)}
                    </td>
                    <td>
                      {alerts.filter((a) => a.event?.rule_id === id).length}
                    </td>
                    <td>
                      {
                        alerts.filter(
                          (a) =>
                            a.event?.rule_id === id && a.status === "confirmed",
                        ).length
                      }
                    </td>
                    <td>
                      {
                        alerts.filter(
                          (a) =>
                            a.event?.rule_id === id && a.status === "dismissed",
                        ).length
                      }
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
        <Panel title="Incident follow-up">
          {data.incidents.length ? (
            <>
              <p className="insight-line">
                {data.incidents.filter((i) => i.status === "resolved" || i.status === "closed").length
                  ? `${data.incidents.filter((i) => i.status === "resolved" || i.status === "closed").length} of ${data.incidents.length} incident records are resolved or closed.`
                  : "Cases are still open or assigned; outcomes will appear after follow-up."}
              </p>
            <div className="follow-up-stats">
              {["open", "assigned", "resolved", "closed"].map((status) => (
                <div key={status}>
                  <span>{label(status)}</span>
                  <strong>
                    {data.incidents.filter((i) => i.status === status).length}
                  </strong>
                </div>
              ))}
            </div>
            </>
          ) : (
            <Empty
              compact
              icon={Clock3}
              title="No incident history yet"
              text="Resolution and follow-up records will appear after your team creates incidents."
            />
          )}
        </Panel>
      </div>
      <div className="info-strip report-method">
        <Info size={17} />
        <p>
          Counts come from saved workspace records. Confirmation rate uses
          reviewed alerts only ({confirmed}/{reviewed}); pending alerts are
          excluded. A dismissed alert is a human review outcome, not a measured
          model error rate. Timing uses the stored alert creation time.
        </p>
      </div>
    </>
  );
}
