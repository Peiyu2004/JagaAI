/**
 * Site layout for the township, shared by the 3D diorama (TownScene) and the flat 2D map
 * (SiteMap). Pure geometry from the zones' map_area: no three.js, so the 2D map stays light.
 * World units: the slab spans -HALF..HALF on x and z; z grows towards the bottom of the map.
 */

export type TownZone = {
  id: string;
  name: string;
  /** location.map_area: [x, y, width, height] in percent of the site. */
  area: number[];
  /** Pending alerts in this zone. */
  pending: number;
  /** True when any pending alert here is high or urgent. */
  severe: boolean;
};

export type TownCamera = {
  id: string;
  name: string;
  zoneId: string;
  pending: number;
  severe: boolean;
};

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

export const SITE = 24; // world units across the slab
export const HALF = SITE / 2;
export const N = 14; // layout grid cells per side: fewer, chunkier pieces read as a diorama
export const CELL = SITE / N; // ~1.71 world units
export const K = CELL / 1.2; // model scale factor relative to the original 1.2-unit cell
export const PCT = 100 / N; // percent per cell
export const S = SITE / 100; // world units per percent

export const C = {
  slabSide: "#3B3442",
  soil: "#6B4E3B",
  rock: "#2E2A35",
  ground: "#5C7744",
  asphalt: "#2C2E35",
  bay: "#E9E6DF",
  paving: "#9C9486",
  plaza: "#B9B0A1",
  pool: "#2FA4C7",
  pole: "#9AA1AE",
  body: "#E8EBF0",
  led: "#FF3B30",
  tint: "#FFF7EE",
  window: "#FFB866",
  lamp: "#FFD9A0",
  ai: "#F5B544",
  severe: "#F97066",
  white: "#EDEDEF",
};

export const MODEL_ROOT = "/models/town/";
export const HOUSES = ["a", "b", "c", "d", "e", "f", "h", "j", "k", "l", "o", "s"].map(
  (k) => `suburban/building-type-${k}.glb`,
);
export const CARS = ["sedan", "suv", "van", "hatchback-sports", "sedan-sports"].map((k) => `cars/${k}.glb`);
export const PROPS = {
  treeLarge: "suburban/tree-large.glb",
  treeSmall: "suburban/tree-small.glb",
  fence: "suburban/fence-1x4.glb",
  planter: "suburban/planter.glb",
  gatehouse: "commercial/building-c.glb",
  clubhouse: "commercial/building-n.glb",
  lowBlock: "commercial/building-e.glb",
  roadStraight: "roads/road-straight.glb",
  roadSquare: "roads/road-square.glb",
} as const;
export type PropKey = keyof typeof PROPS;
export const MODEL_URLS = [...HOUSES, ...CARS, ...Object.values(PROPS)].map((p) => MODEL_ROOT + p);

/* ------------------------------------------------------------------ */
/* Deterministic randomness                                            */
/* ------------------------------------------------------------------ */

export function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function rng(seed: number) {
  let a = seed || 1;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

export type Rect = { x0: number; z0: number; x1: number; z1: number; cx: number; cz: number; w: number; d: number };
export type ZoneKind = "parking" | "gate" | "club" | "perimeter" | "other";
/** One instance: position, rotation about Y, uniform scale. */
export type Place = [x: number, z: number, rot: number, scale: number];
export type Plane = { x: number; z: number; w: number; d: number; y: number; color: string; rot?: number };
export type Box = { x: number; y: number; z: number; w: number; h: number; d: number; color: string };
export type Layout = {
  rects: Map<string, Rect>;
  houses: { model: number; lit: boolean; at: Place }[];
  props: Partial<Record<PropKey, Place[]>>;
  lit: Partial<Record<PropKey, boolean>>;
  cars: { model: number; at: Place }[];
  planes: Plane[];
  boxes: Box[];
  lamps: { x: number; z: number }[];
  /** Label point per zone: the middle of the ground it owns, off the roads. */
  anchors: Map<string, { x: number; z: number }>;
};

export function zoneRect(area: number[]): Rect {
  const [x = 0, y = 0, w = 10, h = 10] = area;
  const x0 = (x - 50) * S;
  const z0 = (y - 50) * S;
  const ww = Math.max(1, w * S);
  const dd = Math.max(1, h * S);
  return { x0, z0, x1: x0 + ww, z1: z0 + dd, cx: x0 + ww / 2, cz: z0 + dd / 2, w: ww, d: dd };
}

export function zoneKind(name: string): ZoneKind {
  const n = name.toLowerCase();
  if (/park|car|lot/.test(n)) return "parking";
  if (/gate|guard|entrance/.test(n)) return "gate";
  if (/club|hall|community|pool/.test(n)) return "club";
  if (/perimeter|walk|path|fence|stair|court/.test(n)) return "perimeter";
  return "other";
}

export const cellX = (i: number) => -HALF + (i + 0.5) * CELL;
export const key = (i: number, j: number) => j * N + i;

export function buildLayout(zones: TownZone[]): Layout {
  const rects = new Map<string, Rect>();
  for (const zone of zones) rects.set(zone.id, zoneRect(zone.area));

  // Cell ownership: a cell belongs to the smallest zone containing its centre.
  const owner = new Map<number, TownZone>();
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const px = (i + 0.5) * PCT;
      const py = (j + 0.5) * PCT;
      let best: TownZone | undefined;
      let bestArea = Infinity;
      for (const zone of zones) {
        const [x = 0, y = 0, w = 0, h = 0] = zone.area;
        if (px >= x && px <= x + w && py >= y && py <= y + h && w * h < bestArea) {
          best = zone;
          bestArea = w * h;
        }
      }
      if (best) owner.set(key(i, j), best);
    }
  }

  // Roads: ring just inside the edge, one cross street on the least-blocked row,
  // and a road through each gate zone down to that street.
  const road = new Set<number>();
  for (let k = 1; k <= N - 2; k++) {
    road.add(key(1, k));
    road.add(key(N - 2, k));
    road.add(key(k, 1));
    road.add(key(k, N - 2));
  }
  let street = Math.floor(N / 2);
  let bestCover = Infinity;
  for (let j = 4; j <= N - 5; j++) {
    let cover = 0;
    for (let i = 2; i <= N - 3; i++) if (owner.has(key(i, j))) cover++;
    const score = cover * 10 + Math.abs(j - N / 2);
    if (score < bestCover) {
      bestCover = score;
      street = j;
    }
  }
  for (let i = 1; i <= N - 2; i++) road.add(key(i, street));
  const gates = zones.filter((z) => zoneKind(z.name) === "gate");
  const spines = gates.length
    ? gates.map((g) => Math.min(N - 3, Math.max(2, Math.floor((g.area[0] + g.area[2] / 2) / PCT))))
    : [];
  for (const [g, col] of gates.map((g, n) => [g, spines[n]] as const)) {
    const mid = (g.area[1] + g.area[3] / 2) / PCT;
    const [from, to] = mid < street ? [1, street] : [street, N - 2];
    for (let j = from; j <= to; j++) road.add(key(col, j));
  }

  const out: Layout = { rects, houses: [], props: {}, lit: {}, cars: [], planes: [], boxes: [], lamps: [], anchors: new Map() };
  const prop = (k: PropKey, at: Place) => (out.props[k] ??= []).push(at);
  const isRoad = (i: number, j: number) => i >= 0 && j >= 0 && i < N && j < N && road.has(key(i, j));

  // Road tiles: straights along their axis, plain squares at corners and junctions.
  for (const k of road) {
    const i = k % N;
    const j = Math.floor(k / N);
    const ns = isRoad(i, j - 1) || isRoad(i, j + 1);
    const ew = isRoad(i - 1, j) || isRoad(i + 1, j);
    if (ns && !ew) prop("roadStraight", [cellX(i), cellX(j), 0, 1]);
    else if (ew && !ns) prop("roadStraight", [cellX(i), cellX(j), Math.PI / 2, 1]);
    else prop("roadSquare", [cellX(i), cellX(j), 0, 1]);
  }

  // Street lamps on every fourth straight road cell, on a side without road.
  const roadList = [...road].sort((a, b) => a - b);
  let lampTick = 0;
  for (const k of roadList) {
    if (out.lamps.length >= 12) break;
    const i = k % N;
    const j = Math.floor(k / N);
    const ns = isRoad(i, j - 1) && isRoad(i, j + 1) && !isRoad(i - 1, j) && !isRoad(i + 1, j);
    const ew = isRoad(i - 1, j) && isRoad(i + 1, j) && !isRoad(i, j - 1) && !isRoad(i, j + 1);
    if (!ns && !ew) continue;
    if (lampTick++ % 4 !== 2) continue;
    const side = (i + j) % 2 ? 1 : -1;
    out.lamps.push(
      ns
        ? { x: cellX(i) + side * CELL * 0.47, z: cellX(j) }
        : { x: cellX(i), z: cellX(j) + side * CELL * 0.47 },
    );
  }

  // Filler: terrace houses facing the road, greenery behind, breathing room.
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      if (road.has(key(i, j)) || owner.has(key(i, j))) continue;
      const rand = rng(hash(`cell:${i}:${j}`));
      const x = cellX(i);
      const z = cellX(j);
      const edge = i === 0 || j === 0 || i === N - 1 || j === N - 1;
      if (edge) {
        if (rand() < 0.7) prop(rand() < 0.5 ? "treeLarge" : "treeSmall", [x + (rand() - 0.5) * 0.6, z + (rand() - 0.5) * 0.6, rand() * 6, (1.5 + rand() * 0.5) * K]);
        continue;
      }
      const dirs: [number, number][] = [
        [0, 1],
        [0, -1],
        [1, 0],
        [-1, 0],
      ];
      const face = dirs.find(([dx, dz]) => isRoad(i + dx, j + dz));
      if (face && rand() > 0.12) {
        out.houses.push({
          model: Math.floor(rand() * HOUSES.length),
          lit: rand() < 0.5,
          at: [x - face[0] * 0.06, z - face[1] * 0.06, Math.atan2(face[0], face[1]), 0.9 * K],
        });
        continue;
      }
      const roll = rand();
      if (roll < 0.72) {
        prop("treeLarge", [x + (rand() - 0.5) * 0.5, z + (rand() - 0.5) * 0.5, rand() * 6, (1.6 + rand() * 0.4) * K]);
        if (rand() < 0.5) prop("treeSmall", [x + (rand() - 0.5) * 0.9, z + (rand() - 0.5) * 0.9, rand() * 6, 1.6 * K]);
      } else if (roll < 0.68) {
        prop("planter", [x, z, Math.floor(rand() * 4) * (Math.PI / 2), 1.6 * K]);
      }
    }
  }

  // Zone contents.
  for (const zone of zones) {
    const r = rects.get(zone.id)!;
    const kind = zoneKind(zone.name);
    const rand = rng(hash(zone.id + zone.name));
    const cells: [number, number][] = [];
    for (const [k, z] of owner) if (z === zone && !road.has(k)) cells.push([k % N, Math.floor(k / N)]);
    out.anchors.set(
      zone.id,
      cells.length
        ? {
            x: cells.reduce((sum, [i]) => sum + cellX(i), 0) / cells.length,
            z: cells.reduce((sum, [, j]) => sum + cellX(j), 0) / cells.length,
          }
        : { x: r.cx, z: r.cz },
    );

    if (kind === "parking") {
      for (const [i, j] of cells) {
        const x = cellX(i);
        const z = cellX(j);
        out.planes.push({ x, z, w: CELL, d: CELL, y: 0.011, color: C.asphalt });
        // Two bays per cell, cars nose-in along Z.
        for (const side of [-1, 0, 1]) {
          out.planes.push({ x: x + side * CELL * 0.5, z, w: 0.025, d: CELL * 0.62, y: 0.016, color: C.bay });
        }
        for (const side of [-0.25, 0.25]) {
          if (rand() < 0.62) {
            out.cars.push({
              model: Math.floor(rand() * CARS.length),
              at: [x + side * CELL, z + (rand() - 0.5) * 0.08, rand() < 0.5 ? 0 : Math.PI, 0.2 * K],
            });
          }
        }
      }
      const corners: [number, number][] = [
        [r.x0 + 0.25, r.z1 - 0.25],
        [r.x1 - 0.25, r.z1 - 0.25],
        [r.x0 + 0.25, r.z0 + 0.35],
      ];
      for (const [x, z] of corners) prop("treeLarge", [x, z, rand() * 6, 1.7 * K]);
      continue;
    }

    if (kind === "gate") {
      const col = Math.min(N - 3, Math.max(2, Math.floor((zone.area[0] + zone.area[2] / 2) / PCT)));
      const midRow = Math.floor((zone.area[1] + zone.area[3] / 2) / PCT);
      const rx = cellX(col);
      const gz = cellX(midRow);
      out.planes.push({ x: r.cx, z: r.cz, w: r.w - 0.2, d: r.d - 0.2, y: 0.006, color: C.paving });
      prop("gatehouse", [rx + CELL, gz, -Math.PI / 2, 0.95 * K]);
      // Boom gate: post on the east kerb, arm across the carriageway.
      out.boxes.push({ x: rx + CELL * 0.44, y: 0.2, z: gz + 0.32, w: 0.08, h: 0.4, d: 0.08, color: "#C9CED8" });
      out.boxes.push({ x: rx, y: 0.36, z: gz + 0.32, w: CELL * 0.86, h: 0.035, d: 0.035, color: "#EDEFF3" });
      for (let b = 0; b < 4; b++) {
        out.boxes.push({ x: rx - CELL * 0.33 + b * CELL * 0.22, y: 0.36, z: gz + 0.32, w: 0.09, h: 0.04, d: 0.04, color: "#C8463F" });
      }
      for (const [i, j] of cells) {
        if (Math.abs(i - col) <= 1) continue;
        if (rand() < 0.55) prop("treeLarge", [cellX(i) + (rand() - 0.5) * 0.6, cellX(j) + (rand() - 0.5) * 0.6, rand() * 6, 1.7 * K]);
        else if (rand() < 0.4) prop("planter", [cellX(i), cellX(j), 0, 1.6 * K]);
      }
      continue;
    }

    if (kind === "club") {
      out.planes.push({ x: r.cx, z: r.cz, w: r.w - 0.2, d: r.d - 0.2, y: 0.006, color: C.plaza });
      const bx = r.x0 + r.w * 0.32;
      const bz = r.z0 + r.d * 0.4;
      prop("clubhouse", [bx, bz, 0, 0.9 * K]);
      const pw = Math.min(2.2, r.w * 0.36);
      const pd = Math.min(1.5, r.d * 0.24);
      const px = r.x1 - pw / 2 - 0.45;
      const pz = r.z1 - pd / 2 - 0.55;
      out.planes.push({ x: px, z: pz, w: pw + 0.4, d: pd + 0.4, y: 0.02, color: "#AEB3BE" });
      out.planes.push({ x: px, z: pz, w: pw, d: pd, y: 0.03, color: C.pool });
      for (let t = 0; t < 4; t++) prop("treeLarge", [r.x0 + 0.4 + rand() * (r.w - 0.8), r.z1 - 0.35, rand() * 6, 1.6 * K]);
      continue;
    }

    if (kind === "perimeter") {
      out.planes.push({ x: r.cx, z: r.cz, w: 0.55, d: r.d - 0.2, y: 0.012, color: C.paving });
      const fenceLen = 1.68 * 0.9 * K;
      for (let z = r.z0 + fenceLen / 2; z < r.z1; z += fenceLen) prop("fence", [r.x1 - 0.15, z, Math.PI / 2, 0.9 * K]);
      for (let z = r.z0 + 0.5; z < r.z1 - 0.2; z += 1.7) prop("treeLarge", [r.x0 + 0.35, z, rand() * 6, 1.6 * K]);
      const blocks = r.d > 8 ? 2 : 1;
      for (let b = 0; b < blocks; b++) {
        const bz = r.z0 + r.d * (0.35 + b * 0.38);
        const bx = r.cx + r.w * 0.18;
        prop("lowBlock", [bx, bz, -Math.PI / 2, 0.8 * K]);
        for (let s = 0; s < 3; s++) {
          out.boxes.push({ x: bx - 0.75 - s * 0.14, y: 0.05 + s * 0.05, z: bz, w: 0.14, h: 0.1 + s * 0.1, d: 0.5, color: "#8D95A5" });
        }
      }
      continue;
    }

    // Other zones: a few houses on their cells.
    for (const [i, j] of cells) {
      if (rand() < 0.45) out.houses.push({ model: Math.floor(rand() * HOUSES.length), lit: rand() < 0.5, at: [cellX(i), cellX(j), 0, 0.9 * K] });
    }
  }

  out.lit = { gatehouse: true, clubhouse: true, lowBlock: false };
  return out;
}

/** Deterministic camera positions inside their zone (schematic, not surveyed). */
export function placeCameras(cameras: TownCamera[], rects: Map<string, Rect>) {
  const byZone = new Map<string, TownCamera[]>();
  for (const camera of cameras) {
    const list = byZone.get(camera.zoneId) ?? [];
    list.push(camera);
    byZone.set(camera.zoneId, list);
  }
  const placed = new Map<string, { x: number; z: number; tx: number; tz: number }>();
  for (const [zoneId, list] of byZone) {
    const r = rects.get(zoneId);
    if (!r) continue;
    const offset = (hash(zoneId) % 360) * (Math.PI / 180);
    list.forEach((camera, i) => {
      const angle = offset + (i / list.length) * Math.PI * 2;
      const x = r.cx + Math.cos(angle) * r.w * 0.38;
      const z = r.cz + Math.sin(angle) * r.d * 0.38;
      placed.set(camera.id, { x, z, tx: r.cx, tz: r.cz });
    });
  }
  return placed;
}
