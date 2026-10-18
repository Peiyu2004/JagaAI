import {
  ArrowRight,
  Bell,
  Camera,
  ChevronRight,
  CircleCheck,
  Clock3,
  MessageSquare,
  Plus,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { useApp } from "../context";
import { Button } from "../components/ui/button";
import { Panel, Empty, Badge } from "../components/shared";
import { dateTime, label, relativeTime, cameraName as displayCameraName } from "../api";
import type { Alert } from "../types";

const priorityRank: Record<string, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
};

function reasonFor(alert: Alert) {
  const metrics = alert.event?.metrics || {};
  if (metrics.crossed_line === true) return "Crossed the boundary line";
  if (metrics.entered_zone === true) return "Entered the restricted area";
  if (typeof metrics.dwell_sec === "number")
    return `${Math.round(metrics.dwell_sec)} s in the parking zone`;
  if (typeof metrics.distinct_vehicles === "number")
    return `${metrics.distinct_vehicles} vehicles approached`;
  return `Rule ${alert.event?.rule_id || "unknown"}`;
}

export default function Command() {
  const { data, go, openAlert } = useApp();
  const s = data.summary;
  const pending = data.alerts
    .filter((a) => a.status === "pending")
    .sort(
      (a, b) =>
        (priorityRank[a.priority] ?? 3) - (priorityRank[b.priority] ?? 3),
    );
  const cameraName = (id?: string) =>
    displayCameraName(data.cameras.find((c) => c.id === id)?.name);
  const alertsForCamera = (id: string) =>
    pending.filter((a) => a.event?.camera_id === id);
  const orderedCameras = [...data.cameras].sort(
    (a, b) => alertsForCamera(b.id).length - alertsForCamera(a.id).length,
  );
  const highPriority = pending.filter(
    (a) => a.priority === "urgent" || a.priority === "high",
  ).length;
  const topCamera = Object.entries(
    pending.reduce<Record<string, number>>((acc, alert) => {
      const name = cameraName(alert.event?.camera_id);
      acc[name] = (acc[name] || 0) + 1;
      return acc;
    }, {}),
  ).sort((a, b) => b[1] - a[1])[0];
  const recentLeads = data.leads.slice(0, 3);
  const median =
    s.median_ack_sec === null
      ? "No reviews yet"
      : Math.round(s.median_ack_sec / 60) + " min";

  return (
    <>
      <section className="shift-strip" aria-label="Shift summary">
        <div className="shift-metrics">
          <div className="shift-metric">
            <span>To review</span>
            <strong>{pending.length}</strong>
            <small>Alerts awaiting a decision</small>
          </div>
          <div className="shift-metric">
            <span>High priority</span>
            <strong>{highPriority}</strong>
            <small>Urgent or high alerts</small>
          </div>
          <div className="shift-metric">
            <span>Median review</span>
            <strong>{median}</strong>
            <small>Alert to first human review</small>
          </div>
          <div className="shift-metric">
            <span>Guards on roster</span>
            <strong>{data.guards.length}</strong>
            <small>Assigned by radio or phone</small>
          </div>
        </div>
        <Button
          onClick={() =>
            pending.length ? openAlert(pending[0].id) : go("alerts")
          }
        >
          {pending.length ? "Review next" : "Open alert queue"}
          <ArrowRight size={16} />
        </Button>
      </section>

      <p className="shift-brief">
        {pending.length ? (
          <>
            <strong>{pending.length} alerts need review.</strong>{" "}
            {topCamera
              ? `${topCamera[1]} at ${topCamera[0]}${highPriority ? ` · ${highPriority} high priority` : ""}.`
              : "Every alert requires a human decision."}
          </>
        ) : (
          <>
            <strong>The review queue is clear.</strong> New alerts appear here
            as soon as an analysed recording triggers a rule.
          </>
        )}
      </p>

      <div className="command-v4">
        <section className="panel attention-panel" aria-labelledby="attention-title">
          <div className="panel-head">
            <div>
              <h2 id="attention-title">Needs attention</h2>
              <p className="panel-subtle">
                Sorted by priority · newest first within a priority
              </p>
            </div>
            <span className="count-pill">{pending.length}</span>
          </div>
          {pending.length ? (
            <div className="attention-list-v4">
              {pending.map((alert) => {
                const video = data.videos.find(
                  (v) => v.id === alert.event?.video_id,
                );
                const frame =
                  alert.scene?.keyframe_url ||
                  alert.event?.keyframes?.find((url) =>
                    url.startsWith("/api/"),
                  ) ||
                  video?.thumbnail_url;
                const prefix = `/api/videos/${alert.event?.video_id}/keyframes/`;
                const preview = frame?.startsWith(prefix)
                  ? `/api/videos/${alert.event.video_id}/thumbnail?width=160&frame=${encodeURIComponent(frame.slice(prefix.length))}`
                  : frame ? `${frame}?width=160` : undefined;
                return (
                  <button
                    key={alert.id}
                    className={
                      "attention-row" +
                      (alert.priority === "high" ||
                      alert.priority === "urgent"
                        ? " is-high"
                        : "")
                    }
                    onClick={() => openAlert(alert.id)}
                  >
                    <span className="attention-thumb">
                      {frame ? (
                        <img src={preview} alt="" width={160} height={90} loading="lazy" decoding="async" />
                      ) : (
                        <Bell size={19} />
                      )}
                    </span>
                    <span className="attention-body">
                      <span className="attention-title">
                        <strong>{label(alert.event?.type || "alert")}</strong>
                        <Badge value={alert.priority} />
                      </span>
                      <span className="attention-meta">
                        {cameraName(alert.event?.camera_id)} ·{" "}
                        {reasonFor(alert)}
                      </span>
                    </span>
                    <span className="attention-action">
                      <time
                        dateTime={alert.created_at}
                        title={dateTime(alert.created_at)}
                      >
                        {relativeTime(alert.created_at)}
                      </time>
                      <span className="attention-review">
                        Review <ArrowRight size={14} />
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <Empty
              compact
              icon={CircleCheck}
              title="Review queue is clear"
              text={
                s.video_count
                  ? "New alerts will appear here when an analysed recording triggers a configured rule."
                  : "Upload a recording to start checking for configured behaviours."
              }
              action={
                !s.video_count ? (
                  <Button variant="outline" size="sm" onClick={() => go("cameras")}>
                    <Plus size={14} /> Add a recording
                  </Button>
                ) : undefined
              }
            />
          )}
          <button className="panel-foot-link" onClick={() => go("alerts")}>
            Open alert queue <ArrowRight size={15} />
          </button>
        </section>

        <aside className="command-side" aria-label="Camera coverage and resident leads">
          <Panel
            title="Camera wall"
            action={
              <Button variant="ghost" size="sm" onClick={() => go("cameras")}>
                Manage <ChevronRight size={14} />
              </Button>
            }
          >
            <div className="camera-wall-head">
              <span>
                <Camera size={14} /> {data.cameras.length} cameras
              </span>
              <span>
                {data.cameras.filter((c) => alertsForCamera(c.id).length).length}{" "}
                alerting
              </span>
            </div>
            {orderedCameras.length ? (
              <div className="camera-wall-v4">
                {orderedCameras.slice(0, 4).map((camera, index) => {
                  const video = data.videos.find(
                    (v) => v.camera_id === camera.id,
                  );
                  const alerts = alertsForCamera(camera.id);
                  return (
                    <button
                      key={camera.id}
                      className={
                        "camera-tile" + (alerts.length ? " has-alerts" : "")
                      }
                      onClick={() =>
                        alerts.length ? openAlert(alerts[0].id) : go("cameras")
                      }
                    >
                      {video?.thumbnail_url ? (
                        <img
                          src={video.thumbnail_url}
                          srcSet={`${video.thumbnail_url}?width=480 480w, ${video.thumbnail_url}?width=960 960w`}
                          sizes="(max-width:620px) calc(50vw - 33px), (max-width:820px) calc(50vw - 37px), (max-width:980px) calc(25vw - 91px), (max-width:1260px) 145px, 160px"
                          alt=""
                          width={480}
                          height={270}
                          loading={index < 2 ? "eager" : "lazy"}
                          fetchPriority={index === 0 ? "high" : "low"}
                          decoding="async"
                        />
                      ) : (
                        <span className="camera-tile-empty">
                          <Camera size={20} />
                        </span>
                      )}
                      <span className="camera-tile-shade" />
                      {alerts.length > 0 && (
                        <span className="camera-tile-count">
                          <Bell size={11} /> {alerts.length}
                        </span>
                      )}
                      <span className="camera-tile-info">
                        <strong>{displayCameraName(camera.name)}</strong>
                        <small>
                          {data.locations.find(
                            (l) => l.id === camera.location_id,
                          )?.name || "Property"}
                          {alerts.length
                            ? ` · ${alerts.length} pending`
                            : video
                              ? " · clear"
                              : " · no source"}
                        </small>
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <Empty
                compact
                icon={Camera}
                title="No cameras configured"
                text="Add a camera in Cameras to build coverage."
                action={
                  <Button variant="outline" size="sm" onClick={() => go("cameras")}>
                    Open cameras
                  </Button>
                }
              />
            )}
            {s.video_count === 0 && (
              <div className="first-recording">
                <span className="first-recording-icon">
                  <Plus size={18} />
                </span>
                <span>
                  <strong>Add your first recording</strong>
                  <small>Upload MP4 footage to begin local analysis.</small>
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => go("cameras")}
                >
                  Upload
                </Button>
              </div>
            )}
            <div className="camera-wall-foot">
              <span>
                <Clock3 size={13} /> {s.analysed_video_count} /{" "}
                {s.video_count} recordings analysed
              </span>
              <span>{s.pending_video_count} waiting</span>
            </div>
          </Panel>

          <button
            type="button"
            className="side-link-row"
            onClick={() => go("leads")}
          >
            <span className="side-link-icon">
              <MessageSquare size={17} />
            </span>
            <span>
              <strong>Resident leads</strong>
              <small>
                {recentLeads.length
                  ? `${recentLeads.length} recent observation${recentLeads.length === 1 ? "" : "s"}`
                  : "No new resident observations"}
              </small>
            </span>
            {s.new_leads > 0 && <b className="side-link-count">{s.new_leads}</b>}
            <ChevronRight size={16} />
          </button>

          <div className="command-footnote">
            <ShieldCheck size={15} />
            <span>
              {data.videos.length
                ? `${data.videos.length} local recordings · human review on every alert`
                : "Local processing · no face recognition · no cloud"}
            </span>
            <UserRound size={15} />
          </div>
        </aside>
      </div>
    </>
  );
}
