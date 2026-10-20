export type ClockPoint = { hour: number; alert: boolean };

const C = 100;
const INNER = 40;
const MAX_BAR = 46;

function polar(hour: number, r: number) {
  const a = (hour / 24) * Math.PI * 2 - Math.PI / 2;
  return [C + Math.cos(a) * r, C + Math.sin(a) * r];
}

const pad = (h: number) => String(h).padStart(2, "0");

// Detections by hour of day (local time of the recorded moment), as a 24-spoke clock.
export function ActivityClock({ points }: { points: ClockPoint[] }) {
  const hours = Array.from({ length: 24 }, (_, h) => ({
    total: points.filter((p) => p.hour === h).length,
    alert: points.some((p) => p.hour === h && p.alert),
  }));
  const max = Math.max(1, ...hours.map((h) => h.total));
  const peak = hours.reduce((best, h, i) => (h.total > hours[best].total ? i : best), 0);
  const now = new Date().getHours();
  const [n1x, n1y] = polar(now + 0.5, INNER - 11);
  const [n2x, n2y] = polar(now + 0.5, INNER - 4);

  return (
    <section className="cc-card" aria-labelledby="cc-clock-title">
      <div className="cc-card-head">
        <h2 id="cc-clock-title" className="cc-label">Detections by hour</h2>
        <span className="cc-label">24 h</span>
      </div>
      <div className="cc-clock">
        <svg viewBox="0 0 200 200" role="img" aria-label={
          points.length
            ? `${points.length} detections. Busiest hour ${pad(peak)}:00 with ${hours[peak].total}.`
            : "No detections yet."
        }>
          <circle cx={C} cy={C} r={INNER - 6} className="cc-clock-face" />
          {hours.map((h, i) => {
            const [x1, y1] = polar(i + 0.5, INNER);
            const [tx, ty] = polar(i + 0.5, INNER + 4);
            const len = h.total ? 6 + (h.total / max) * (MAX_BAR - 6) : 0;
            const [x2, y2] = polar(i + 0.5, INNER + len);
            return (
              <g key={i}>
                <line x1={x1} y1={y1} x2={tx} y2={ty} className="cc-clock-tick" />
                {h.total > 0 && (
                  <line
                    x1={x1}
                    y1={y1}
                    x2={x2}
                    y2={y2}
                    pathLength={1}
                    className={h.alert ? "cc-clock-bar is-alert" : "cc-clock-bar"}
                    style={{ animationDelay: `${i * 18}ms` }}
                  />
                )}
              </g>
            );
          })}
          {[0, 6, 12, 18].map((h) => {
            const [x, y] = polar(h, INNER + MAX_BAR + 2);
            return (
              <text key={h} x={x} y={y} className="cc-clock-hour" textAnchor="middle" dominantBaseline="central">
                {pad(h)}
              </text>
            );
          })}
          <line x1={n1x} y1={n1y} x2={n2x} y2={n2y} className="cc-clock-now">
            <title>Now</title>
          </line>
          <text x={C} y={C - 4} className="cc-clock-total" textAnchor="middle">
            {points.length}
          </text>
          <text x={C} y={C + 12} className="cc-clock-caption" textAnchor="middle">
            {points.length === 1 ? "DETECTION" : "DETECTIONS"}
          </text>
        </svg>
      </div>
      <p className="cc-card-foot">
        {points.length ? (
          <>
            Peak {pad(peak)}:00–{pad((peak + 1) % 24)}:00 · {hours[peak].total}
            <span className="cc-key"><i className="cc-swatch is-ai" /> with pending alert</span>
          </>
        ) : (
          "No detections yet"
        )}
      </p>
    </section>
  );
}
