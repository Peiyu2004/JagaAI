import { useEffect, useState, type FormEvent } from "react";
import { Radio, Square, Play, TriangleAlert, Info } from "lucide-react";
import { useApp } from "../context";
import { api, json, clockTime } from "../api";
import { Panel, Field } from "./shared";
import { Button } from "./ui/button";
import type { Camera } from "../types";

const SEGMENTS = [30, 60, 120, 300];
// Live input for one camera: an RTSP/HTTP address, or an uploaded recording replayed as a simulated camera.
export function LiveInput({ camera }: { camera: Camera }) {
  const { data, run } = useApp();
  const saved = camera.stream_url || "";
  const isDemo = saved.startsWith("demo:");
  const [mode, setMode] = useState<"camera" | "demo">(
    isDemo ? "demo" : "camera",
  );
  const [url, setUrl] = useState("");
  const [demoId, setDemoId] = useState(isDemo ? saved.slice(5) : "");
  const [segment, setSegment] = useState(camera.segment_sec || 60);
  const [busy, setBusy] = useState(false);
  const admin = data.user.role === "admin";
  const clips = data.videos.filter(
    (v) => (v.source || "upload") === "upload" && v.status === "ready",
  );
  const live = camera.live;
  useEffect(() => {
    const demo = (camera.stream_url || "").startsWith("demo:");
    setMode(demo ? "demo" : "camera");
    setDemoId(demo ? (camera.stream_url || "").slice(5) : "");
    setUrl("");
    setSegment(camera.segment_sec || 60);
  }, [camera.id, camera.stream_url, camera.segment_sec]);
  const segments = data.videos.filter(
    (v) => v.camera_id === camera.id && v.source === "live",
  );
  const waiting = segments.filter(
    (v) => v.status === "queued" || v.status === "processing",
  ).length;
  const save = async (enabled: boolean, e?: FormEvent) => {
    e?.preventDefault();
    const next =
      mode === "demo" ? (demoId ? "demo:" + demoId : "") : url.trim();
    const body: Record<string, unknown> = { enabled, segment_sec: segment };
    if (mode === "demo" || next || (isDemo && mode === "camera"))
      body.url = next;
    setBusy(true);
    await run(
      () =>
        api("/cameras/" + camera.id + "/stream", {
          method: "PUT",
          body: json(body),
        }),
      enabled ? "Live input started" : "Live input stopped",
    );
    setBusy(false);
    setUrl("");
  };
  const state = !camera.stream_enabled
    ? "off"
    : live?.error
      ? "error"
      : live?.last_segment_at
        ? "running"
        : "starting";
  return (
    <Panel
      title="Live input"
      className="live-panel"
      action={
        <span className={"live-state live-" + state}>
          <Radio size={14} />
          {
            {
              running: "Recording",
              starting: "Connecting…",
              error: "Reconnecting",
              off: "Off",
            }[state]
          }
        </span>
      }
    >
      <div className="live-summary">
        {camera.stream_enabled ? (
          <p>
            <strong>{isDemo ? "Simulated camera" : "Camera stream"}</strong>{" "}
            {isDemo
              ? "replaying " +
                (data.cameras.find(
                  (c) =>
                    c.id ===
                    data.videos.find((v) => v.id === saved.slice(5))?.camera_id,
                )?.name || "a recording")
              : camera.stream_url}{" "}
            · {camera.segment_sec}s segments
            {live?.last_segment_at && (
              <> · last segment {clockTime(live.last_segment_at)} MYT</>
            )}
            {segments.length > 0 && (
              <>
                {" "}
                · {segments.length} live recordings, {waiting} waiting for
                analysis
              </>
            )}
            {!!live?.skipped && (
              <> · {live.skipped} kept but not analysed (analysis was behind)</>
            )}
          </p>
        ) : (
          <p>Live input is off. This camera uses uploaded recordings.</p>
        )}
        {live?.error && (
          <p className="live-error" role="alert">
            <TriangleAlert size={14} />
            {live.error}
          </p>
        )}
      </div>
      {admin ? (
        <form className="live-form" onSubmit={(e) => save(true, e)}>
          <div className="live-mode" role="radiogroup" aria-label="Live source">
            <button
              type="button"
              role="radio"
              aria-checked={mode === "camera"}
              className={mode === "camera" ? "active" : ""}
              onClick={() => setMode("camera")}
            >
              Camera or NVR stream
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={mode === "demo"}
              className={mode === "demo" ? "active" : ""}
              onClick={() => setMode("demo")}
            >
              Simulate with a recording
            </button>
          </div>
          {mode === "camera" ? (
            <Field
              label="Stream address"
              hint={
                saved && !isDemo
                  ? "Saved: " + saved + ". Leave blank to keep it."
                  : "For example rtsp://user:password@192.168.1.20:554/stream2 — prefer the camera’s sub-stream."
              }
            >
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="rtsp://…"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
          ) : (
            <Field
              label="Recording to replay"
              hint="Plays the recording in real time and loops it, so the live pipeline can be shown without a camera."
            >
              <select
                value={demoId}
                onChange={(e) => setDemoId(e.target.value)}
                required
              >
                <option value="">Choose a recording</option>
                {clips.map((v) => (
                  <option key={v.id} value={v.id}>
                    {data.cameras.find((c) => c.id === v.camera_id)?.name ||
                      v.filename}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field
            label="Segment length"
            hint="Each segment becomes a recording and is analysed in order. Alerts arrive about one segment plus analysis time after the moment."
          >
            <select
              value={segment}
              onChange={(e) => setSegment(Number(e.target.value))}
            >
              {SEGMENTS.map((s) => (
                <option key={s} value={s}>
                  {s < 60
                    ? s + " seconds"
                    : s / 60 + (s === 60 ? " minute" : " minutes")}
                </option>
              ))}
            </select>
          </Field>
          <div className="live-actions">
            <Button type="submit" disabled={busy}>
              <Play size={15} />
              {camera.stream_enabled ? "Save and restart" : "Start live input"}
            </Button>
            {camera.stream_enabled && (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => save(false)}
              >
                <Square size={14} /> Stop
              </Button>
            )}
          </div>
          <p className="live-note">
            <Info size={14} />
            Video stays on this computer. A 4 GB laptop GPU keeps up with about
            one or two live cameras; later segments are kept but not analysed
            when it falls behind.
          </p>
        </form>
      ) : (
        <p className="live-note">
          <Info size={14} />
          Only an administrator can change live input.
        </p>
      )}
    </Panel>
  );
}
