import type { SyntheticEvent } from "react";
import { ArrowRight, X } from "lucide-react";
import { Button } from "../ui/button";
import type { Alert, Video } from "../../types";

const stop = (e: SyntheticEvent) => e.stopPropagation();

// Glass card anchored to a camera in the 3D scene. It only links to the review
// screen; nothing is resolved or dismissed from here.
export function EvidenceCard({
  camera,
  zone,
  alerts,
  current,
  preview,
  title,
  reason,
  latestVideo,
  onNext,
  onClose,
  onOpen,
  onPlay,
  onCameras,
}: {
  camera: string;
  zone: string;
  /** This camera's pending alerts, in queue order. */
  alerts: Alert[];
  /** The alert shown (index into alerts). */
  current: number;
  preview?: string;
  title?: string;
  reason?: string;
  latestVideo?: Video;
  onNext: () => void;
  onClose: () => void;
  onOpen: (alertId: string) => void;
  onPlay: (videoId: string, at: number) => void;
  onCameras: () => void;
}) {
  const alert = alerts[current];
  return (
    <div
      className="cc-ecard"
      role="group"
      aria-label={`${camera} evidence`}
      onPointerDown={stop}
      onPointerUp={stop}
      onClick={stop}
      onWheel={stop}
    >
      <div className="cc-ecard-head">
        <span className="cc-ecard-where">
          {camera} · {zone}
        </span>
        <span className="cc-ecard-tools">
          {alerts.length > 0 && (
            <span>
              {current + 1} of {alerts.length}
            </span>
          )}
          {alerts.length > 1 && (
            <button type="button" className="cc-ecard-text" onClick={onNext}>
              Next
            </button>
          )}
          <button type="button" className="cc-ecard-close" onClick={onClose} aria-label="Close" title="Close (Esc)">
            <X size={14} strokeWidth={2.25} />
          </button>
        </span>
      </div>

      {alert ? (
        <>
          <div className="cc-ecard-media">
            {preview && <img key={alert.id} src={preview} alt="" width={480} height={270} decoding="async" />}
          </div>
          <strong className="cc-ecard-title">{title}</strong>
          <p className="cc-ecard-reason">{reason}</p>
          {alert.scene?.text && (
            <div className="cc-ecard-saw">
              <span>What the local AI saw</span>
              <p>{alert.scene.text}</p>
            </div>
          )}
          <div className="cc-ecard-actions">
            <Button size="sm" onClick={() => onOpen(alert.id)}>
              Review &amp; decide <ArrowRight size={14} />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onPlay(alert.event.video_id, alert.event.start_sec)}
            >
              Play clip
            </Button>
          </div>
        </>
      ) : latestVideo ? (
        <>
          <div className="cc-ecard-media">
            {latestVideo.thumbnail_url && (
              <img
                key={latestVideo.id}
                src={`${latestVideo.thumbnail_url}?width=480`}
                alt=""
                width={480}
                height={270}
                decoding="async"
              />
            )}
          </div>
          <p className="cc-ecard-reason">No alerts waiting on this camera.</p>
          <div className="cc-ecard-actions">
            <Button size="sm" variant="outline" onClick={() => onPlay(latestVideo.id, 0)}>
              Play latest recording
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="cc-ecard-reason">No recording yet</p>
          <div className="cc-ecard-actions">
            <Button size="sm" variant="outline" onClick={onCameras}>
              Open cameras
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
