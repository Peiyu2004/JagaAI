import { tabKeys } from "../components/tabKeys";
import {
  useState,
  useEffect,
  useRef,
  type FormEvent,
  type MouseEvent,
} from "react";
import {
  Upload,
  Camera as CameraIcon,
  Play,
  ScanLine,
  Check,
  Plus,
  RotateCcw,
  Film,
  Clock3,
  TriangleAlert,
  LoaderCircle,
  ChevronDown,
} from "lucide-react";
import { useApp } from "../context";
import {
  api,
  json,
  dateTime,
  localInput,
  toUTC,
  duration,
  label,
  cameraName as displayCameraName,
} from "../api";
import {
  Panel,
  Field,
  Empty,
  Badge,
  EventRow,
  SiteMap,
} from "../components/shared";
import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";
import type { Rule } from "../types";
import { LiveInput } from "../components/LiveInput";
export default function Cameras() {
  const { data, run, play } = useApp();
  const [cameraId, setCameraId] = useState(
    data.cameras.find((c) => data.videos.some((v) => v.camera_id === c.id))
      ?.id ||
      data.cameras[0]?.id ||
      "",
  );
  const [tab, setTab] = useState<
    "coverage" | "rules" | "recordings" | "live"
  >("coverage");
  const camera = data.cameras.find((c) => c.id === cameraId) || data.cameras[0];
  const [rules, setRules] = useState<Record<string, Rule>>({});
  const [uploadOpen, setUploadOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [recordedAt, setRecordedAt] = useState(localInput());
  const [uploading, setUploading] = useState(false);
  const [activeVideo, setActiveVideo] = useState("");
  const [zoneRule, setZoneRule] = useState("R1");
  const [drawing, setDrawing] = useState<"zone" | "line" | null>(null);
  const [points, setPoints] = useState<number[][]>([]);
  const [saving, setSaving] = useState(false);
  const [frame, setFrame] = useState<{ id: string; aspect: number } | null>(
    null,
  );
  const svg = useRef<SVGSVGElement>(null);
  const videos = data.videos.filter((v) => v.camera_id === camera?.id);
  const video = videos.find((v) => v.id === activeVideo) || videos.at(0);
  const events = data.events.filter((e) => e.camera_id === camera?.id);
  const frameReady = !!video && frame?.id === video.id;
  const aspect = frameReady ? frame!.aspect : 16 / 9;
  const stageHeight = 1000 / aspect;
  useEffect(() => {
    if (camera) {
      setRules(structuredClone(camera.rules));
      setDrawing(null);
      setPoints([]);
      setActiveVideo("");
    }
  }, [camera?.id]);
  const update = (key: string, patch: Partial<Rule>) =>
    setRules((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  const onDraw = (e: MouseEvent<SVGSVGElement>) => {
    if (!drawing || !svg.current || !frameReady) return;
    const rect = svg.current.getBoundingClientRect();
    const p = [
      Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
    ];
    const next = [...points, p];
    if (drawing === "line" && next.length === 2) {
      update("R3", { line: next });
      setDrawing(null);
      setPoints([]);
    } else setPoints(next);
  };
  const finish = () => {
    if (points.length >= 3) {
      update(zoneRule, { zone: points });
      setDrawing(null);
      setPoints([]);
    }
  };
  const upload = async (e: FormEvent) => {
    e.preventDefault();
    if (!file || !camera) return;
    setUploading(true);
    const form = new FormData();
    form.set("file", file);
    form.set("camera_id", camera.id);
    form.set("recorded_at", toUTC(recordedAt));
    const ok = await run(
      () => api("/videos", { method: "POST", body: form }),
      "Recording uploaded",
    );
    setUploading(false);
    if (ok) {
      setUploadOpen(false);
      setFile(null);
    }
  };
  const dirty =
    !!camera && JSON.stringify(rules) !== JSON.stringify(camera.rules || {});
  const save = async () => {
    if (!camera) return;
    setSaving(true);
    await run(
      () =>
        api("/cameras/" + camera.id + "/rules", {
          method: "PUT",
          body: json({ rules }),
        }),
      "Camera rules saved",
    );
    setSaving(false);
  };
  const switchCamera = (id: string) => {
    if (id === camera?.id) return;
    if (
      dirty &&
      !window.confirm(
        "This camera has unsaved rule changes. Discard them and switch?",
      )
    )
      return;
    setCameraId(id);
    setTab("coverage");
  };
  if (!camera)
    return (
      <Panel>
        <Empty
          icon={CameraIcon}
          title="No cameras configured"
          text="Ask an administrator to configure cameras for this property."
        />
      </Panel>
    );
  return (
    <>
      <div className="page-tools">
        <span>
          {data.cameras.length} configured cameras · {data.videos.length}{" "}
          recordings
        </span>
        <Button onClick={() => setUploadOpen(true)}>
          <Upload size={16} /> Upload recording
        </Button>
      </div>
      <div className="camera-workspace">
        <aside className="camera-selector" aria-label="Cameras">
          {data.cameras.map((c) => {
            const pending = data.alerts.filter(
              (a) => a.status === "pending" && a.event?.camera_id === c.id,
            ).length;
            return (
              <button
                key={c.id}
                className={c.id === camera.id ? "active" : ""}
                onClick={() => switchCamera(c.id)}
              >
                <CameraIcon size={18} />
                <span>
                  <strong>{displayCameraName(c.name)}</strong>
                  <small>
                    {data.locations.find((l) => l.id === c.location_id)?.name}
                  </small>
                </span>
                {pending > 0 && (
                  <b className="camera-alert-badge">{pending}</b>
                )}
                <span
                  className={
                    "source-dot " +
                    (data.videos.some((v) => v.camera_id === c.id)
                      ? "has-video "
                      : "") +
                    (c.live?.running ? "is-live" : "")
                  }
                  title={c.live?.running ? "Live input recording" : undefined}
                />
              </button>
            );
          })}
        </aside>
        <div className="camera-detail">
          <Panel>
            <div className="camera-detail-title">
              <div>
                <h2>{displayCameraName(camera.name)}</h2>
                <p>
                  {
                    data.locations.find((l) => l.id === camera.location_id)
                      ?.name
                  }{" "}
                  ·{" "}
                  {camera.stream_enabled
                    ? "Live input, " + (camera.segment_sec || 60) + "s segments"
                    : "Uploaded recordings"}
                </p>
              </div>
              <Badge value={video?.status || "offline"}>
                {video ? label(video.status) : "No recording"}
              </Badge>
            </div>
            <div className="camera-tabs" role="tablist" onKeyDown={tabKeys} aria-label="Camera detail">
              {[
                ["coverage", "Coverage"],
                ["rules", "Rules"],
                ["recordings", `Recordings (${videos.length})`],
                ["live", "Live input"],
              ].map(([id, name]) => (
                <button
                  key={id}
                  role="tab"
                  aria-selected={tab === id}
              tabIndex={tab === id ? 0 : -1}
                  className={tab === id ? "active" : ""}
                  onClick={() => setTab(id as typeof tab)}
                >
                  {name}
                </button>
              ))}
            </div>
            {dirty && (
              <div className="unsaved-bar" role="status">
                <span>Unsaved rule changes for this camera.</span>
                <div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setRules(structuredClone(camera.rules || {}))
                    }
                  >
                    Discard
                  </Button>
                  <Button size="sm" disabled={saving} onClick={save}>
                    {saving ? "Saving…" : "Save rules"}
                  </Button>
                </div>
              </div>
            )}
            <div
              className={
                "camera-pane " + (tab === "coverage" ? "active" : "")
              }
            >
            <div
              className={"zone-stage " + (drawing ? "is-drawing" : "")}
              style={{
                aspectRatio: aspect,
                maxWidth: `min(100%, ${aspect * 65}vh)`,
                marginInline: "auto",
              }}
            >
              {video ? (
                <video
                  key={video.id}
                  controls
                  poster={video.thumbnail_url || undefined}
                  src={"/api/videos/" + video.id + "/media"}
                  preload="metadata"
                  onLoadedMetadata={(e) => {
                    const v = e.currentTarget;
                    if (v.videoWidth && v.videoHeight)
                      setFrame({
                        id: video.id,
                        aspect: v.videoWidth / v.videoHeight,
                      });
                  }}
                />
              ) : (
                <div className="zone-stage-empty">
                  <CameraIcon size={38} strokeWidth={1} />
                  <strong>Your camera view will appear here</strong>
                  <span>
                    Upload a recording to draw zones against the actual scene.
                  </span>
                </div>
              )}
              <svg
                ref={svg}
                viewBox={`0 0 1000 ${stageHeight}`}
                preserveAspectRatio="none"
                onClick={onDraw}
                aria-label="Camera zones"
                className={drawing ? "drawing" : ""}
              >
                {["R1", "R3"].map((id) => {
                  const rule = rules[id];
                  return rule?.enabled && rule.zone?.length ? (
                    <g key={id} className={"zone-" + id}>
                      <polygon
                        points={rule.zone
                          .map((p) => `${p[0] * 1000},${p[1] * stageHeight}`)
                          .join(" ")}
                        fill={id === "R1" ? "#dca54b22" : "#d66d5b22"}
                        stroke={id === "R1" ? "#e8b554" : "#e78675"}
                        strokeWidth="2"
                        strokeDasharray="7 5"
                      />
                      <text
                        x={rule.zone[0][0] * 1000 + 8}
                        y={rule.zone[0][1] * stageHeight + 21}
                        fill={id === "R1" ? "#e8b554" : "#ffb2a4"}
                        fontSize="17"
                      >
                        {id === "R1" ? "R1 · Parking" : "R3 · Restricted"}
                      </text>
                    </g>
                  ) : null;
                })}
                {rules.R3?.line && (
                  <polyline
                    points={rules.R3.line
                      .map((p) => `${p[0] * 1000},${p[1] * stageHeight}`)
                      .join(" ")}
                    stroke="#ffb2a4"
                    strokeWidth="4"
                  />
                )}
                {points.length > 0 && (
                  <>
                    <polyline
                      points={points
                        .map((p) => `${p[0] * 1000},${p[1] * stageHeight}`)
                        .join(" ")}
                      fill="none"
                      stroke="#fff"
                      strokeWidth="3"
                    />
                    {points.map((p, i) => (
                      <circle
                        key={i}
                        cx={p[0] * 1000}
                        cy={p[1] * stageHeight}
                        r="5"
                        fill="#fff"
                      />
                    ))}
                  </>
                )}
              </svg>
            </div>
            <div className="zone-toolbar">
              <span>
                <ScanLine size={16} />
                {drawing
                  ? drawing === "line"
                    ? "Click two endpoints on the scene."
                    : "Click points around the area, then finish."
                  : "Zones use normalised coordinates across the camera view."}
              </span>
              <select
                aria-label="Zone to edit"
                value={zoneRule}
                onChange={(e) => setZoneRule(e.target.value)}
                disabled={!!drawing}
              >
                <option value="R1">R1 Parking zone</option>
                <option value="R3">R3 Restricted zone</option>
              </select>
              {drawing ? (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={points.length < 3 || drawing === "line"}
                    onClick={finish}
                  >
                    <Check size={14} /> Finish area
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setDrawing(null);
                      setPoints([]);
                    }}
                  >
                    Cancel
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!frameReady}
                    onClick={() => {
                      setDrawing("zone");
                      setPoints([]);
                    }}
                  >
                    <Plus size={14} /> Draw area
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!frameReady}
                    onClick={() => {
                      setDrawing("line");
                      setPoints([]);
                    }}
                  >
                    Draw R3 line
                  </Button>
                </>
              )}
            </div>
            {!video && (
              <div className="zone-empty-note">
                Default zones are placeholders. Draw them against an uploaded
                recording before relying on these rules.
              </div>
            )}
            <details className="coverage-map">
              <summary className="coverage-map-head">
                <span>
                  <strong>Property coverage</strong>
                  <small>
                    {data.locations.length} zones · {data.cameras.length}{" "}
                    cameras configured
                  </small>
                </span>
                <ChevronDown size={15} className="coverage-chevron" />
              </summary>
              <SiteMap
                locations={data.locations}
                selected={camera.location_id}
              />
            </details>
            </div>
          </Panel>
          <div className={"camera-pane " + (tab === "live" ? "active" : "")}>
            <LiveInput camera={camera} />
          </div>
          <div className={"camera-pane " + (tab === "rules" ? "active" : "")}>
          <Panel
            title="Behaviour rules"
            action={
              <Button size="sm" disabled={saving || !!drawing} onClick={save}>
                <Check size={15} />
                {saving ? "Saving…" : "Save rules"}
              </Button>
            }
          >
            <div className="rules-grid">
              <div className="rule-editor">
                <div className="rule-heading">
                  <span className="rule-id">R1</span>
                  <h3>Vehicle loitering</h3>
                  <label className="switch-label">
                    <input
                      aria-label="Enable vehicle loitering rule"
                      type="checkbox"
                      checked={!!rules.R1?.enabled}
                      onChange={(e) =>
                        update("R1", { enabled: e.target.checked })
                      }
                    />
                    <span />
                  </label>
                </div>
                <p>
                  Measure time spent in the parking zone or repeated approaches
                  to different vehicles.
                </p>
                <div className="form-grid">
                  <Field label="Loiter threshold (seconds)">
                    <input
                      type="number"
                      min="10"
                      max="3600"
                      value={rules.R1?.loiter_sec ?? 120}
                      onChange={(e) =>
                        update("R1", { loiter_sec: Number(e.target.value) })
                      }
                    />
                  </Field>
                  <Field label="Different vehicles">
                    <input
                      type="number"
                      min="2"
                      max="20"
                      value={rules.R1?.min_vehicles ?? 3}
                      onChange={(e) =>
                        update("R1", { min_vehicles: Number(e.target.value) })
                      }
                    />
                  </Field>
                </div>
                <details className="advanced-rule">
                  <summary>Additional measurements</summary>
                  <div className="form-grid">
                    <Field label="Window (seconds)">
                      <input
                        type="number"
                        min="30"
                        value={rules.R1?.window_sec ?? 300}
                        onChange={(e) =>
                          update("R1", { window_sec: Number(e.target.value) })
                        }
                      />
                    </Field>
                    <Field label="Dwell per vehicle (seconds)">
                      <input
                        type="number"
                        min="1"
                        value={rules.R1?.min_dwell_sec ?? 3}
                        onChange={(e) =>
                          update("R1", {
                            min_dwell_sec: Number(e.target.value),
                          })
                        }
                      />
                    </Field>
                  </div>
                </details>
              </div>
              <div className="rule-editor">
                <div className="rule-heading">
                  <span className="rule-id red">R3</span>
                  <h3>Restricted entry</h3>
                  <label className="switch-label">
                    <input
                      aria-label="Enable restricted entry rule"
                      type="checkbox"
                      checked={!!rules.R3?.enabled}
                      onChange={(e) =>
                        update("R3", { enabled: e.target.checked })
                      }
                    />
                    <span />
                  </label>
                </div>
                <p>
                  Check entry into the restricted area or crossing the
                  configured line during active hours.
                </p>
                <div className="form-grid">
                  <Field label="Active from (MYT)">
                    <input
                      type="time"
                      value={rules.R3?.active_start ?? "19:00"}
                      onChange={(e) =>
                        update("R3", { active_start: e.target.value })
                      }
                    />
                  </Field>
                  <Field label="Active until (MYT)">
                    <input
                      type="time"
                      value={rules.R3?.active_end ?? "06:00"}
                      onChange={(e) =>
                        update("R3", { active_end: e.target.value })
                      }
                    />
                  </Field>
                </div>
                {rules.R3?.line && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => update("R3", { line: null })}
                  >
                    <RotateCcw size={13} /> Remove crossing line
                  </Button>
                )}
              </div>
            </div>
          </Panel>
          </div>
          <div className={"camera-pane " + (tab === "recordings" ? "active" : "")}>
          <Panel
            title="Recordings"
            action={
              <span className="panel-subtle">
                Private playback · Audit logged
              </span>
            }
          >
            {videos.length ? (
              <div className="recording-list">
                {videos.map((v) => (
                  <div
                    key={v.id}
                    className={
                      "recording-row " + (video?.id === v.id ? "active" : "")
                    }
                  >
                    <Film size={20} />
                    <button
                      className="recording-name"
                      onClick={() => setActiveVideo(v.id)}
                    >
                      <strong>{v.filename}</strong>
                      <small>
                        {dateTime(v.recorded_at)} MYT ·{" "}
                        {duration(v.duration_sec || 0)}
                        {v.analysis_source ? " · " + v.analysis_source : ""}
                      </small>
                      {v.error && <span className="form-error">{v.error}</span>}
                      {v.description_status && (
                        <small>
                          Descriptions: {label(v.description_status)}
                          {v.description_status === "processing" &&
                            ` · ${Number(v.analysis_metrics?.description_frames_completed || 0)}/${Number(v.analysis_metrics?.description_frames_total || 0)} frames`}
                        </small>
                      )}
                    </button>
                    <Badge value={v.status} />
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={"Play " + v.filename}
                      onClick={() => play(v.id)}
                    >
                      <Play size={16} />
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        v.status === "queued" ||
                        v.status === "processing" ||
                        v.description_status === "processing"
                      }
                      onClick={() =>
                        run(
                          () =>
                            api(
                              "/videos/" +
                                v.id +
                                "/analyse" +
                                (v.status === "ready" &&
                                v.description_status === "ready"
                                  ? "?force=true"
                                  : ""),
                              { method: "POST" },
                            ),
                          "Recording queued for local analysis",
                        )
                      }
                    >
                      {v.status === "queued" ||
                      v.status === "processing" ||
                      v.description_status === "processing" ? (
                        <LoaderCircle size={14} className="spin" />
                      ) : (
                        <ScanLine size={14} />
                      )}
                      {v.status === "queued" ||
                      v.status === "processing" ||
                      v.description_status === "processing"
                        ? "Analysing…"
                        : v.status === "ready" &&
                            ["failed", "partial"].includes(
                              v.description_status || "",
                            )
                          ? "Retry semantic analysis"
                          : v.status === "ready"
                            ? "Reanalyse"
                            : "Analyse"}
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <Empty
                compact
                icon={Upload}
                title="No recordings for this camera"
                text="Add an MP4 recording and its original time to start analysis."
                action={
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setUploadOpen(true)}
                  >
                    Upload recording
                  </Button>
                }
              />
            )}
          </Panel>
          <Panel
            title="Behaviour timeline"
            action={<Clock3 size={16} className="muted" />}
          >
            {events.length ? (
              <div>
                {events.map((e) => (
                  <EventRow key={e.id} event={e} />
                ))}
              </div>
            ) : (
              <Empty
                compact
                icon={ScanLine}
                title="No behaviour events recorded"
                text="Only rule-triggered activity from analysed recordings will appear here."
              />
            )}
          </Panel>
          </div>
        </div>
      </div>
      <Dialog
        open={uploadOpen}
        onOpenChange={(v) => {
          if (!uploading) setUploadOpen(v);
        }}
        title={"Upload to " + camera.name}
        description="Recordings remain on this local system and are available to staff only."
      >
        <form className="stack-form" onSubmit={upload}>
          <Field label="Camera">
            <select
              value={camera.id}
              onChange={(e) => switchCamera(e.target.value)}
            >
              {data.cameras.map((c) => (
                <option key={c.id} value={c.id}>
                  {displayCameraName(c.name)}
                </option>
              ))}
            </select>
          </Field>
          <label className="upload-drop">
            <Upload size={30} strokeWidth={1.4} />
            <strong>{file ? file.name : "Choose an MP4 recording"}</strong>
            <span>Original camera footage, stored locally</span>
            <input
              type="file"
              accept="video/mp4,.mp4"
              required
              onChange={(e) => setFile(e.target.files?.[0] || null)}
            />
          </label>
          <Field
            label="Recording start (MYT)"
            hint="Use the actual recording time so search and active hours are accurate."
          >
            <input
              type="datetime-local"
              required
              value={recordedAt}
              onChange={(e) => setRecordedAt(e.target.value)}
            />
          </Field>
          <div className="info-strip">
            <TriangleAlert size={16} />
            Confirm that you have permission to process the people and property
            shown in this recording.
          </div>
          <Button type="submit" disabled={uploading || !file}>
            {uploading ? (
              <>
                <LoaderCircle size={16} className="spin" /> Uploading…
              </>
            ) : (
              <>
                <Upload size={16} /> Upload recording
              </>
            )}
          </Button>
        </form>
      </Dialog>
    </>
  );
}
