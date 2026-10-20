/**
 * JagaAI — 3D township, "blue hour" miniature.
 *
 * A schematic diorama generated from the site's zone layout (location.map_area), built
 * from Kenney CC0 models (public/models/town, see License.txt per pack) and lit by a local
 * Poly Haven CC0 HDRI (public/hdri). Building, tree and camera positions are generated,
 * not surveyed; the HUD labels the scene "schematic". Nothing is loaded from a CDN.
 *
 * Performance: the canvas renders on demand. It animates (~30 fps) only while there are
 * pending alerts to pulse, during a fly-to, while the user drags, and while the contact
 * shadows bake once after load. It requests the low-power GPU so local AI keeps the fast one.
 *
 * Dependencies: three, @react-three/fiber (v9), @react-three/drei (v10),
 * @react-three/postprocessing (v3) + postprocessing.
 */
import {
  Component,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import {
  AccumulativeShadows,
  ContactShadows,
  Environment,
  Html,
  OrbitControls,
  RandomizedLight,
  RoundedBox,
  useGLTF,
  useProgress,
} from "@react-three/drei";
import {
  Bloom,
  BrightnessContrast,
  EffectComposer,
  HueSaturation,
  N8AO,
  SMAA,
  TiltShift2,
  ToneMapping,
  Vignette,
} from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";
import "./TownScene.css";

/* ------------------------------------------------------------------ */
/* Public types (unchanged)                                            */
/* ------------------------------------------------------------------ */

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

export type TownSceneProps = {
  zones: TownZone[];
  cameras: TownCamera[];
  /** Camera to fly to (for example the active alert's camera). null = overview. */
  focusCameraId: string | null;
  /** Camera whose evidence card is open. */
  selectedCameraId: string | null;
  /** Zone highlighted from outside (hovering a queue row). */
  highlightZoneId: string | null;
  onHoverZone: (zoneId: string | null) => void;
  onSelectZone: (zoneId: string) => void;
  onSelectCamera: (cameraId: string) => void;
  onOverview: () => void;
  /** Renders the glass evidence card anchored to the selected camera. */
  renderCard?: (cameraId: string) => ReactNode;
  /** Shown if WebGL fails at runtime. */
  fallback: ReactNode;
  reducedMotion?: boolean;
  className?: string;
};

/** Check before mounting the scene; mount the 2D map when this is false. */
export function canUseWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return !!(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const SITE = 24; // world units across the slab
const HALF = SITE / 2;
const N = 14; // layout grid cells per side: fewer, chunkier pieces read as a diorama
const CELL = SITE / N; // ~1.71 world units
const K = CELL / 1.2; // model scale factor relative to the original 1.2-unit cell
const PCT = 100 / N; // percent per cell
const S = SITE / 100; // world units per percent

const C = {
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

const VIEW = {
  fov: 24,
  azimuth: Math.PI / 4, // 45°: the square site reads as a wide diamond that fills the panel
  polar: 0.98, // radians from vertical (~34° below horizontal): a slightly lower, more cinematic angle
  margin: 0.96, // fit inside 96% of the view
};

const MODEL_ROOT = "/models/town/";
const HOUSES = ["a", "b", "c", "d", "e", "f", "h", "j", "k", "l", "o", "s"].map(
  (k) => `suburban/building-type-${k}.glb`,
);
const CARS = ["sedan", "suv", "van", "hatchback-sports", "sedan-sports"].map((k) => `cars/${k}.glb`);
const PROPS = {
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
type PropKey = keyof typeof PROPS;
const MODEL_URLS = [...HOUSES, ...CARS, ...Object.values(PROPS)].map((p) => MODEL_ROOT + p);
const HDRI = "/hdri/modern_evening_street_1k.hdr";

/* ------------------------------------------------------------------ */
/* Deterministic randomness                                            */
/* ------------------------------------------------------------------ */

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed: number) {
  let a = seed || 1;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Night factor 0 (day) … 1 (night) from the local hour. */
function nightFactor(date = new Date()): number {
  const h = date.getHours() + date.getMinutes() / 60;
  if (h >= 20 || h < 5.5) return 1;
  if (h >= 7.5 && h < 17.5) return 0;
  if (h < 7.5) return 1 - (h - 5.5) / 2; // dawn
  return (h - 17.5) / 2.5; // dusk
}

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

type Rect = { x0: number; z0: number; x1: number; z1: number; cx: number; cz: number; w: number; d: number };
type ZoneKind = "parking" | "gate" | "club" | "perimeter" | "other";
/** One instance: position, rotation about Y, uniform scale. */
type Place = [x: number, z: number, rot: number, scale: number];
type Plane = { x: number; z: number; w: number; d: number; y: number; color: string; rot?: number };
type Box = { x: number; y: number; z: number; w: number; h: number; d: number; color: string };
type Layout = {
  rects: Map<string, Rect>;
  houses: { model: number; lit: boolean; at: Place }[];
  props: Partial<Record<PropKey, Place[]>>;
  lit: Partial<Record<PropKey, boolean>>;
  cars: { model: number; at: Place }[];
  planes: Plane[];
  boxes: Box[];
  lamps: { x: number; z: number }[];
};

function zoneRect(area: number[]): Rect {
  const [x = 0, y = 0, w = 10, h = 10] = area;
  const x0 = (x - 50) * S;
  const z0 = (y - 50) * S;
  const ww = Math.max(1, w * S);
  const dd = Math.max(1, h * S);
  return { x0, z0, x1: x0 + ww, z1: z0 + dd, cx: x0 + ww / 2, cz: z0 + dd / 2, w: ww, d: dd };
}

function zoneKind(name: string): ZoneKind {
  const n = name.toLowerCase();
  if (/park|car|lot/.test(n)) return "parking";
  if (/gate|guard|entrance/.test(n)) return "gate";
  if (/club|hall|community|pool/.test(n)) return "club";
  if (/perimeter|walk|path|fence|stair|court/.test(n)) return "perimeter";
  return "other";
}

const cellX = (i: number) => -HALF + (i + 0.5) * CELL;
const key = (i: number, j: number) => j * N + i;

function buildLayout(zones: TownZone[]): Layout {
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

  const out: Layout = { rects, houses: [], props: {}, lit: {}, cars: [], planes: [], boxes: [], lamps: [] };
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
function placeCameras(cameras: TownCamera[], rects: Map<string, Rect>) {
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

/* ------------------------------------------------------------------ */
/* Textures                                                            */
/* ------------------------------------------------------------------ */

function canvasTexture(size: number, draw: (ctx: CanvasRenderingContext2D, s: number) => void, color = false) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) draw(ctx, size);
  const texture = new THREE.CanvasTexture(canvas);
  if (color) texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Vertical alpha ramp: opaque at the bottom of the texture (v = 0), clear at the top. */
function useFadeTexture(invert = false) {
  const texture = useMemo(
    () =>
      canvasTexture(64, (ctx, s) => {
        const g = ctx.createLinearGradient(0, 0, 0, s);
        g.addColorStop(0, invert ? "#fff" : "#000");
        g.addColorStop(1, invert ? "#000" : "#fff");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, s, s);
      }),
    [invert],
  );
  useEffect(() => () => texture.dispose(), [texture]);
  return texture;
}

/** Window glass mask for the Kenney Suburban/Commercial colormap (light-blue swatch column). */
function windowMask() {
  const texture = canvasTexture(512, (ctx) => {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, 512, 512);
    ctx.fillStyle = "#fff";
    ctx.fillRect(352, 128, 32, 128);
  });
  texture.flipY = false; // glTF UV convention
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  return texture;
}

/* ------------------------------------------------------------------ */
/* Model kit: one merged geometry per GLB, shared tinted materials       */
/* ------------------------------------------------------------------ */

type Proto = { geometry: THREE.BufferGeometry; pack: string };
type Kit = {
  houses: Proto[];
  cars: Proto[];
  props: Record<PropKey, Proto>;
  material: (pack: string, lit: boolean) => THREE.MeshStandardMaterial;
  dispose: () => void;
};

function mergeScene(scene: THREE.Object3D): THREE.BufferGeometry {
  scene.updateMatrixWorld(true);
  const parts: THREE.BufferGeometry[] = [];
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const g = mesh.geometry.clone();
    for (const name of Object.keys(g.attributes)) {
      if (!["position", "normal", "uv"].includes(name)) g.deleteAttribute(name);
    }
    g.applyMatrix4(mesh.matrixWorld);
    parts.push(g);
  });
  const merged = mergeGeometries(parts, false) ?? parts[0];
  parts.forEach((p) => p !== merged && p.dispose());
  // Centre on X/Z and stand on y = 0.
  merged.computeBoundingBox();
  const b = merged.boundingBox!;
  merged.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2);
  merged.computeBoundingSphere();
  return merged;
}

function useKit(night: number): Kit {
  const gltfs = useGLTF(MODEL_URLS, false, false);
  const kit = useMemo((): Kit => {
    const byUrl = new Map(MODEL_URLS.map((url, i) => [url, gltfs[i]]));
    const maps = new Map<string, THREE.Texture | null>();
    const proto = (path: string): Proto => {
      const gltf = byUrl.get(MODEL_ROOT + path)!;
      const pack = path.split("/")[0];
      if (!maps.has(pack)) {
        let map: THREE.Texture | null = null;
        gltf.scene.traverse((o) => {
          const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
          if (!map && m?.map) map = m.map;
        });
        maps.set(pack, map);
      }
      return { geometry: mergeScene(gltf.scene), pack };
    };
    const props = Object.fromEntries(
      (Object.keys(PROPS) as PropKey[]).map((k) => [k, proto(PROPS[k])]),
    ) as Record<PropKey, Proto>;
    const mask = windowMask();
    const materials = new Map<string, THREE.MeshStandardMaterial>();
    const material = (pack: string, lit: boolean) => {
      const id = `${pack}:${lit}`;
      let m = materials.get(id);
      if (!m) {
        const glows = lit && (pack === "suburban" || pack === "commercial");
        m = new THREE.MeshStandardMaterial({
          map: maps.get(pack) ?? null,
          color: C.tint,
          roughness: pack === "roads" ? 0.95 : 0.85,
          metalness: 0,
          emissive: glows ? new THREE.Color(C.window) : new THREE.Color("#000"),
          emissiveMap: glows ? mask : null,
          emissiveIntensity: 0,
        });
        materials.set(id, m);
      }
      return m;
    };
    return {
      houses: HOUSES.map(proto),
      cars: CARS.map(proto),
      props,
      material,
      dispose: () => {
        mask.dispose();
        materials.forEach((m) => m.dispose());
      },
    };
  }, [gltfs]);
  useEffect(() => () => kit.dispose(), [kit]);
  // Lit windows follow the local clock: warm glow at night, off by day.
  useEffect(() => {
    for (const pack of ["suburban", "commercial"]) kit.material(pack, true).emissiveIntensity = 0; // daylight scene: windows don't glow
  }, [kit, night]);
  return kit;
}

/* ------------------------------------------------------------------ */
/* Scene pieces                                                        */
/* ------------------------------------------------------------------ */

function Instances({
  geometry,
  material,
  items,
  shadows = true,
}: {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  items: Place[];
  shadows?: boolean;
}) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    items.forEach(([x, z, rot, s], i) => {
      q.setFromAxisAngle(up, rot);
      m.compose(new THREE.Vector3(x, 0, z), q, new THREE.Vector3(s, s, s));
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [items]);
  if (!items.length) return null;
  return (
    <instancedMesh
      key={items.length}
      ref={ref}
      args={[geometry, material, items.length]}
      castShadow={shadows}
      receiveShadow
    />
  );
}

function Town({ layout, kit }: { layout: Layout; kit: Kit }) {
  const houseGroups = useMemo(() => {
    const groups = new Map<string, { model: number; lit: boolean; items: Place[] }>();
    for (const h of layout.houses) {
      const id = `${h.model}:${h.lit}`;
      const g = groups.get(id) ?? { model: h.model, lit: h.lit, items: [] };
      g.items.push(h.at);
      groups.set(id, g);
    }
    return [...groups.values()];
  }, [layout]);
  const carGroups = useMemo(() => {
    const groups: Place[][] = CARS.map(() => []);
    for (const c of layout.cars) groups[c.model].push(c.at);
    return groups;
  }, [layout]);
  const planeMaterials = useMemo(() => {
    const map = new Map<string, THREE.MeshStandardMaterial>();
    for (const p of layout.planes) {
      if (map.has(p.color)) continue;
      const water = p.color === C.pool;
      map.set(
        p.color,
        new THREE.MeshStandardMaterial({
          color: p.color,
          roughness: water ? 0.1 : 0.95,
          metalness: 0,
          emissive: water ? new THREE.Color("#1B7EA0") : new THREE.Color("#000"),
          emissiveIntensity: water ? 0.55 : 0,
        }),
      );
    }
    return map;
  }, [layout]);
  useEffect(() => () => planeMaterials.forEach((m) => m.dispose()), [planeMaterials]);
  const propItems = useMemo(() => {
    const g = kit.props.roadSquare.geometry;
    g.computeBoundingBox();
    const b = g.boundingBox!;
    const tile = Math.max(b.max.x - b.min.x, b.max.z - b.min.z) || 1;
    const roadScale = (CELL / tile) * 1.002; // a hair over, so seams never show
    const out: Partial<Record<PropKey, Place[]>> = {};
    for (const k of Object.keys(layout.props) as PropKey[]) {
      const items = layout.props[k]!;
      out[k] = k === "roadStraight" || k === "roadSquare" ? items.map(([x, z, r]) => [x, z, r, roadScale] as Place) : items;
    }
    return out;
  }, [kit, layout]);

  return (
    <group>
      {houseGroups.map((g) => (
        <Instances
          key={`h${g.model}${g.lit}`}
          geometry={kit.houses[g.model].geometry}
          material={kit.material("suburban", g.lit)}
          items={g.items}
        />
      ))}
      {carGroups.map((items, i) => (
        <Instances key={`c${i}`} geometry={kit.cars[i].geometry} material={kit.material("cars", false)} items={items} />
      ))}
      {(Object.keys(layout.props) as PropKey[]).map((k) => (
        <Instances
          key={k}
          geometry={kit.props[k].geometry}
          material={kit.material(kit.props[k].pack, !!layout.lit[k])}
          items={propItems[k]!}
          shadows={k !== "roadStraight" && k !== "roadSquare"}
        />
      ))}
      {layout.planes.map((p, i) => (
        <mesh key={`p${i}`} position={[p.x, p.y, p.z]} rotation={[-Math.PI / 2, 0, p.rot ?? 0]} receiveShadow material={planeMaterials.get(p.color)}>
          <planeGeometry args={[p.w, p.d]} />
        </mesh>
      ))}
      {layout.boxes.map((b, i) => (
        <mesh key={`b${i}`} position={[b.x, b.y, b.z]} castShadow receiveShadow>
          <boxGeometry args={[b.w, b.h, b.d]} />
          <meshStandardMaterial color={b.color} roughness={0.85} />
        </mesh>
      ))}
      <Lamps lamps={layout.lamps} />
    </group>
  );
}

function Lamps({ lamps }: { lamps: { x: number; z: number }[] }) {
  const pool = useMemo(
    () =>
      canvasTexture(128, (ctx, s) => {
        const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
        g.addColorStop(0, "rgba(255,255,255,0.9)");
        g.addColorStop(0.45, "rgba(255,255,255,0.28)");
        g.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, s, s);
      }),
    [],
  );
  useEffect(() => () => pool.dispose(), [pool]);
  return (
    <group>
      {lamps.map((l, i) => (
        <group key={i} position={[l.x, 0, l.z]} scale={K}>
          <mesh position={[0, 0.36, 0]} castShadow>
            <cylinderGeometry args={[0.018, 0.024, 0.72, 6]} />
            <meshStandardMaterial color="#5B6170" roughness={0.6} />
          </mesh>
          <mesh position={[0, 0.735, 0]}>
            <boxGeometry args={[0.07, 0.03, 0.07]} />
            <meshBasicMaterial color={new THREE.Color(C.lamp).multiplyScalar(2.2)} toneMapped={false} />
          </mesh>
          <mesh position={[0, 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[1.1, 1.1]} />
            <meshBasicMaterial
              map={pool}
              color={C.window}
              transparent
              opacity={0.06}
              depthWrite={false}
              blending={THREE.AdditiveBlending}
            />
          </mesh>
        </group>
      ))}
    </group>
  );
}

function Slab() {
  // Mottled lawn: a few greens in soft blotches, so the ground reads as grass, not a grey plate.
  const lawn = useMemo(() => {
    const t = canvasTexture(
      512,
      (ctx, s) => {
        ctx.fillStyle = "#6E9A4F";
        ctx.fillRect(0, 0, s, s);
        const rand = rng(31);
        const greens = ["#669448", "#78A856", "#5E8A42", "#83B05E", "#6E9A4F"];
        for (let i = 0; i < 1400; i++) {
          const x = rand() * s;
          const y = rand() * s;
          const r = 3 + rand() * 16;
          const g = ctx.createRadialGradient(x, y, 0, x, y, r);
          const c = greens[Math.floor(rand() * greens.length)];
          g.addColorStop(0, c + "AA");
          g.addColorStop(1, c + "00");
          ctx.fillStyle = g;
          ctx.fillRect(x - r, y - r, r * 2, r * 2);
        }
      },
      true,
    );
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(3, 3);
    t.anisotropy = 4;
    return t;
  }, []);
  const groundRough = useMemo(() => {
    const t = canvasTexture(256, (ctx, s) => {
      const img = ctx.createImageData(s, s);
      const rand = rng(77);
      for (let i = 0; i < img.data.length; i += 4) {
        const v = 200 + Math.floor(rand() * 55);
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
    });
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(6, 6);
    return t;
  }, []);
  useEffect(
    () => () => {
      lawn.dispose();
      groundRough.dispose();
    },
    [lawn, groundRough],
  );
  return (
    <group>
      {/* Diorama strata: a grass lip, a band of soil, then rock tapering in underneath. */}
      <RoundedBox args={[SITE, 0.5, SITE]} radius={0.14} smoothness={4} position={[0, -0.25, 0]} receiveShadow>
        <meshStandardMaterial color={C.soil} roughness={0.95} />
      </RoundedBox>
      <RoundedBox args={[SITE - 0.5, 0.9, SITE - 0.5]} radius={0.3} smoothness={4} position={[0, -0.92, 0]} receiveShadow>
        <meshStandardMaterial color={C.rock} roughness={0.9} />
      </RoundedBox>
      <RoundedBox args={[SITE - 1.6, 0.5, SITE - 1.6]} radius={0.3} smoothness={4} position={[0, -1.45, 0]}>
        <meshStandardMaterial color={C.slabSide} roughness={0.9} />
      </RoundedBox>
      <mesh position={[0, 0.003, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[SITE - 0.12, SITE - 0.12]} />
        <meshStandardMaterial map={lawn} color="#FFFFFF" roughness={0.95} roughnessMap={groundRough} />
      </mesh>
      <ContactShadows position={[0, -1.8, 0]} scale={SITE * 1.5} blur={3} far={4} opacity={0.32} frames={1} color="#1A2340" />
    </group>
  );
}

function ZonePad({
  zone,
  rect,
  highlighted,
  onHover,
  onSelect,
  portal,
}: {
  zone: TownZone;
  rect: Rect;
  highlighted: boolean;
  onHover: (id: string | null) => void;
  onSelect: (id: string) => void;
  portal: RefObject<HTMLElement>;
}) {
  const tint = zone.pending ? C.ai : "#FFFFFF";
  const outline = useMemo(() => {
    const pts = [
      new THREE.Vector3(rect.x0, 0, rect.z0),
      new THREE.Vector3(rect.x1, 0, rect.z0),
      new THREE.Vector3(rect.x1, 0, rect.z1),
      new THREE.Vector3(rect.x0, 0, rect.z1),
      new THREE.Vector3(rect.x0, 0, rect.z0),
    ];
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    const line = new THREE.Line(g, new THREE.LineDashedMaterial({ color: tint, dashSize: 0.25, gapSize: 0.18, transparent: true, opacity: 0.35 }));
    line.computeLineDistances();
    line.position.y = 0.05;
    return line;
  }, [rect, tint]);
  useEffect(
    () => () => {
      outline.geometry.dispose();
      (outline.material as THREE.Material).dispose();
    },
    [outline],
  );
  return (
    <group>
      <mesh
        position={[rect.cx, 0.045, rect.cz]}
        rotation={[-Math.PI / 2, 0, 0]}
        onPointerOver={(e: ThreeEvent<PointerEvent>) => {
          e.stopPropagation();
          onHover(zone.id);
          document.body.style.cursor = "pointer";
        }}
        onPointerOut={() => {
          onHover(null);
          document.body.style.cursor = "";
        }}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          onSelect(zone.id);
        }}
      >
        <planeGeometry args={[rect.w, rect.d]} />
        <meshBasicMaterial
          color={tint}
          transparent
          opacity={highlighted ? (zone.pending ? 0.06 : 0.04) : 0}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      {highlighted && <primitive object={outline} />}
      {highlighted && (
        <Html
          position={[rect.x0 + 0.15, 0.08, rect.z0 + 0.15]}
          zIndexRange={[10, 0]}
          pointerEvents="none"
          portal={portal}
          style={{ pointerEvents: "none" }}
        >
          <span className={"town-zone-label" + (zone.pending ? " is-alert" : "") + (zone.severe ? " is-severe" : "")}>
            {zone.name}
            {zone.pending ? ` · ${zone.pending}` : ""}
          </span>
        </Html>
      )}
    </group>
  );
}

const HEAD_Y = 1.02;
const BEAM_H = 3.2;

function CameraRig({
  camera,
  at,
  active,
  animate,
  onSelect,
  portal,
  fade,
  coneFade,
  pin,
}: {
  pin: { label: string; count: number; severe: boolean; lift: number } | null;
  camera: TownCamera;
  at: { x: number; z: number; tx: number; tz: number };
  active: boolean;
  animate: boolean;
  onSelect: (id: string) => void;
  portal: RefObject<HTMLElement>;
  fade: THREE.Texture;
  coneFade: THREE.Texture;
}) {
  const head = useRef<THREE.Group>(null);
  const pulse = useRef<THREE.Group>(null);
  const [hover, setHover] = useState(false);
  const alerting = camera.pending > 0;
  const tone = camera.severe ? C.severe : C.ai;

  const cone = useMemo(() => {
    const g = new THREE.ConeGeometry(0.9, 2.2, 24, 1, true);
    g.translate(0, -1.1, 0); // tip at the origin, opening downwards along -Y
    g.rotateX(-Math.PI / 2); // opening forward along +Z
    return g;
  }, []);
  useEffect(() => () => cone.dispose(), [cone]);

  useLayoutEffect(() => {
    head.current?.lookAt(at.tx, 0.2, at.tz);
  }, [at.tx, at.tz]);

  useFrame(({ clock }) => {
    const p = pulse.current;
    if (!p) return;
    if (!animate) {
      p.scale.setScalar(1);
      return;
    }
    const t = (clock.getElapsedTime() % 2.4) / 2.4;
    p.scale.setScalar(1 + t * 0.8);
    p.children.forEach((c, i) => {
      const m = (c as THREE.Mesh).material as THREE.MeshBasicMaterial;
      m.opacity = (i === 0 ? 0.6 : 0.08) * (1 - t);
    });
  });

  const select = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    onSelect(camera.id);
  };
  const over = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    setHover(true);
    document.body.style.cursor = "pointer";
  };
  const out = () => {
    setHover(false);
    document.body.style.cursor = "";
  };
  const showCone = hover || active;

  return (
    <group position={[at.x, 0, at.z]}>
      {/* pole + bracket */}
      <mesh position={[0, HEAD_Y / 2, 0]} castShadow onClick={select} onPointerOver={over} onPointerOut={out}>
        <cylinderGeometry args={[0.022, 0.03, HEAD_Y, 8]} />
        <meshStandardMaterial color={C.pole} roughness={0.55} metalness={0.2} />
      </mesh>
      {/* invisible, wider hit target */}
      <mesh position={[0, HEAD_Y / 2, 0]} visible={false} onClick={select} onPointerOver={over} onPointerOut={out}>
        <cylinderGeometry args={[0.16, 0.16, HEAD_Y + 0.3, 6]} />
      </mesh>
      <group ref={head} position={[0, HEAD_Y, 0]}>
        <mesh position={[0, 0.03, 0.05]} castShadow>
          <boxGeometry args={[0.04, 0.04, 0.1]} />
          <meshStandardMaterial color={C.pole} roughness={0.55} />
        </mesh>
        <mesh position={[0, 0.0, 0.14]} rotation={[Math.PI / 2 + 0.25, 0, 0]} castShadow onClick={select} onPointerOver={over} onPointerOut={out}>
          <capsuleGeometry args={[0.045, 0.13, 4, 10]} />
          <meshStandardMaterial color={C.body} roughness={0.45} />
        </mesh>
        <mesh position={[0, 0.035, 0.1]}>
          <sphereGeometry args={[0.012, 8, 8]} />
          <meshBasicMaterial color={new THREE.Color(C.led).multiplyScalar(2)} toneMapped={false} />
        </mesh>
        {showCone && (
          <mesh geometry={cone} position={[0, 0, 0.18]} rotation={[0.28, 0, 0]}>
            <meshBasicMaterial
              color={alerting ? tone : C.white}
              alphaMap={coneFade}
              transparent
              opacity={0.18}
              depthWrite={false}
              side={THREE.DoubleSide}
              toneMapped={false}
            />
          </mesh>
        )}
      </group>

      {alerting && (
        <>
          {/* beam: thin core + soft glow, fading out at the top */}
          <mesh position={[0, HEAD_Y + BEAM_H / 2, 0]} onClick={select} onPointerOver={over} onPointerOut={out}>
            <cylinderGeometry args={[0.025, 0.025, BEAM_H, 8, 1, true]} />
            <meshBasicMaterial color={tone} alphaMap={fade} transparent opacity={0.95} depthWrite={false} toneMapped={false} />
          </mesh>
          <mesh position={[0, HEAD_Y + BEAM_H / 2, 0]}>
            <cylinderGeometry args={[0.14, 0.14, BEAM_H, 16, 1, true]} />
            <meshBasicMaterial color={tone} alphaMap={fade} transparent opacity={0.16} depthWrite={false} toneMapped={false} />
          </mesh>
          {/* ground marker */}
          <group ref={pulse} position={[0, 0.04, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <mesh>
              <ringGeometry args={[0.6, 0.7, 48]} />
              <meshBasicMaterial color={tone} transparent opacity={0.6} depthWrite={false} toneMapped={false} />
            </mesh>
            <mesh>
              <circleGeometry args={[0.7, 48]} />
              <meshBasicMaterial color={tone} transparent opacity={0.08} depthWrite={false} toneMapped={false} />
            </mesh>
          </group>
          {(pin || active) && (
            <Html position={[0, HEAD_Y + BEAM_H + 0.05 + (pin?.lift ?? 0), 0]} center zIndexRange={[20, 0]} portal={portal}>
              <button
                type="button"
                className={"town-pin" + ((pin ? pin.severe : camera.severe) ? " is-severe" : "") + (active ? " is-active" : "")}
                onClick={() => onSelect(camera.id)}
                aria-label={`${pin ? pin.label : camera.name}: ${pin ? pin.count : camera.pending} pending alert${(pin ? pin.count : camera.pending) === 1 ? "" : "s"}`}
              >
                <b>{pin ? pin.count : camera.pending}</b>
                <span>{pin ? pin.label : camera.severe ? "High" : "Alert"}</span>
              </button>
            </Html>
          )}
        </>
      )}

      {(hover || active) && !alerting && (
        <Html
          position={[0, HEAD_Y + 0.35, 0]}
          center
          zIndexRange={[20, 0]}
          pointerEvents="none"
          portal={portal}
          style={{ pointerEvents: "none" }}
        >
          <span className="town-zone-label">{camera.name}</span>
        </Html>
      )}
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Framing, fly-to, rendering cadence                                  */
/* ------------------------------------------------------------------ */

const SLAB_CORNERS = [-HALF, HALF].flatMap((x) =>
  [-1.7, 2.4].flatMap((y) => [-HALF, HALF].map((z) => new THREE.Vector3(x, y, z))),
);

function viewDirection(azimuth = VIEW.azimuth, polar = VIEW.polar) {
  return new THREE.Vector3(Math.sin(polar) * Math.sin(azimuth), Math.cos(polar), Math.sin(polar) * Math.cos(azimuth));
}

/**
 * Distance at which the whole slab fits inside the area above the bottom HUD with an 8% margin.
 * The camera renders through a view offset so that area is centred; see useFraming.
 */
function fitDistance(width: number, height: number, hud: number, right = 0) {
  const virtualH = height + hud;
  const virtualW = width + right;
  const cam = new THREE.PerspectiveCamera(VIEW.fov, virtualW / virtualH, 0.1, 500);
  const yLimit = (VIEW.margin * (height - hud)) / virtualH;
  const xLimit = (VIEW.margin * (width - right)) / virtualW;
  const dir = viewDirection();
  const fits = (d: number) => {
    cam.position.copy(dir).multiplyScalar(d);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();
    cam.updateProjectionMatrix();
    return SLAB_CORNERS.every((c) => {
      const p = c.clone().project(cam);
      return Math.abs(p.x) <= xLimit && Math.abs(p.y) <= yLimit;
    });
  };
  let lo = 10;
  let hi = 400;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

type Controls = { target: THREE.Vector3; update: () => void; minDistance: number; maxDistance: number };

/**
 * The host page can cover the bottom (--town-hud-bottom) and the right side (--town-hud-right)
 * with HUD panels. The camera renders through a view offset so the slab is centred and fitted
 * in the area that stays visible.
 */
function useFraming(hud: number, right: number) {
  const { camera, size, invalidate, scene } = useThree();
  const distance = useMemo(
    () => fitDistance(size.width, size.height, hud, right),
    [size.width, size.height, hud, right],
  );
  // Fog scales with the framing distance: the slab stays clear, only the far edge and beyond fade.
  useLayoutEffect(() => {
    scene.fog = new THREE.Fog("#E9F0FA", distance * 1.15, distance * 2.2);
    invalidate();
  }, [scene, distance, invalidate]);
  useLayoutEffect(() => {
    const cam = camera as THREE.PerspectiveCamera;
    cam.fov = VIEW.fov;
    cam.setViewOffset(size.width + right, size.height + hud, right, hud, size.width, size.height);
    cam.updateProjectionMatrix();
    invalidate();
  }, [camera, size.width, size.height, hud, right, invalidate]);
  return distance;
}

/** Smooth fly-to of camera + orbit target (0.9 s, ease-out cubic). */
function FlyTo({
  target,
  distance,
  reducedMotion,
}: {
  target: THREE.Vector3 | null;
  distance: number;
  reducedMotion: boolean;
}) {
  const { camera, invalidate } = useThree();
  const controls = useThree((s) => s.controls) as unknown as Controls | null;
  const tween = useRef<{ t: number; fromPos: THREE.Vector3; toPos: THREE.Vector3; fromTarget: THREE.Vector3; toTarget: THREE.Vector3 } | null>(null);
  const key = target ? `${target.x.toFixed(2)},${target.z.toFixed(2)}` : "overview";
  const lastKey = useRef<string | null>(null);

  useEffect(() => {
    if (!controls) return;
    // Only a changed target (a user action) animates. First placement and re-fits jump.
    const animate = lastKey.current !== null && lastKey.current !== key && !reducedMotion;
    lastKey.current = key;
    controls.minDistance = distance * 0.45;
    controls.maxDistance = distance * 1.15;
    const toTarget = target ? target.clone() : new THREE.Vector3(0, 0, 0);
    let toPos: THREE.Vector3;
    if (target) {
      const dir = camera.position.clone().sub(controls.target).normalize();
      if (dir.y < 0.2) dir.copy(viewDirection());
      toPos = toTarget.clone().add(dir.multiplyScalar(distance * 0.45));
    } else {
      toPos = viewDirection().multiplyScalar(distance);
    }
    if (!animate) {
      tween.current = null;
      camera.position.copy(toPos);
      controls.target.copy(toTarget);
      controls.update();
      invalidate();
      return;
    }
    tween.current = { t: 0, fromPos: camera.position.clone(), toPos, fromTarget: controls.target.clone(), toTarget };
    invalidate();
    // key captures the target value; the vector itself changes identity every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, controls, reducedMotion, distance]);

  useFrame((_, delta) => {
    const tw = tween.current;
    if (!tw || !controls) return;
    tw.t = Math.min(1, tw.t + delta / 0.9);
    const e = 1 - Math.pow(1 - tw.t, 3);
    camera.position.lerpVectors(tw.fromPos, tw.toPos, e);
    controls.target.lerpVectors(tw.fromTarget, tw.toTarget, e);
    controls.update();
    if (tw.t >= 1) tween.current = null;
    else invalidate();
  });
  return null;
}

/** Drives ~30 fps rendering only while something needs to animate; paused when hidden. */
function Ticker({ active }: { active: boolean }) {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    if (!active) return;
    let id = 0;
    const start = () => {
      window.clearInterval(id);
      if (!document.hidden) id = window.setInterval(() => invalidate(), 1000 / 30);
    };
    start();
    document.addEventListener("visibilitychange", start);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", start);
    };
  }, [active, invalidate]);
  return null;
}

/** Positions the DOM evidence card next to the selected camera, clamped inside the panel. */
function CardTracker({
  anchor,
  card,
  hud,
  right,
}: {
  anchor: THREE.Vector3 | null;
  card: RefObject<HTMLDivElement | null>;
  hud: number;
  right: number;
}) {
  const { camera, size } = useThree();
  const v = useMemo(() => new THREE.Vector3(), []);
  useFrame(() => {
    const el = card.current;
    if (!el || !anchor) return;
    v.copy(anchor).project(camera);
    const ax = ((v.x + 1) / 2) * size.width;
    const ay = ((1 - v.y) / 2) * size.height;
    const w = el.offsetWidth || 300;
    const h = el.offsetHeight || 340;
    const pad = 12;
    const maxX = size.width - right - pad; // never under the host's right-hand panel
    let left = ax + 24;
    if (left + w > maxX) left = ax - 24 - w; // flip to the camera's left
    left = Math.min(Math.max(pad, left), maxX - w);
    const top = Math.min(Math.max(pad + 44, ay - h * 0.35), size.height - hud - h - pad);
    el.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(Math.max(pad, top))}px, 0)`;
    el.style.visibility = "visible";
  });
  return null;
}

/** Daylight: a high warm-white sun with soft shadows, a bright sky fill and a gentle cool rim. */
const SUN: [number, number, number] = [-14, 20, 10];
function Lights() {
  return (
    <>
      <hemisphereLight args={["#D6E6FF", "#7C8B5A", 0.95]} />
      <directionalLight position={SUN} intensity={2.4} color="#FFF0DC" />
      <directionalLight position={[15, 10, -13]} intensity={0.45} color="#BFD3FF" />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Error boundary → 2D fallback                                        */
/* ------------------------------------------------------------------ */

class SceneBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function LoadingOverlay() {
  const { active, progress } = useProgress();
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!active && progress >= 100) {
      const id = window.setTimeout(() => setDone(true), 250);
      return () => window.clearTimeout(id);
    }
    setDone(false);
  }, [active, progress]);
  if (done) return null;
  return (
    <div className={"town-loading" + (!active && progress >= 100 ? " is-done" : "")} role="status">
      <span>Loading site model</span>
      <i style={{ transform: `scaleX(${Math.max(0.04, progress / 100)})` }} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Scene content (inside Canvas, suspends while models load)            */
/* ------------------------------------------------------------------ */

function SiteContent({
  zones,
  cameras,
  focusCameraId,
  selectedCameraId,
  highlightZoneId,
  hoverZone,
  onHoverZone,
  onSelectZone,
  onSelectCamera,
  reducedMotion,
  portal,
  hud,
  hudRight,
  card,
  night,
}: {
  zones: TownZone[];
  cameras: TownCamera[];
  focusCameraId: string | null;
  selectedCameraId: string | null;
  highlightZoneId: string | null;
  hoverZone: string | null;
  onHoverZone: (zoneId: string | null) => void;
  onSelectZone: (zoneId: string) => void;
  onSelectCamera: (cameraId: string) => void;
  reducedMotion: boolean;
  portal: RefObject<HTMLElement>;
  hud: number;
  hudRight: number;
  card: RefObject<HTMLDivElement | null>;
  night: number;
}) {
  const kit = useKit(night);
  const zoneKey = zones.map((z) => `${z.id}:${z.name}:${z.area.join(",")}`).join("|");
  // Geometry depends only on the zone layout, not on alert counts.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const layout = useMemo(() => buildLayout(zones), [zoneKey]);
  const placed = useMemo(() => placeCameras(cameras, layout.rects), [cameras, layout]);
  const fade = useFadeTexture(true);
  const coneFade = useFadeTexture(false);
  const distance = useFraming(hud, hudRight);

  const focus = focusCameraId ? placed.get(focusCameraId) : undefined;
  const focusTarget = focus ? new THREE.Vector3(focus.x, 0, focus.z) : null;
  const selected = selectedCameraId ? placed.get(selectedCameraId) : undefined;
  const anchor = selected ? new THREE.Vector3(selected.x, HEAD_Y + 0.4, selected.z) : null;
  const anyAlerts = cameras.some((c) => c.pending > 0);
  // Every alerting camera shows its own pin. Pins of neighbouring cameras in the same zone
  // are lifted to different heights so they never sit on top of each other.
  const pins = useMemo(() => {
    const out = new Map<string, { label: string; count: number; severe: boolean; lift: number }>();
    for (const zone of zones) {
      const alerting = cameras
        .filter((c) => c.zoneId === zone.id && c.pending > 0)
        .sort((a, b) => Number(b.severe) - Number(a.severe) || b.pending - a.pending);
      alerting.forEach((c, i) => {
        const name = c.name.replace(/^Demo\s*·\s*/i, "");
        out.set(c.id, { label: name, count: c.pending, severe: c.severe, lift: (i % 3) * 1.15 });
      });
    }
    return out;
  }, [zones, cameras]);

  return (
    <>
      <Environment files={HDRI} environmentIntensity={0.6} />
      <Slab />
      <Town layout={layout} kit={kit} />
      <AccumulativeShadows
        key={zoneKey}
        temporal
        frames={80}
        alphaTest={0.75}
        scale={30}
        color="#33405E"
        opacity={0.6}
        position={[0, 0.026, 0]}
      >
        <RandomizedLight amount={8} radius={4} position={SUN} />
      </AccumulativeShadows>
      {zones.map((zone) => {
        const rect = layout.rects.get(zone.id);
        return rect ? (
          <ZonePad
            key={zone.id}
            zone={zone}
            rect={rect}
            highlighted={highlightZoneId === zone.id || hoverZone === zone.id}
            onHover={onHoverZone}
            onSelect={onSelectZone}
            portal={portal}
          />
        ) : null;
      })}
      {cameras.map((camera) => {
        const at = placed.get(camera.id);
        return at ? (
          <CameraRig
            key={camera.id}
            camera={camera}
            at={at}
            active={camera.id === selectedCameraId || camera.id === focusCameraId}
            animate={!reducedMotion}
            onSelect={onSelectCamera}
            portal={portal}
            fade={fade}
            coneFade={coneFade}
            pin={pins.get(camera.id) ?? null}
          />
        ) : null;
      })}
      <FlyTo target={focusTarget} distance={distance} reducedMotion={reducedMotion} />
      <CardTracker anchor={anchor} card={card} hud={hud} right={hudRight} />
      <Ticker active={anyAlerts && !reducedMotion} />
    </>
  );
}

/** Post stack. Tone mapping (ACES filmic) runs here, so the renderer itself stays linear (flat). */
function Post({ tiltShift }: { tiltShift: boolean }) {
  return tiltShift ? (
    <EffectComposer multisampling={0} enableNormalPass={false}>
      <N8AO aoRadius={0.9} intensity={2.2} distanceFalloff={0.6} quality="medium" halfRes />
      <Bloom mipmapBlur luminanceThreshold={0.92} luminanceSmoothing={0.2} intensity={0.3} />
      <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      <HueSaturation saturation={0.12} />
      <BrightnessContrast brightness={0.03} contrast={0.06} />
      <TiltShift2 blur={0.1} />
      <Vignette darkness={0.18} offset={0.4} />
      <SMAA />
    </EffectComposer>
  ) : (
    <EffectComposer multisampling={0} enableNormalPass={false}>
      <N8AO aoRadius={0.9} intensity={2.2} distanceFalloff={0.6} quality="medium" halfRes />
      <Bloom mipmapBlur luminanceThreshold={0.92} luminanceSmoothing={0.2} intensity={0.3} />
      <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      <HueSaturation saturation={0.12} />
      <BrightnessContrast brightness={0.03} contrast={0.06} />
      <Vignette darkness={0.18} offset={0.4} />
      <SMAA />
    </EffectComposer>
  );
}

/* ------------------------------------------------------------------ */
/* Main component                                                      */
/* ------------------------------------------------------------------ */

export default function TownScene({
  zones,
  cameras,
  focusCameraId,
  selectedCameraId,
  highlightZoneId,
  onHoverZone,
  onSelectZone,
  onSelectCamera,
  onOverview,
  renderCard,
  fallback,
  reducedMotion = false,
  className,
}: TownSceneProps) {
  const [night, setNight] = useState(() => nightFactor());
  const [hoverZone, setHoverZone] = useState<string | null>(null);
  const [hud, setHud] = useState(0);
  const [hudRight, setHudRight] = useState(0);
  // Stable mount point for every <Html> overlay (drei's Html target must not change after mount).
  const overlay = useRef<HTMLDivElement>(null!);
  const root = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const id = window.setInterval(() => setNight(nightFactor()), 5 * 60 * 1000);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => () => {
    document.body.style.cursor = "";
  }, []);
  // The host page may overlay a HUD strip at the bottom (--town-hud-bottom); keep the slab above it.
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const read = () => {
      const cs = getComputedStyle(el);
      setHud(parseFloat(cs.getPropertyValue("--town-hud-bottom")) || 0);
      setHudRight(parseFloat(cs.getPropertyValue("--town-hud-right")) || 0);
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const hoverZoneHandler = useMemo(
    () => (id: string | null) => {
      setHoverZone(id);
      onHoverZone(id);
    },
    [onHoverZone],
  );

  return (
    <div ref={root} className={"town" + (className ? " " + className : "")}>
      <SceneBoundary fallback={fallback}>
        <Canvas
          frameloop="demand"
          dpr={[1, 1.5]}
          flat
          shadows="percentage"
          camera={{ position: viewDirection().multiplyScalar(60).toArray(), fov: VIEW.fov, near: 0.5, far: 300, manual: true }}
          gl={{
            antialias: false,
            alpha: true,
            powerPreference: "low-power",
            stencil: false,
            outputColorSpace: THREE.SRGBColorSpace,
          }}
          onCreated={({ gl }) => gl.setClearColor(0x000000, 0)}
          aria-label="Schematic 3D map of the site. Use the review queue for keyboard access."
        >
          <Lights />
          <Suspense fallback={null}>
            <SiteContent
              zones={zones}
              cameras={cameras}
              focusCameraId={focusCameraId}
              selectedCameraId={selectedCameraId}
              highlightZoneId={highlightZoneId}
              hoverZone={hoverZone}
              onHoverZone={hoverZoneHandler}
              onSelectZone={onSelectZone}
              onSelectCamera={onSelectCamera}
              reducedMotion={reducedMotion}
              portal={overlay}
              hud={hud}
              hudRight={hudRight}
              card={card}
              night={night}
            />
            <Post tiltShift={!reducedMotion} />
          </Suspense>
          <OrbitControls
            makeDefault
            enablePan={false}
            enableDamping
            dampingFactor={0.08}
            minPolarAngle={0.6}
            maxPolarAngle={1.05}
            minAzimuthAngle={VIEW.azimuth - 0.5}
            maxAzimuthAngle={VIEW.azimuth + 0.5}
          />
        </Canvas>
      </SceneBoundary>
      {/* Zero-size anchor at the canvas origin; Html overlays position themselves from here. */}
      <div ref={overlay} style={{ position: "absolute", top: 0, left: 0, width: 0, height: 0 }} />
      {selectedCameraId && renderCard && (
        <div ref={card} className="town-card" style={{ visibility: "hidden" }}>
          {renderCard(selectedCameraId)}
        </div>
      )}
      <div className="town-hud">
        <span className="town-tag">
          Serenia City · Schematic · {zones.length} zones · {cameras.length} cameras
        </span>
        {focusCameraId && !selectedCameraId && (
          <button type="button" className="town-overview" onClick={onOverview}>
            Overview
          </button>
        )}
      </div>
      <LoadingOverlay />
    </div>
  );
}
