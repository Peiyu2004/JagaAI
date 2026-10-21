import {
  useRef,
  useEffect,
  useId,
  useState,
  type ReactNode,
  type ComponentType,
} from "react";
import {
  Camera,
  VideoOff,
  ArrowUpRight,
  ShieldCheck,
  ChevronRight,
} from "lucide-react";
import { Button } from "./ui/button";
import { dateTime, label, duration, cameraName } from "../api";
import { useApp } from "../context";
import type { Event, Video } from "../types";
// JagaAI mark: a roof sheltering the J, for a team that looks after a community.
export function LogoMark({ className = "" }: { className?: string }) {
  const id = "jg" + useId().replace(/[^a-zA-Z0-9]/g, "");
  return (
    <svg
      className={"logo-mark " + className}
      viewBox="0 0 48 48"
      aria-hidden="true"
    >
      <defs>
        <linearGradient
          id={id}
          x1="6"
          y1="4"
          x2="42"
          y2="44"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#5f8fff" />
          <stop offset="1" stopColor="#1e4bd2" />
        </linearGradient>
      </defs>
      <path
        className="logo-roof"
        d="M8.5 21.5 24 8.5l15.5 13"
        fill="none"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M31 22.5v9a7 7 0 0 1-14 0"
        fill="none"
        stroke={`url(#${id})`}
        strokeWidth="5.2"
        strokeLinecap="round"
      />
    </svg>
  );
}
export function Brand({ small = false }: { small?: boolean }) {
  return (
    <div className={"brand " + (small ? "brand-small" : "")}>
      <span className="brand-mark">
        <LogoMark />
      </span>
      <span>
        Jaga<span className="brand-ai">AI</span>
        <small>Property security</small>
      </span>
    </div>
  );
}
export function Badge({
  value,
  children,
}: {
  value: string;
  children?: ReactNode;
}) {
  return (
    <span className={"badge badge-" + value}>{children || label(value)}</span>
  );
}
export function Panel({
  title,
  action,
  children,
  className = "",
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={"panel " + className}>
      {title && (
        <div className="panel-head">
          <h2>{title}</h2>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}
export function Empty({
  icon: Icon = ShieldCheck,
  title,
  text,
  action,
  compact = false,
}: {
  icon?: ComponentType<{ size?: number; strokeWidth?: number }>;
  title: string;
  text: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={"empty " + (compact ? "empty-compact" : "")}>
      <span className="empty-icon">
        <Icon size={26} strokeWidth={1.4} />
      </span>
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}
export function Field({
  label: fieldLabel,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{fieldLabel}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function VideoPlayer({
  video,
  at = 0,
  poster,
}: {
  video: Video;
  at?: number;
  poster?: string | null;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (ref.current) ref.current.currentTime = at;
  }, [at, video.id]);
  return (
    <div className="video-player">
      {failed ? (
        <div className="video-fallback">
          <VideoOff size={26} />
          <strong>Recording could not be played</strong>
          <span>
            The file may have expired or is still being prepared. The review
            record and keyframes are still available.
          </span>
        </div>
      ) : (
        <video
          ref={ref}
          controls
          playsInline
          preload="metadata"
          poster={poster || video.thumbnail_url || undefined}
          aria-label={"Recording " + video.filename}
          src={"/api/videos/" + video.id + "/media"}
          onError={() => setFailed(true)}
          onLoadedMetadata={() => {
            if (ref.current) ref.current.currentTime = at;
          }}
        />
      )}
      <div className="video-meta">
        <span>{video.filename}</span>
        <span>{dateTime(video.recorded_at)} MYT</span>
      </div>
    </div>
  );
}
export function CameraBlank({
  name,
  location,
  onClick,
  compact = false,
}: {
  name: string;
  location: string;
  onClick?: () => void;
  compact?: boolean;
}) {
  return (
    <button
      className={"camera-blank " + (compact ? "camera-blank-compact" : "")}
      onClick={onClick}
    >
      <div className="camera-guide">
        <span />
        <span />
        <span />
        <span />
      </div>
      <Camera size={30} strokeWidth={1.1} />
      <span className="camera-blank-status">No recording uploaded</span>
      <span className="camera-blank-bottom">
        <span>
          <strong>{name}</strong>
          <small>{location}</small>
        </span>
        <ArrowUpRight size={17} />
      </span>
    </button>
  );
}
export function EventRow({
  event,
  related = false,
}: {
  event: Event;
  related?: boolean;
}) {
  const { data, play } = useApp();
  const camera = data.cameras.find((c) => c.id === event.camera_id);
  const frame = event.keyframes?.find((url) => url.startsWith("/api/"));
  return (
    <button
      className="event-row"
      onClick={() => play(event.video_id, event.start_sec)}
    >
      <span className="event-thumb">
        {frame ? <img src={frame} alt="" loading="lazy" /> : <Camera size={24} />}
        <span>{duration(event.start_sec)}</span>
      </span>
      <span className="event-row-body">
        <strong>{label(event.type)}</strong>
        <span>
          {cameraName(camera?.name)}{" "}
          <span className="muted">
            · {duration(event.start_sec)} – {duration(event.end_sec)}
          </span>
        </span>
        <small>
          {event.rule_id} · Rule v{event.rule_version}
          {related ? " · Related footage" : ""}
        </small>
      </span>
      <ChevronRight size={18} />
    </button>
  );
}
export function NoVideos() {
  const { go } = useApp();
  return (
    <Empty
      icon={VideoOff}
      title="Start with your first recording"
      text="Upload a camera recording to analyse activity and build searchable evidence."
      action={<Button onClick={() => go("cameras")}>Upload recording</Button>}
    />
  );
}
