import type { CSSProperties } from "react";

export type ZoneRow = {
  id: string;
  name: string;
  cameras: { id: string; name: string; alerting: boolean; severe: boolean }[];
  pending: number;
  severe: boolean;
  /** Most recent event in this zone, already formatted. */
  latest?: { title: string; when: string };
};

// Every zone at a glance: what needs review, how many cameras, what happened last.
// Clicking a row flies the 3D map to that zone.
export function ZonesPanel({
  rows,
  hovered,
  onSelect,
  onHover,
}: {
  rows: ZoneRow[];
  hovered: string | null;
  onSelect: (zoneId: string) => void;
  onHover: (zoneId: string | null) => void;
}) {
  const needs = rows.filter((r) => r.pending > 0).length;
  return (
    <section className="cc-card cc-panel cc-zones" aria-labelledby="cc-zones-title" data-reveal>
      <header className="cc-panel-head">
        <div>
          <h2 id="cc-zones-title">Zones</h2>
          <p>Click a zone to fly the map there.</p>
        </div>
        <span className={"cc-chip" + (needs ? " is-pending" : " is-clear")}>
          {needs ? `${needs} need review` : "All clear"}
        </span>
      </header>
      <ul className="cc-zone-list">
        {rows.map((z, i) => {
          const state = z.severe ? "is-severe" : z.pending ? "is-pending" : "is-clear";
          return (
            <li key={z.id} style={{ "--i": i } as CSSProperties} data-reveal>
              <button
                type="button"
                className={"cc-zrow " + state + (hovered === z.id ? " is-hover" : "")}
                onClick={() => onSelect(z.id)}
                onMouseEnter={() => onHover(z.id)}
                onMouseLeave={() => onHover(null)}
                onFocus={() => onHover(z.id)}
                onBlur={() => onHover(null)}
              >
                <span className="cc-zrow-dot" aria-hidden="true" />
                <span className="cc-zrow-main">
                  <strong>{z.name}</strong>
                  <small>
                    {z.cameras.length} {z.cameras.length === 1 ? "camera" : "cameras"}
                    {" · "}
                    {z.latest ? `Last: ${z.latest.title}, ${z.latest.when}` : "No events yet"}
                  </small>
                </span>
                <span className="cc-zrow-cams" aria-hidden="true">
                  {z.cameras.map((c) => (
                    <i key={c.id} title={c.name} className={c.severe ? "is-severe" : c.alerting ? "is-alerting" : ""} />
                  ))}
                </span>
                <span className="cc-zrow-status">
                  {z.pending ? `${z.pending} to review` : "Clear"}
                </span>
                <span className="cc-zrow-go" aria-hidden="true">→</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
