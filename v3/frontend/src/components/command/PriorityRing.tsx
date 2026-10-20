const ORDER = [
  { key: "urgent", label: "Urgent" },
  { key: "high", label: "High" },
  { key: "normal", label: "Normal" },
] as const;

const GAP = 1.6;

// Pending queue split by priority, as a segmented ring.
export function PriorityRing({
  counts,
  oldest,
}: {
  counts: Record<"urgent" | "high" | "normal", number>;
  oldest?: string;
}) {
  const total = counts.urgent + counts.high + counts.normal;
  const parts = ORDER.filter((p) => counts[p.key] > 0);
  const gaps = parts.length > 1 ? GAP : 0;
  let offset = 0;

  return (
    <section className="cc-card" aria-labelledby="cc-ring-title">
      <div className="cc-card-head">
        <h2 id="cc-ring-title" className="cc-label">Queue by priority</h2>
        <span className="cc-label">Pending</span>
      </div>
      <div className="cc-ring-body">
        <svg
          className="cc-ring"
          viewBox="0 0 120 120"
          role="img"
          aria-label={
            total
              ? ORDER.map((p) => `${counts[p.key]} ${p.label.toLowerCase()}`).join(", ")
              : "No pending alerts."
          }
        >
          <circle cx="60" cy="60" r="46" pathLength={100} className="cc-ring-track" />
          {parts.map((p) => {
            const share = (counts[p.key] / total) * 100;
            const length = Math.max(0.5, share - gaps);
            const start = offset;
            offset += share;
            return (
              <circle
                key={p.key}
                cx="60"
                cy="60"
                r="46"
                pathLength={100}
                className={`cc-ring-seg is-${p.key}`}
                transform="rotate(-90 60 60)"
                strokeDasharray={`${length} ${100 - length}`}
                strokeDashoffset={-start}
              />
            );
          })}
          <text x="60" y="58" textAnchor="middle" className="cc-ring-total">
            {total}
          </text>
          <text x="60" y="74" textAnchor="middle" className="cc-ring-caption">
            {total ? "TO REVIEW" : "CLEAR"}
          </text>
        </svg>
        <ul className="cc-legend">
          {ORDER.map((p) => (
            <li key={p.key} className={counts[p.key] ? "" : "is-zero"}>
              <i className={`cc-swatch is-${p.key}`} />
              <span>{p.label}</span>
              <b>{counts[p.key]}</b>
            </li>
          ))}
        </ul>
      </div>
      <p className="cc-card-foot">
        {total && oldest ? `Oldest waiting · ${oldest}` : "Queue clear"}
      </p>
    </section>
  );
}
