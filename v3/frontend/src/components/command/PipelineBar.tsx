export type PipelineRecording = {
  id: string;
  state: "ready" | "waiting" | "failed";
  name: string;
};

const MAX_CELLS = 48;

// Footage to decision: one cell per recording, then the detection funnel.
export function PipelineBar({
  recordings,
  detections,
  alerts,
  reviewed,
}: {
  recordings: PipelineRecording[];
  detections: number;
  alerts: number;
  reviewed: number;
}) {
  const ready = recordings.filter((r) => r.state === "ready").length;
  const waiting = recordings.filter((r) => r.state === "waiting").length;
  const failed = recordings.filter((r) => r.state === "failed").length;
  const total = recordings.length;
  const steps = [
    { label: "Analysed", value: ready, of: total },
    { label: "Detections", value: detections, ai: true },
    { label: "Alerts", value: alerts },
    { label: "Reviewed", value: reviewed, of: alerts },
  ];

  return (
    <section className="cc-card" aria-labelledby="cc-pipe-title">
      <div className="cc-card-head">
        <h2 id="cc-pipe-title" className="cc-label">Footage to decision</h2>
        <span className="cc-label">
          {total} {total === 1 ? "recording" : "recordings"}
        </span>
      </div>

      <div
        className="cc-cells"
        role="img"
        aria-label={`${ready} analysed, ${waiting} waiting, ${failed} failed`}
      >
        {total === 0 ? (
          <span className="cc-cell is-empty" />
        ) : total <= MAX_CELLS ? (
          recordings.map((r, i) => (
            <span
              key={r.id}
              className={`cc-cell is-${r.state}`}
              title={`${r.name} · ${r.state}`}
              style={{ animationDelay: `${i * 30}ms` }}
            />
          ))
        ) : (
          (["ready", "waiting", "failed"] as const).map((state) => {
            const n = recordings.filter((r) => r.state === state).length;
            return n ? (
              <span key={state} className={`cc-cell is-${state}`} style={{ flexGrow: n }} />
            ) : null;
          })
        )}
      </div>

      <div className="cc-cell-key">
        <span className="cc-key"><i className="cc-swatch is-ready" /> Analysed {ready}</span>
        <span className="cc-key"><i className="cc-swatch is-waiting" /> Waiting {waiting}</span>
        <span className="cc-key"><i className="cc-swatch is-failed" /> Failed {failed}</span>
      </div>

      <ol className="cc-steps">
        {steps.map((s) => (
          <li key={s.label} className={s.value ? "is-on" : ""}>
            <i className={s.ai ? "cc-node is-ai" : "cc-node"} />
            <b>
              {s.value}
              {s.of !== undefined && <small>/{s.of}</small>}
            </b>
            <span>{s.label}</span>
          </li>
        ))}
      </ol>

      <p className="cc-card-foot">
        {total === 0
          ? "No recordings yet"
          : waiting || failed
            ? `${waiting} waiting · ${failed} failed`
            : "All recordings analysed"}
      </p>
    </section>
  );
}
