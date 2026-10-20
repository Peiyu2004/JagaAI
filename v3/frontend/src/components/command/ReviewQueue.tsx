import { ArrowRight } from "lucide-react";
import { Button } from "../ui/button";
import type { Alert } from "../../types";

export type QueueItem = {
  alert: Alert;
  title: string;
  reason: string;
  camera: string;
  location: string;
  locationId?: string;
  thumb?: string;
  when: string;
};

const isHigh = (priority: string) =>
  priority === "high" || priority === "urgent";

// Pending alerts as an accordion. The active row is inverted and expanded.
export function ReviewQueue({
  items,
  activeIndex,
  dimOutside,
  videoCount,
  onActivate,
  onHoverRow,
  onOpen,
  onPlay,
  onQueue,
  onAddRecording,
}: {
  items: QueueItem[];
  activeIndex: number;
  /** Location hovered on the map; rows from other locations dim. */
  dimOutside: string | null;
  videoCount: number;
  onActivate: (index: number) => void;
  onHoverRow: (locationId: string | null) => void;
  onOpen: (alertId: string) => void;
  onPlay: (videoId: string, at: number) => void;
  onQueue: () => void;
  onAddRecording: () => void;
}) {
  if (!items.length) {
    return (
      <section className="cc-card cc-queue cc-queue-empty" aria-labelledby="cc-queue-title">
        <span className="cc-label">Review queue</span>
        <h2 id="cc-queue-title">Review queue is clear</h2>
        {videoCount === 0 ? (
          <>
            <p>Upload MP4 footage to begin local analysis.</p>
            <Button variant="outline" onClick={onAddRecording}>
              Add your first recording <ArrowRight size={16} />
            </Button>
          </>
        ) : (
          <>
            <p>
              New alerts appear here as soon as an analysed recording triggers
              a rule.
            </p>
            <Button variant="outline" onClick={onQueue}>
              Open alert queue
            </Button>
          </>
        )}
      </section>
    );
  }

  return (
    <section className="cc-card cc-queue" aria-labelledby="cc-queue-title">
      <div className="cc-card-head">
        <h2 id="cc-queue-title" className="cc-label">
          Review queue
        </h2>
        <span className="cc-label">
          {activeIndex + 1} of {items.length} · J / K
        </span>
      </div>
      <ol className="cc-rows">
        {items.map((item, i) => {
          const active = i === activeIndex;
          const dim =
            dimOutside !== null && item.locationId !== dimOutside && !active;
          const { alert } = item;
          return (
            <li
              key={alert.id}
              className={
                "cc-row" + (active ? " is-active" : "") + (dim ? " is-dim" : "")
              }
              onMouseEnter={() => onHoverRow(item.locationId ?? null)}
              onMouseLeave={() => onHoverRow(null)}
            >
              <button
                type="button"
                className="cc-row-head"
                aria-expanded={active}
                onClick={() => onActivate(i)}
                onFocus={() => onHoverRow(item.locationId ?? null)}
                onBlur={() => onHoverRow(null)}
              >
                <span className="cc-row-thumb">
                  {item.thumb && (
                    <img src={item.thumb} alt="" width={64} height={36} loading="lazy" decoding="async" />
                  )}
                </span>
                <span className="cc-row-text">
                  <strong>{item.title}</strong>
                  <small>
                    {item.camera} · {item.location}
                  </small>
                </span>
                <span className="cc-row-meta">
                  <span className={isHigh(alert.priority) ? "cc-pri is-high" : "cc-pri"}>
                    {alert.priority}
                  </span>
                  <time dateTime={alert.created_at}>{item.when}</time>
                </span>
              </button>
              {active && (
                <div className="cc-row-body">
                  <p className="cc-row-reason">{item.reason}</p>
                  {alert.scene?.text && (
                    <blockquote className="cc-quote">
                      <span className="cc-label">What the local AI saw</span>
                      <p>{alert.scene.text}</p>
                    </blockquote>
                  )}
                  <div className="cc-row-actions">
                    <Button size="sm" onClick={() => onOpen(alert.id)}>
                      Review evidence <ArrowRight size={14} />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onPlay(alert.event.video_id, alert.event.start_sec)}
                    >
                      Play clip
                    </Button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
