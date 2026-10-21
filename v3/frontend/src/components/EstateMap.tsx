// The township seen from above: a flat SVG drawn from the same generated layout as the
// Command centre's 3D diorama (town/layout.ts), so roads, houses, the car park, the clubhouse
// pool and the perimeter fence sit where they do in 3D. Zones are highlighted on top, with
// numbered pins (residents) or name labels (staff). Schematic, not surveyed.
import { useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { MapPin } from "lucide-react";
import type { Camera, Location } from "../types";
import {
  buildLayout,
  placeCameras,
  hash,
  HALF,
  SITE,
  CELL,
  C,
  type Place,
  type TownZone,
} from "./town/layout";
import "./EstateMap.css";

type Props = {
  locations: Location[];
  selected?: string;
  /** Makes zones and pins clickable. */
  onSelect?: (id: string) => void;
  /** Staff views: draw camera positions (schematic) in each zone. */
  cameras?: Camera[];
  /** Numbered pins (match a numbered list beside the map) or zone names. */
  labels?: "number" | "name";
  /** Fill the parent's height and centre the crop on the selected zone. */
  fill?: boolean;
  /** Width / height of the map when it does not fill its parent. */
  aspect?: number;
  caption?: boolean;
  className?: string;
};

// The 3D palette is a dusk diorama; the flat map uses daylight tones of the same materials.
const GROUND = "#e3ebd7";
const PLANE_TONE: Record<string, string> = {
  [C.asphalt]: "#d4dae4",
  [C.bay]: "#ffffff",
  [C.paving]: "#ebe5d8",
  [C.plaza]: "#efe8da",
  [C.pool]: "#8fd1ea",
  "#AEB3BE": "#e8ebf1",
};
const BOX_TONE: Record<string, string> = {
  "#C9CED8": "#aab3c2",
  "#EDEFF3": "#ffffff",
  "#C8463F": "#e5534b",
  "#8D95A5": "#c5ccd8",
};
const ROOFS = ["#c8d6f0", "#ebc7ae", "#e8dbbd", "#c9ddbd", "#f2ede4", "#d9cbe6"];
const CARS = ["#5b7cfa", "#f0b04a", "#eef1f6", "#e5534b", "#46536b"];
const LEAVES = ["#a7cf8c", "#93c37d", "#b7d99c", "#8dbd84"];
const DASH = 0.5;

const deg = (rot: number) => (-rot * 180) / Math.PI;
const at = ([x, z, rot]: Place) => `translate(${x} ${z}) rotate(${deg(rot)})`;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function EstateMap({
  locations,
  selected,
  onSelect,
  cameras,
  labels = "number",
  fill = false,
  aspect = 1.1,
  caption = false,
  className = "",
}: Props) {
  const id = "em" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const stageRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  // Numbers follow the order of `locations`, like the zone list beside the map.
  const zones = useMemo(
    () =>
      locations
        .map((l, i) => ({ id: l.id, name: l.name, area: l.map_area ?? [], n: i + 1, pending: 0, severe: false }))
        .filter((z) => z.area.length === 4),
    [locations],
  );
  const zoneKey = zones.map((z) => z.id + z.area.join(",")).join("|");
  const layout = useMemo(() => buildLayout(zones as TownZone[]), [zoneKey]);
  const placed = useMemo(
    () =>
      cameras
        ? placeCameras(
            cameras.map((c) => ({ id: c.id, name: c.name, zoneId: c.location_id ?? "", pending: 0, severe: false })),
            layout.rects,
          )
        : null,
    [cameras, layout],
  );

  useLayoutEffect(() => {
    if (!fill || !stageRef.current) return;
    const el = stageRef.current;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [fill]);

  // Visible window in world units: the full width, cropped top and bottom to the aspect,
  // centred on the selected zone (fill) or on the zones as a whole.
  const ratio = fill && box && box.h > 0 ? box.w / box.h : aspect;
  const vbW = ratio >= 1 ? SITE : SITE * ratio;
  const vbH = ratio >= 1 ? SITE / ratio : SITE;
  const rects = [...layout.rects.values()];
  const focus = (fill && selected && layout.anchors.get(selected)) || {
    x: rects.length ? (Math.min(...rects.map((r) => r.x0)) + Math.max(...rects.map((r) => r.x1))) / 2 : 0,
    z: rects.length ? (Math.min(...rects.map((r) => r.z0)) + Math.max(...rects.map((r) => r.z1))) / 2 : 0,
  };
  const vbX = clamp(focus.x - vbW / 2, -HALF, HALF - vbW);
  const vbY = clamp(focus.z - vbH / 2, -HALF, HALF - vbH);
  const pos = (x: number, z: number) => ({
    left: `${((x - vbX) / vbW) * 100}%`,
    top: `${((z - vbY) / vbH) * 100}%`,
    "--p": clamp(((x - vbX) / vbW) * 100, 0, 100),
  }) as CSSProperties;

  // Road tiles become a carriageway down the middle of each cell, with arms towards the
  // neighbouring road cells, so corners and junctions join up and the verges stay green.
  const cellOf = (v: number) => Math.round((v + HALF) / CELL - 0.5);
  const roadTiles = [...(layout.props.roadStraight ?? []), ...(layout.props.roadSquare ?? [])];
  const roadSet = new Set(roadTiles.map((p) => cellOf(p[0]) + "," + cellOf(p[1])));
  const roads = roadTiles.map((p) => {
    const [i, j] = [cellOf(p[0]), cellOf(p[1])];
    const near = (di: number, dj: number) => roadSet.has(i + di + "," + (j + dj));
    const arms = { e: near(1, 0), w: near(-1, 0), s: near(0, 1), n: near(0, -1) };
    const axis = arms.n && arms.s && !arms.e && !arms.w ? "z" : arms.e && arms.w && !arms.n && !arms.s ? "x" : "";
    return { x: p[0], z: p[1], arms, axis };
  });
  const carriageway = (x: number, z: number, arms: Record<"e" | "w" | "s" | "n", boolean>, w: number) => {
    const h = w / 2;
    const c = CELL / 2 + 0.01;
    return [
      [x - h, z - h, w, w],
      arms.e && [x, z - h, c, w],
      arms.w && [x - c, z - h, c, w],
      arms.s && [x - h, z, w, c],
      arms.n && [x - h, z - c, w, c],
    ].filter(Boolean) as number[][];
  };
  const ROAD = CELL * 0.52;
  const trees = [
    ...(layout.props.treeLarge ?? []).map((p) => ({ p, r: 0.17 * p[3] })),
    ...(layout.props.treeSmall ?? []).map((p) => ({ p, r: 0.12 * p[3] })),
  ];
  const leaf = (p: Place) => LEAVES[hash(`${p[0].toFixed(2)}:${p[1].toFixed(2)}`) % LEAVES.length];
  const byArea = [...zones].sort((a, b) => b.area[2] * b.area[3] - a.area[2] * a.area[3]);
  const sel = selected ? layout.rects.get(selected) : undefined;
  const lit = hover ?? selected;
  const pick = onSelect
    ? (zoneId: string) => () => onSelect(zoneId)
    : undefined;

  return (
    <div
      className={
        "em-map" + (fill ? " is-fill" : "") + (onSelect ? " is-interactive" : "") + (className ? " " + className : "")
      }
    >
      <div
        className="em-stage"
        ref={stageRef}
        style={fill ? undefined : { aspectRatio: String(aspect) }}
        role={onSelect ? "group" : undefined}
        aria-label={onSelect ? "Property zone map" : undefined}
      >
        <svg viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`} preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
          <defs>
            <pattern id={id + "-pavers"} width={0.42} height={0.42} patternUnits="userSpaceOnUse">
              <path d="M0 0H0.42M0 0V0.42" stroke="rgba(120, 104, 80, 0.12)" strokeWidth={0.025} fill="none" />
            </pattern>
            <mask id={id + "-hole"}>
              <rect x={-HALF} y={-HALF} width={SITE} height={SITE} fill="#fff" />
              {sel && <rect x={sel.x0} y={sel.z0} width={sel.w} height={sel.d} rx={0.35} fill="#000" />}
            </mask>
          </defs>
          <rect x={-HALF} y={-HALF} width={SITE} height={SITE} fill={GROUND} />

          {/* Ground plates: car park, bays, paving, plaza, pool deck and pool. */}
          {[...layout.planes]
            .sort((a, b) => a.y - b.y)
            .map((pl, i) => {
              const tone = PLANE_TONE[pl.color] ?? "#e9ecf1";
              const pool = pl.color === C.pool;
              return (
                <g key={"p" + i}>
                  <rect
                    x={pl.x - pl.w / 2}
                    y={pl.z - pl.d / 2}
                    width={pl.w}
                    height={pl.d}
                    rx={pool ? 0.18 : pl.color === C.asphalt || pl.w < 0.1 || pl.d < 0.1 ? 0 : 0.12}
                    fill={tone}
                    stroke={pool ? "#6dbfdc" : undefined}
                    strokeWidth={pool ? 0.05 : undefined}
                  />
                  {(pl.color === C.paving || pl.color === C.plaza) && (
                    <rect x={pl.x - pl.w / 2} y={pl.z - pl.d / 2} width={pl.w} height={pl.d} rx={0.12} fill={`url(#${id}-pavers)`} />
                  )}
                </g>
              );
            })}

          {/* Roads: a pale kerb, the carriageway, then a dashed centre line aligned to the grid. */}
          <g className="em-roads">
            {roads.flatMap(({ x, z, arms }, i) =>
              carriageway(x, z, arms, ROAD + 0.22).map(([rx, ry, rw, rh], k) => (
                <rect key={`k${i}-${k}`} x={rx} y={ry} width={rw} height={rh} fill="#f6f7f2" />
              )),
            )}
            {roads.flatMap(({ x, z, arms }, i) =>
              carriageway(x, z, arms, ROAD).map(([rx, ry, rw, rh], k) => (
                <rect key={`r${i}-${k}`} x={rx} y={ry} width={rw} height={rh} fill="#d2d8e2" />
              )),
            )}
            {roads.map(({ x, z, axis }, i) => {
              if (!axis) return null;
              const start = (axis === "z" ? z : x) - CELL / 2;
              return (
                <line
                  key={"c" + i}
                  x1={axis === "z" ? x : start}
                  y1={axis === "z" ? start : z}
                  x2={axis === "z" ? x : start + CELL}
                  y2={axis === "z" ? start + CELL : z}
                  stroke="#ffffff"
                  strokeWidth={0.07}
                  strokeDasharray={`${DASH * 0.55} ${DASH * 0.45}`}
                  strokeDashoffset={(((start + HALF) % DASH) + DASH) % DASH}
                />
              );
            })}
          </g>

          {/* Soft shadows first, so every roof and canopy sits on the same light. */}
          <g fill="rgba(36, 48, 72, 0.13)">
            {layout.houses.map((h, i) => (
              <rect key={"hs" + i} x={-0.62} y={-0.5} width={1.24} height={1} rx={0.08} transform={`translate(${h.at[0] + 0.12} ${h.at[1] + 0.16}) rotate(${deg(h.at[2])})`} />
            ))}
            {(layout.props.clubhouse ?? []).map((p, i) => (
              <rect key={"cs" + i} x={-1.25} y={-0.85} width={2.5} height={1.7} rx={0.1} transform={`translate(${p[0] + 0.16} ${p[1] + 0.2}) rotate(${deg(p[2])})`} />
            ))}
            {(layout.props.gatehouse ?? []).map((p, i) => (
              <rect key={"gs" + i} x={-0.6} y={-0.55} width={1.2} height={1.1} rx={0.08} transform={`translate(${p[0] + 0.12} ${p[1] + 0.16}) rotate(${deg(p[2])})`} />
            ))}
            {(layout.props.lowBlock ?? []).map((p, i) => (
              <rect key={"ls" + i} x={-0.5} y={-0.75} width={1} height={1.5} rx={0.08} transform={`translate(${p[0] + 0.12} ${p[1] + 0.16}) rotate(${deg(p[2])})`} />
            ))}
            {trees.map(({ p, r }, i) => (
              <circle key={"ts" + i} cx={p[0] + 0.12} cy={p[1] + 0.16} r={r} />
            ))}
          </g>

          {/* Houses: gable roofs, the half facing the road a shade lighter. */}
          {layout.houses.map((h, i) => {
            const roof = ROOFS[h.model % ROOFS.length];
            return (
              <g key={"h" + i} transform={at(h.at)}>
                <rect x={-0.62} y={-0.5} width={1.24} height={1} rx={0.08} fill={roof} />
                <rect x={-0.62} y={-0.5} width={1.24} height={0.5} rx={0.08} fill="rgba(20, 26, 46, 0.09)" />
                <line x1={-0.56} y1={0} x2={0.56} y2={0} stroke="rgba(20, 26, 46, 0.18)" strokeWidth={0.04} />
              </g>
            );
          })}

          {/* Larger buildings: flat roofs with plant on top. */}
          {(layout.props.clubhouse ?? []).map((p, i) => (
            <g key={"c" + i} transform={at(p)}>
              <rect x={-1.25} y={-0.85} width={2.5} height={1.7} rx={0.1} fill="#f8f9fc" stroke="#cdd4e1" strokeWidth={0.04} />
              <rect x={-1.05} y={-0.62} width={1.2} height={1.24} rx={0.06} fill="#e6eaf2" />
              <rect x={0.4} y={-0.5} width={0.55} height={0.36} rx={0.04} fill="#d6dce7" />
              <rect x={0.4} y={0.1} width={0.55} height={0.36} rx={0.04} fill="#d6dce7" />
            </g>
          ))}
          {(layout.props.gatehouse ?? []).map((p, i) => (
            <g key={"g" + i} transform={at(p)}>
              <rect x={-0.6} y={-0.55} width={1.2} height={1.1} rx={0.08} fill="#f8f9fc" stroke="#cdd4e1" strokeWidth={0.04} />
              <rect x={-0.35} y={-0.3} width={0.7} height={0.6} rx={0.05} fill="#e3e8f1" />
            </g>
          ))}
          {(layout.props.lowBlock ?? []).map((p, i) => (
            <g key={"l" + i} transform={at(p)}>
              <rect x={-0.5} y={-0.75} width={1} height={1.5} rx={0.08} fill="#f3f5f9" stroke="#cdd4e1" strokeWidth={0.04} />
              <line x1={0} y1={-0.6} x2={0} y2={0.6} stroke="#dde2eb" strokeWidth={0.05} />
            </g>
          ))}
          {(layout.props.planter ?? []).map((p, i) => (
            <g key={"pl" + i} transform={at(p)}>
              <rect x={-0.28} y={-0.28} width={0.56} height={0.56} rx={0.08} fill="#ddd2bf" />
              <circle r={0.18} fill="#9cc788" />
            </g>
          ))}

          {/* Boom gate and stairs. */}
          {[...layout.boxes]
            .sort((a, b) => a.y + a.h - (b.y + b.h))
            .map((b, i) => (
              <rect key={"b" + i} x={b.x - b.w / 2} y={b.z - b.d / 2} width={b.w} height={b.d} fill={BOX_TONE[b.color] ?? "#c5ccd8"} />
            ))}

          {/* Parked cars, nose-in. */}
          {layout.cars.map((c, i) => (
            <g key={"car" + i} transform={at(c.at)}>
              <rect x={-0.2} y={-0.37} width={0.4} height={0.74} rx={0.11} fill={CARS[c.model % CARS.length]} stroke="rgba(20, 26, 46, 0.18)" strokeWidth={0.03} />
              <rect x={-0.15} y={0.06} width={0.3} height={0.17} rx={0.04} fill="rgba(20, 26, 46, 0.42)" />
              <rect x={-0.15} y={-0.27} width={0.3} height={0.12} rx={0.04} fill="rgba(20, 26, 46, 0.3)" />
            </g>
          ))}

          {/* Perimeter fence: a rail with posts. */}
          {(layout.props.fence ?? []).map((p, i) => {
            const half = (1.68 * p[3]) / 2;
            return (
              <g key={"f" + i} transform={at(p)}>
                <line x1={-half} y1={0} x2={half} y2={0} stroke="#97a1b3" strokeWidth={0.05} />
                <line x1={-half} y1={0} x2={half} y2={0} stroke="#7d879a" strokeWidth={0.13} strokeDasharray="0.07 0.35" />
              </g>
            );
          })}

          {/* Tree canopies with a lit edge. */}
          {trees.map(({ p, r }, i) => (
            <g key={"t" + i}>
              <circle cx={p[0]} cy={p[1]} r={r} fill={leaf(p)} />
              <circle cx={p[0] - r * 0.28} cy={p[1] - r * 0.3} r={r * 0.5} fill="rgba(255, 255, 255, 0.22)" />
            </g>
          ))}

          {/* Zones: largest first, so a smaller zone inside a larger one stays clickable. */}
          {byArea.map((z) => {
            const r = layout.rects.get(z.id)!;
            return (
              <rect
                key={z.id}
                className={"em-zone" + (z.id === selected ? " is-selected" : z.id === lit ? " is-hover" : "")}
                x={r.x0}
                y={r.z0}
                width={r.w}
                height={r.d}
                rx={0.35}
                onClick={pick?.(z.id)}
                onPointerEnter={() => setHover(z.id)}
                onPointerLeave={() => setHover(null)}
              />
            );
          })}
          {sel && (
            <rect key={selected} className="em-dim" x={-HALF} y={-HALF} width={SITE} height={SITE} mask={`url(#${id}-hole)`} />
          )}

          {placed &&
            cameras!.map((camera) => {
              const c = placed.get(camera.id);
              if (!c) return null;
              const look = Math.atan2(c.tz - c.z, c.tx - c.x);
              const here = camera.location_id === selected;
              return (
                <g key={camera.id} className={"em-camera" + (here ? " is-here" : "")}>
                  <path
                    d={`M${c.x} ${c.z} L${c.x + Math.cos(look - 0.42) * 1.1} ${c.z + Math.sin(look - 0.42) * 1.1} A1.1 1.1 0 0 1 ${c.x + Math.cos(look + 0.42) * 1.1} ${c.z + Math.sin(look + 0.42) * 1.1} Z`}
                  />
                  <circle cx={c.x} cy={c.z} r={0.2} />
                </g>
              );
            })}
        </svg>

        <div className="em-overlay">
          {zones.map((z) => {
            const a = layout.anchors.get(z.id)!;
            const isSel = z.id === selected;
            const cls =
              (labels === "number" ? "em-pin" : "em-label") +
              (isSel ? " is-selected" : z.id === hover ? " is-hover" : "");
            const body =
              labels === "number" ? (
                <b>{z.n}</b>
              ) : (
                <>
                  {isSel && <MapPin size={13} strokeWidth={2.4} aria-hidden="true" />}
                  {z.name}
                </>
              );
            return onSelect ? (
              <button
                key={z.id}
                type="button"
                className={cls}
                style={pos(a.x, a.z)}
                aria-label={`${z.n}. ${z.name}`}
                aria-pressed={isSel}
                onClick={() => onSelect(z.id)}
                onPointerEnter={() => setHover(z.id)}
                onPointerLeave={() => setHover(null)}
              >
                {body}
              </button>
            ) : (
              <span key={z.id} className={cls} style={pos(a.x, a.z)} aria-hidden={!isSel}>
                {body}
              </span>
            );
          })}
          <span className="em-compass" aria-hidden="true">
            N
          </span>
        </div>
      </div>
      {caption && (
        <div className="em-caption">
          <MapPin size={12} /> Schematic property map
          <span>Zone locations only</span>
        </div>
      )}
    </div>
  );
}
