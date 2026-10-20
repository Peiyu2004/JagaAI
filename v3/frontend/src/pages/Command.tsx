import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import { useApp } from "../context";
import { Button } from "../components/ui/button";
import { label, relativeTime, cameraName as displayCameraName } from "../api";
import type { Alert, Video } from "../types";
import { ReviewQueue, type QueueItem } from "../components/command/ReviewQueue";
import { EvidenceCard } from "../components/command/EvidenceCard";
import { SiteMap } from "../components/command/SiteMap";
import { CountUp } from "../components/command/CountUp";
import { ZonesPanel, type ZoneRow } from "../components/command/ZonesPanel";
import { ActivityFeed, type FeedItem } from "../components/command/ActivityFeed";
import { canUseWebGL } from "../components/town/canUseWebGL";
import type { TownZone, TownCamera } from "../components/town/TownScene";
import "../command.css";

// three.js lives in its own chunk; it is only fetched when the 3D view is used.
const TownScene = lazy(() => import("../components/town/TownScene"));

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

function previewFor(alert: Alert, videos: Video[], width: number) {
  const video = videos.find((v) => v.id === alert.event?.video_id);
  const frame =
    alert.scene?.keyframe_url ||
    alert.event?.keyframes?.find((url) => url.startsWith("/api/")) ||
    video?.thumbnail_url;
  const prefix = `/api/videos/${alert.event?.video_id}/keyframes/`;
  return frame?.startsWith(prefix)
    ? `/api/videos/${alert.event.video_id}/thumbnail?width=${width}&frame=${encodeURIComponent(frame.slice(prefix.length))}`
    : frame
      ? `${frame}?width=${width}`
      : undefined;
}

function greeting() {
  const hour = new Date().getHours();
  if (hour >= 5 && hour <= 11) return "Good morning";
  if (hour >= 12 && hour <= 17) return "Good afternoon";
  return "Good evening";
}

const isSevere = (a: Alert) => a.priority === "high" || a.priority === "urgent";

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

function SceneLoading() {
  return (
    <div className="cc-town cc-town-loading" role="status">
      <span className="cc-label">Loading site model</span>
    </div>
  );
}

export default function Command() {
  const { data, go, openAlert, play } = useApp();
  const [activeIndex, setActiveIndex] = useState(0);
  const [hoveredLocation, setHoveredLocation] = useState<string | null>(null);
  const [rowHoverZone, setRowHoverZone] = useState<string | null>(null);
  const [selectedCameraId, setSelectedCameraId] = useState<string | null>(null);
  const [focusCameraId, setFocusCameraId] = useState<string | null>(null);
  // Decided once on mount: 3D needs WebGL and room; otherwise the 2D map.
  const [mode] = useState<"3d" | "2d">(() =>
    canUseWebGL() && window.innerWidth >= 760 ? "3d" : "2d",
  );
  const [reducedMotion] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  const pending = data.alerts
    .filter((a) => a.status === "pending")
    .sort(
      (a, b) =>
        (priorityRank[a.priority] ?? 3) - (priorityRank[b.priority] ?? 3),
    );
  const cameraName = (id?: string) =>
    displayCameraName(data.cameras.find((c) => c.id === id)?.name);
  const locationOf = (cameraId?: string) => {
    const camera = data.cameras.find((c) => c.id === cameraId);
    return data.locations.find((l) => l.id === camera?.location_id);
  };

  const items: QueueItem[] = pending.map((alert) => {
    const location = locationOf(alert.event?.camera_id);
    return {
      alert,
      title: label(alert.event?.type || "alert"),
      reason: reasonFor(alert),
      camera: cameraName(alert.event?.camera_id),
      location: location?.name || "Property",
      locationId: location?.id,
      thumb: previewFor(alert, data.videos, 160),
      when: relativeTime(alert.created_at),
    };
  });
  const index = items.length ? Math.min(activeIndex, items.length - 1) : 0;
  const current = items[index];

  // Scene data, memoized on data so array identity is stable between renders.
  const { zones, cameras } = useMemo(() => {
    const pendingAlerts = data.alerts.filter((a) => a.status === "pending");
    const cameraZone = new Map(data.cameras.map((c) => [c.id, c.location_id]));
    const zones: TownZone[] = data.locations.map((l) => {
      const here = pendingAlerts.filter(
        (a) => cameraZone.get(a.event?.camera_id) === l.id,
      );
      return {
        id: l.id,
        name: l.name,
        area: l.map_area,
        pending: here.length,
        severe: here.some(isSevere),
      };
    });
    const cameras: TownCamera[] = data.cameras.map((c) => {
      const here = pendingAlerts.filter((a) => a.event?.camera_id === c.id);
      return {
        id: c.id,
        name: displayCameraName(c.name),
        zoneId: c.location_id,
        pending: here.length,
        severe: here.some(isSevere),
      };
    });
    return { zones, cameras };
  }, [data]);

  // User actions only: none of these run when data refreshes.
  const activate = (i: number) => {
    const item = items[i];
    if (!item) return;
    setActiveIndex(i);
    const cameraId = item.alert.event?.camera_id ?? null;
    setFocusCameraId(cameraId);
    setSelectedCameraId(cameraId);
  };
  const selectCamera = (cameraId: string) => {
    setSelectedCameraId(cameraId);
    setFocusCameraId(cameraId);
    const first = items.findIndex((i) => i.alert.event?.camera_id === cameraId);
    if (first >= 0) setActiveIndex(first);
  };
  const selectZone = (zoneId: string) => {
    const first = items.findIndex((i) => i.locationId === zoneId);
    if (first >= 0) {
      activate(first);
      return;
    }
    const camera = data.cameras.find((c) => c.location_id === zoneId);
    if (camera) {
      setFocusCameraId(camera.id);
      setSelectedCameraId(null);
    }
  };
  const overview = () => {
    setFocusCameraId(null);
    setSelectedCameraId(null);
  };

  // Clicking anywhere outside the evidence card closes it; the map view stays as it is.
  useEffect(() => {
    if (!selectedCameraId) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (target?.closest(".cc-ecard, .town-pin")) return;
      setSelectedCameraId(null);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [selectedCameraId]);

  // Keyboard: J/K move through the queue, Enter opens, Escape returns to overview.
  const live = useRef({ items, index, activate, overview, openAlert });
  live.current = { items, index, activate, overview, openAlert };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey)
        return;
      if (isTypingTarget(e.target)) return;
      if (document.querySelector('[role="dialog"]')) return;
      const { items, index, activate, overview, openAlert } = live.current;
      const key = e.key.toLowerCase();
      if (key === "escape") {
        overview();
        return;
      }
      if (!items.length) return;
      if (key === "j") {
        e.preventDefault();
        activate((index + 1) % items.length);
      } else if (key === "k") {
        e.preventDefault();
        activate((index - 1 + items.length) % items.length);
      } else if (key === "enter") {
        // Enter on a focused control belongs to that control.
        const t = e.target as HTMLElement | null;
        if (t && t.closest("button, a, summary, [role='button']")) return;
        e.preventDefault();
        openAlert(items[index].alert.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const renderCard = (cameraId: string) => {
    const camAlerts = items.filter((i) => i.alert.event?.camera_id === cameraId);
    const activeHere = camAlerts.findIndex((i) => i.alert.id === current?.alert.id);
    const shown = activeHere >= 0 ? activeHere : 0;
    const item = camAlerts[shown];
    const latestVideo = data.videos
      .filter((v) => v.camera_id === cameraId)
      .sort((a, b) => (a.recorded_at < b.recorded_at ? 1 : -1))[0];
    return (
      <EvidenceCard
        camera={cameraName(cameraId)}
        zone={locationOf(cameraId)?.name || "Property"}
        alerts={camAlerts.map((i) => i.alert)}
        current={shown}
        preview={item ? previewFor(item.alert, data.videos, 480) : undefined}
        title={item?.title}
        reason={item?.reason}
        latestVideo={latestVideo}
        onNext={() => {
          const next = camAlerts[(shown + 1) % camAlerts.length];
          activate(items.indexOf(next));
        }}
        onClose={() => setSelectedCameraId(null)}
        onOpen={openAlert}
        onPlay={play}
        onCameras={() => go("cameras")}
      />
    );
  };

  const highPriority = pending.filter(isSevere).length;
  const firstName = data.user.name.trim().split(/\s+/)[0] || data.user.name;
  const count = pending.length;
  const s = data.summary;

  // Events with the moment they happened (recording start + offset into the clip), newest first.
  const alertByEvent = new Map(data.alerts.map((a) => [a.event_id, a]));
  const timed = data.events
    .flatMap((event) => {
      const video = data.videos.find((v) => v.id === event.video_id);
      const at = video?.recorded_at
        ? new Date(new Date(video.recorded_at).getTime() + (event.start_sec || 0) * 1000)
        : null;
      return at && !Number.isNaN(at.getTime()) ? [{ event, at }] : [];
    })
    .sort((a, b) => b.at.getTime() - a.at.getTime());
  const clock = (d: Date) =>
    d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const day = (d: Date) =>
    d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

  const zoneRows: ZoneRow[] = zones.map((z) => {
    const latest = timed.find(({ event }) => locationOf(event.camera_id)?.id === z.id);
    return {
      id: z.id,
      name: z.name,
      pending: z.pending,
      severe: z.severe,
      cameras: cameras
        .filter((c) => c.zoneId === z.id)
        .map((c) => ({ id: c.id, name: c.name, alerting: c.pending > 0, severe: c.severe })),
      latest: latest
        ? { title: label(latest.event.type), when: `${day(latest.at)} ${clock(latest.at)}` }
        : undefined,
    };
  });

  const feed: FeedItem[] = timed.slice(0, 6).map(({ event, at }) => {
    const alert = alertByEvent.get(event.id);
    const pendingAlert = alert?.status === "pending";
    const severe = !!alert && isSevere(alert);
    return {
      id: event.id,
      time: clock(at),
      date: day(at),
      title: label(event.type),
      place: `${cameraName(event.camera_id)} · ${locationOf(event.camera_id)?.name ?? "Property"}`,
      state: pendingAlert ? "pending" : alert ? "done" : "logged",
      severe: pendingAlert && severe,
      status: pendingAlert
        ? severe
          ? "High · review"
          : "Needs review"
        : alert
          ? label(alert.status)
          : "Logged",
      onOpen: () => (alert ? openAlert(alert.id) : play(event.video_id, event.start_sec)),
    };
  });

  // Sections (and the rows inside them) fade and rise in as they scroll into view.
  // Content stays visible if this never runs; reduced-motion users skip it entirely.
  const pageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = pageRef.current;
    if (!root || reducedMotion || !("IntersectionObserver" in window)) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          e.target.classList.add("is-in");
          io.unobserve(e.target);
        }
      },
      { rootMargin: "0px 0px -6% 0px", threshold: 0.06 },
    );
    const observe = () =>
      root.querySelectorAll("[data-reveal]:not(.is-in)").forEach((el) => io.observe(el));
    root.classList.add("reveal-ready");
    observe();
    const mo = new MutationObserver(observe);
    mo.observe(root, { childList: true, subtree: true });
    return () => {
      io.disconnect();
      mo.disconnect();
    };
  }, [reducedMotion]);

  // From the Zones panel: fly the map to the zone and bring the map into view.
  const stageRef = useRef<HTMLDivElement>(null);
  const showZone = (zoneId: string) => {
    selectZone(zoneId);
    stageRef.current?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "nearest" });
  };
  const median =
    s.median_ack_sec === null ? null : Math.max(1, Math.round(s.median_ack_sec / 60));
  const initials = (name: string) =>
    name
      .split(/\s+/)
      .map((part) => part[0])
      .join("")
      .slice(0, 2)
      .toUpperCase();

  const siteMap2D = (
    <SiteMap
      locations={data.locations}
      cameras={data.cameras}
      alerts={items.map((item) => ({
        locationId: item.locationId,
        cameraId: item.alert.event?.camera_id,
        high: isSevere(item.alert),
      }))}
      hoveredLocation={hoveredLocation ?? rowHoverZone}
      onHoverLocation={setHoveredLocation}
      onZoneClick={selectZone}
      cameraLabel={(camera) => displayCameraName(camera.name)}
    />
  );

  return (
    <div className="cc-page" ref={pageRef}>
      <header className="cc-head">
        <div className="cc-head-text">
          <p className="cc-label cc-kicker">
            {greeting()}, {firstName} · Serenia City
          </p>
          <h1 className="cc-title">
            {count === 0 ? (
              "No alerts need review."
            ) : (
              <>
                <span className="sr-only">{count}</span>
                <CountUp value={count} className="cc-count" />{" "}
                {count === 1 ? "alert needs review." : "alerts need review."}
              </>
            )}
          </h1>
          {highPriority > 0 && items[0] && (
            <p className="cc-sub">
              {highPriority} high priority at {items[0].location}.
            </p>
          )}
        </div>
        <div className="cc-actions">
          <Button variant="outline" onClick={() => go("ask")}>
            Ask JagaAI <kbd>/</kbd>
          </Button>
          <Button
            onClick={() => (current ? openAlert(current.alert.id) : go("alerts"))}
          >
            Review next <ArrowRight size={16} />
          </Button>
        </div>
      </header>

      <div className="cc-main" ref={stageRef} data-reveal>
        <section
          className={"cc-card cc-site" + (mode === "3d" ? " is-3d" : "")}
          aria-label="Site"
        >
          {mode === "3d" ? (
            <Suspense fallback={<SceneLoading />}>
              <TownScene
                className="cc-town"
                zones={zones}
                cameras={cameras}
                focusCameraId={focusCameraId}
                selectedCameraId={selectedCameraId}
                highlightZoneId={rowHoverZone}
                onHoverZone={setHoveredLocation}
                onSelectZone={selectZone}
                onSelectCamera={selectCamera}
                onOverview={overview}
                renderCard={renderCard}
                fallback={siteMap2D}
                reducedMotion={reducedMotion}
              />
            </Suspense>
          ) : (
            siteMap2D
          )}
          <dl className="cc-stats">
            <div>
              <dt className="cc-label">To review</dt>
              <dd>{count}</dd>
            </div>
            <div>
              <dt className="cc-label">High priority</dt>
              <dd className={highPriority ? "is-high" : ""}>{highPriority}</dd>
            </div>
            <div>
              <dt className="cc-label">Cameras</dt>
              <dd>{data.cameras.length}</dd>
            </div>
            <div>
              <dt className="cc-label">Analysed</dt>
              <dd>
                {s.analysed_video_count}
                <small>/{s.video_count}</small>
              </dd>
            </div>
          </dl>
        </section>

        <ReviewQueue
          items={items}
          activeIndex={index}
          dimOutside={hoveredLocation}
          videoCount={s.video_count}
          onActivate={activate}
          onHoverRow={setRowHoverZone}
          onOpen={openAlert}
          onPlay={play}
          onQueue={() => go("alerts")}
          onAddRecording={() => go("cameras")}
        />
      </div>

      <div className="cc-lower">
        <ZonesPanel
          rows={zoneRows}
          hovered={hoveredLocation ?? rowHoverZone}
          onSelect={showZone}
          onHover={setRowHoverZone}
        />
        <ActivityFeed items={feed} onAll={() => go("alerts")} />
      </div>

      <section className="cc-team" aria-label="Team and follow-up" data-reveal>
        <button type="button" className="cc-team-item" onClick={() => go("settings")}>
          <span className="cc-label">On roster</span>
          {data.guards.length ? (
            <span className="cc-avatars">
              {data.guards.slice(0, 4).map((g) => (
                <i key={g.id} title={`${g.name} · ${g.shift}`}>
                  {initials(g.name)}
                </i>
              ))}
              {data.guards.length > 4 && <i>+{data.guards.length - 4}</i>}
            </span>
          ) : (
            <b className="is-muted">No guards yet</b>
          )}
        </button>
        <div className="cc-team-item">
          <span className="cc-label">Median review</span>
          <b className={median === null ? "is-muted" : ""}>
            {median === null ? "No reviews yet" : `${median} min`}
          </b>
        </div>
        <button type="button" className="cc-team-item" onClick={() => go("leads")}>
          <span className="cc-label">Resident leads</span>
          <b className={s.new_leads ? "" : "is-muted"}>{s.new_leads} new</b>
        </button>
        <button type="button" className="cc-team-item" onClick={() => go("incidents")}>
          <span className="cc-label">Open incidents</span>
          <b className={s.open_incidents ? "" : "is-muted"}>{s.open_incidents}</b>
        </button>
      </section>
    </div>
  );
}
