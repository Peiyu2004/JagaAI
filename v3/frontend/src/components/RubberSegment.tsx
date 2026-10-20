// RubberSegment: a segmented switch whose thumb stretches toward the next option,
// lands with a small squash, and can be dragged or flicked.
// TypeScript port of React Bits "RubberSegment" without the motion/react dependency:
// two edge values are animated by a tiny spring/tween engine and drawn as a clip-path.
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import "./RubberSegment.css";

export type SegmentItem<V extends string = string> = {
  value: V;
  label: ReactNode;
  icon?: ReactNode;
  /** Small number shown after the label, e.g. how many alerts are in a status. */
  count?: number | string;
  title?: string;
  /** Tabs mode: id of the panel this tab controls. */
  controls?: string;
};

type Props<V extends string> = {
  items: (V | SegmentItem<V>)[];
  value?: V;
  defaultValue?: V;
  onChange?: (value: V, index: number) => void;
  size?: "sm" | "md" | "lg";
  radius?: number;
  inset?: number;
  equalSlots?: boolean;
  /** 0–100: how far the thumb reaches toward the target before landing. */
  stretch?: number;
  /** Pixels the trailing edge overshoots on landing. */
  squash?: number;
  speed?: number;
  /** 0–100: how far a flick carries the thumb. */
  glide?: number;
  draggable?: boolean;
  disabled?: boolean;
  /** Fill the container width (equal columns). Useful on phones. */
  block?: boolean;
  /** "tabs" when the switch shows/hides panels, "radio" when it picks a value. */
  semantics?: "tabs" | "radio";
  className?: string;
  style?: CSSProperties;
  "aria-label"?: string;
};

type Slot = { l: number; r: number };
type Drag = {
  id: number;
  x0: number;
  slot: number;
  onThumb: boolean;
  live: boolean;
  offset: number;
  w: number;
  hist: [number, number][];
};

const EASE_OUT = cubicBezier(0.23, 1, 0.32, 1);
const DILATE = 0.19;
const HANDOFF = 0.15;
const FLICK = 110;
const MAX_VELOCITY = 2000;
const DEADZONE = 4;
const SLOP = 10;
const RUBBER = 0.55;
const SIZES = {
  sm: { height: 32, font: 12.5, pad: 12, min: 40 },
  md: { height: 38, font: 13, pad: 16, min: 48 },
  lg: { height: 46, font: 14, pad: 20, min: 56 },
};

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const rubber = (over: number, dim: number) => (over * dim * RUBBER) / (dim + RUBBER * Math.abs(over));
const project = (v: number, glide: number) => {
  const d = 1 - 0.1 * Math.pow(0.05, glide / 100);
  return ((v / 1000) * d) / (1 - d);
};
const velocityOf = (hist: [number, number][], now: number) => {
  const recent = hist.filter(([t]) => now - t <= 100);
  if (recent.length < 2) return 0;
  const [t0, x0] = recent[0];
  const [t1, x1] = recent[recent.length - 1];
  return t1 - t0 >= 8 ? ((x1 - x0) / (t1 - t0)) * 1000 : 0;
};
const nearestSlot = (slots: Slot[], x: number) => {
  let best = 0;
  for (let i = 1; i < slots.length; i++) {
    const mid = (slots[i].l + slots[i].r) / 2;
    const bestMid = (slots[best].l + slots[best].r) / 2;
    if (Math.abs(mid - x) < Math.abs(bestMid - x)) best = i;
  }
  return best;
};

function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number) => ((ay * t + by) * t + cy) * t;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 22; i++) {
      const mid = (lo + hi) / 2;
      if (sx(mid) < x) lo = mid;
      else hi = mid;
    }
    return sy((lo + hi) / 2);
  };
}

/** One animated edge of the thumb, in px from the left of the track's inner box. */
class Edge {
  private x = 0;
  private v = 0;
  private raf = 0;
  private token = 0;
  private lastSet = 0;
  private pending: ((done: boolean) => void) | null = null;
  private readonly paint: () => void;

  constructor(paint: () => void) {
    this.paint = paint;
  }

  get() {
    return this.x;
  }

  velocity() {
    return this.v;
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.token += 1;
    const resolve = this.pending;
    this.pending = null;
    resolve?.(false);
  }

  jump(x: number) {
    this.stop();
    this.x = x;
    this.v = 0;
    this.paint();
  }

  /** Direct placement while dragging; tracks velocity for the hand-off. */
  set(x: number) {
    this.stop();
    const now = performance.now();
    const dt = (now - this.lastSet) / 1000;
    this.v = dt > 0 && dt < 0.1 ? (x - this.x) / dt : 0;
    this.lastSet = now;
    this.x = x;
    this.paint();
  }

  spring(to: number, duration: number, bounce: number, velocity = this.v) {
    this.stop();
    const token = this.token;
    const zeta = clamp(1 - bounce, 0.1, 1);
    const omega = 6.5 / (Math.max(0.04, duration) * zeta);
    const k = omega * omega;
    const c = 2 * zeta * omega;
    this.v = velocity;
    return new Promise<boolean>((resolve) => {
      this.pending = resolve;
      let last = performance.now();
      const step = (now: number) => {
        if (token !== this.token) return;
        let dt = Math.min(0.064, (now - last) / 1000);
        last = now;
        while (dt > 0) {
          const h = Math.min(dt, 1 / 240);
          this.v += (-k * (this.x - to) - c * this.v) * h;
          this.x += this.v * h;
          dt -= h;
        }
        if (Math.abs(this.x - to) < 0.25 && Math.abs(this.v) < 6) {
          this.x = to;
          this.v = 0;
          this.raf = 0;
          this.pending = null;
          this.paint();
          resolve(true);
          return;
        }
        this.paint();
        this.raf = requestAnimationFrame(step);
      };
      this.raf = requestAnimationFrame(step);
    });
  }

  tween(to: number, duration: number, ease: (t: number) => number) {
    this.stop();
    const token = this.token;
    const from = this.x;
    const start = performance.now();
    const ms = Math.max(1, duration * 1000);
    return new Promise<boolean>((resolve) => {
      this.pending = resolve;
      let prevX = from;
      let prevT = start;
      const step = (now: number) => {
        if (token !== this.token) return;
        const p = Math.min(1, (now - start) / ms);
        const x = from + (to - from) * ease(p);
        const dt = (now - prevT) / 1000;
        if (dt > 0) this.v = (x - prevX) / dt;
        prevX = x;
        prevT = now;
        this.x = x;
        this.paint();
        if (p >= 1) {
          this.v = 0;
          this.raf = 0;
          this.pending = null;
          resolve(true);
          return;
        }
        this.raf = requestAnimationFrame(step);
      };
      this.raf = requestAnimationFrame(step);
    });
  }
}

function useReducedMotion() {
  const query = "(prefers-reduced-motion: reduce)";
  const [reduce, setReduce] = useState(
    () => typeof window !== "undefined" && !!window.matchMedia?.(query).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const on = () => setReduce(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduce;
}

export default function RubberSegment<V extends string>({
  items,
  value,
  defaultValue,
  onChange,
  size = "md",
  radius = 12,
  inset = 4,
  equalSlots = true,
  stretch = 100,
  squash = 3,
  speed = 1,
  glide = 75,
  draggable = true,
  disabled = false,
  block = false,
  semantics = "radio",
  className = "",
  style,
  "aria-label": ariaLabel = "Segmented control",
}: Props<V>) {
  const list: SegmentItem<V>[] = items.map((item) =>
    typeof item === "string" ? { value: item, label: item } : item,
  );
  const [inner, setInner] = useState<V | undefined>(defaultValue ?? list[0]?.value);
  const current = value !== undefined ? value : inner;
  const index = Math.max(0, list.findIndex((item) => item.value === current));
  const reduce = useReducedMotion();
  const tabs = semantics === "tabs";

  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const slots = useRef<Slot[]>([]);
  const box = useRef<{ left: number; scale: number }>({ left: 0, scale: 1 });
  const committed = useRef(index);
  const handoff = useRef(0);
  const drag = useRef<Drag | null>(null);
  const gen = useRef(0);
  const innerW = useRef(0);
  const count = useRef(list.length);
  count.current = list.length;
  const thumbRadius = Math.max(0, radius - inset);
  const radiusRef = useRef(thumbRadius);
  radiusRef.current = thumbRadius;

  const edges = useRef<{ L: Edge; R: Edge } | null>(null);
  if (!edges.current) {
    const paint = () => {
      const el = thumbRef.current;
      const e = edges.current;
      if (!el || !e) return;
      const right = Math.max(0, innerW.current - e.R.get());
      const left = Math.max(0, e.L.get());
      el.style.clipPath = `inset(0 ${right}px 0 ${left}px round ${radiusRef.current}px)`;
    };
    edges.current = { L: new Edge(paint), R: new Edge(paint) };
  }
  const { L: edgeL, R: edgeR } = edges.current;

  const t = (seconds: number) => seconds / speed;

  const jumpTo = (i: number) => {
    const s = slots.current[i];
    if (!s) return;
    window.clearTimeout(handoff.current);
    gen.current += 1;
    edgeL.jump(s.l);
    edgeR.jump(s.r);
  };

  // Measured with a transform-safe scale, so a parent animating scale cannot skew the thumb.
  const readBox = () => {
    const track = trackRef.current;
    if (!track) return null;
    const rect = track.getBoundingClientRect();
    const scale = track.offsetWidth ? rect.width / track.offsetWidth : 1;
    box.current = { left: rect.left, scale: scale || 1 };
    return rect;
  };

  const measure = () => {
    const track = trackRef.current;
    const rect = readBox();
    if (!track || !rect) return;
    const { scale } = box.current;
    const next: Slot[] = [];
    for (let i = 0; i < count.current; i++) {
      const el = itemRefs.current[i];
      if (!el) {
        next.push({ l: 0, r: 0 });
        continue;
      }
      const r = el.getBoundingClientRect();
      next.push({
        l: (r.left - rect.left) / scale - inset,
        r: (r.right - rect.left) / scale - inset,
      });
    }
    slots.current = next;
    innerW.current = track.offsetWidth - inset * 2;
    if (!drag.current) jumpTo(committed.current);
  };

  const listKey = list.map((item) => item.value).join("|");
  useLayoutEffect(() => {
    measure();
    const observer = new ResizeObserver(() => measure());
    if (trackRef.current) observer.observe(trackRef.current);
    itemRefs.current.forEach((el) => el && observer.observe(el));
    document.fonts?.ready.then(() => measure());
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listKey, size, inset, equalSlots, block]);

  // A value changed from outside (or a rejected change) snaps the thumb to the real selection.
  useEffect(() => {
    if (!drag.current && committed.current !== index) {
      committed.current = index;
      jumpTo(index);
    }
  });

  useEffect(
    () => () => {
      window.clearTimeout(handoff.current);
      edgeL.stop();
      edgeR.stop();
    },
    [edgeL, edgeR],
  );

  const commit = (i: number) => {
    committed.current = i;
    if (i === index) return;
    if (value === undefined) setInner(list[i].value);
    onChange?.(list[i].value, i);
  };

  const land = (to: number, v: number | null, flick: boolean, withSquash: boolean) => {
    const b = slots.current[to];
    if (!b) return;
    const g = ++gen.current;
    const dir = Math.sign((b.l + b.r) / 2 - (edgeL.get() + edgeR.get()) / 2) || 1;
    const [lead, leadTo, trail, trailTo] =
      dir > 0 ? [edgeR, b.r, edgeL, b.l] : [edgeL, b.l, edgeR, b.r];
    const velocityFor = (edge: Edge) =>
      clamp(v === null ? edge.velocity() : v, -MAX_VELOCITY, MAX_VELOCITY);
    const leadV = velocityFor(lead);
    const trailV = velocityFor(trail);
    if (flick) lead.spring(leadTo, t(0.4), 0.2, leadV);
    else lead.spring(leadTo, t(0.3), 0, leadV);
    if (!withSquash || squash <= 0) {
      trail.spring(trailTo, t(0.3), 0, trailV);
      return;
    }
    trail.spring(trailTo + dir * squash, t(0.3), 0, trailV).then((done) => {
      if (done && gen.current === g) trail.spring(trailTo, t(0.16), 0, 0);
    });
  };

  const travel = (from: number, to: number) => {
    const a = slots.current[from];
    const b = slots.current[to];
    if (!a || !b) return;
    window.clearTimeout(handoff.current);
    gen.current += 1;
    if (reduce) {
      edgeL.jump(b.l);
      edgeR.jump(b.r);
      return;
    }
    const u = stretch / 100;
    edgeL.tween(b.l + (Math.min(a.l, b.l) - b.l) * u, t(DILATE), EASE_OUT);
    edgeR.tween(b.r + (Math.max(a.r, b.r) - b.r) * u, t(DILATE), EASE_OUT);
    handoff.current = window.setTimeout(() => land(to, null, false, true), t(HANDOFF) * 1000);
  };

  const select = (i: number) => {
    if (i === committed.current) return;
    const from = committed.current;
    commit(i);
    travel(from, i);
  };

  const localX = (e: PointerEvent) =>
    (e.clientX - box.current.left) / box.current.scale - inset;

  const handlePointerDown = (e: PointerEvent<HTMLButtonElement>, i: number) => {
    if (disabled || drag.current || e.button !== 0) return;
    readBox();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best effort */
    }
    const x = localX(e);
    const onThumb = draggable && x >= edgeL.get() && x <= edgeR.get();
    drag.current = { id: e.pointerId, x0: x, slot: i, onThumb, live: false, offset: 0, w: 0, hist: [[e.timeStamp, x]] };
    if (onThumb) {
      window.clearTimeout(handoff.current);
      gen.current += 1;
      edgeL.stop();
      edgeR.stop();
    } else if (!reduce) {
      e.currentTarget.dataset.pressed = "";
    }
  };

  const handlePointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id || !d.onThumb) return;
    const x = localX(e);
    d.hist.push([e.timeStamp, x]);
    if (d.hist.length > 8) d.hist.shift();
    if (!d.live) {
      if (Math.abs(x - d.x0) < DEADZONE) return;
      d.live = true;
      d.offset = x - edgeL.get();
      d.w = edgeR.get() - edgeL.get();
      if (trackRef.current) trackRef.current.dataset.held = "";
    }
    const width = innerW.current;
    const l = x - d.offset;
    const maxL = width - d.w;
    if (reduce) {
      const c = clamp(l, 0, maxL);
      edgeL.set(c);
      edgeR.set(c + d.w);
    } else if (l < 0) {
      edgeL.set(0);
      edgeR.set(d.w - rubber(-l, d.w));
    } else if (l > maxL) {
      edgeR.set(width);
      edgeL.set(maxL + rubber(l - maxL, d.w));
    } else {
      edgeL.set(l);
      edgeR.set(l + d.w);
    }
  };

  const release = () => {
    const d = drag.current;
    drag.current = null;
    if (trackRef.current) delete trackRef.current.dataset.held;
    if (d) {
      const el = itemRefs.current[d.slot];
      if (el) delete el.dataset.pressed;
    }
    return d;
  };

  const handlePointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    release();
    const x = localX(e);
    if (!d.live) {
      if (Math.abs(x - d.x0) <= SLOP) select(d.slot);
      return;
    }
    const v = velocityOf(d.hist, e.timeStamp);
    const flick = Math.abs(v) > FLICK;
    let to = nearestSlot(slots.current, (edgeL.get() + edgeR.get()) / 2 + project(v, glide));
    if (flick && to === committed.current) to = clamp(to + Math.sign(v), 0, list.length - 1);
    commit(to);
    if (reduce) jumpTo(to);
    else land(to, v, flick, flick);
  };

  const handlePointerCancel = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    release();
    if (!d.live) return;
    if (reduce) jumpTo(committed.current);
    else land(committed.current, null, false, false);
  };

  // Clicks without a pointer (screen readers, automation) still switch.
  const handleClick = (e: MouseEvent<HTMLButtonElement>, i: number) => {
    if (disabled || e.detail !== 0) return;
    select(i);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled || e.altKey || e.ctrlKey || e.metaKey) return;
    const last = list.length - 1;
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = Math.min(last, index + 1);
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = Math.max(0, index - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    if (next === null) return;
    e.preventDefault();
    if (next === index) return;
    select(next);
    itemRefs.current[next]?.focus();
  };

  const preset = SIZES[size] || SIZES.md;
  const content = (item: SegmentItem<V>) => (
    <>
      {item.icon}
      <span className="rubber-segment__label">{item.label}</span>
      {item.count !== undefined && <span className="rubber-segment__count">{item.count}</span>}
    </>
  );

  return (
    <div
      ref={trackRef}
      role={tabs ? "tablist" : "radiogroup"}
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      data-equal={equalSlots ? "" : undefined}
      data-block={block ? "" : undefined}
      data-draggable={draggable && !disabled ? "" : undefined}
      className={`rubber-segment${className ? ` ${className}` : ""}`}
      style={
        {
          "--rs-radius": `${radius}px`,
          "--rs-inset": `${inset}px`,
          "--rs-thumb-radius": `${thumbRadius}px`,
          "--rs-h": `${preset.height}px`,
          "--rs-font": `${preset.font}px`,
          "--rs-pad": `${preset.pad}px`,
          "--rs-min": `${preset.min}px`,
          ...style,
        } as CSSProperties
      }
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onLostPointerCapture={handlePointerCancel}
    >
      {list.map((item, i) => (
        <button
          key={item.value}
          ref={(el) => {
            itemRefs.current[i] = el;
          }}
          type="button"
          role={tabs ? "tab" : "radio"}
          aria-selected={tabs ? i === index : undefined}
          aria-checked={tabs ? undefined : i === index}
          aria-controls={tabs ? item.controls : undefined}
          data-active={i === index ? "" : undefined}
          tabIndex={i === index ? 0 : -1}
          disabled={disabled}
          title={item.title}
          className="rubber-segment__item"
          onPointerDown={(e) => handlePointerDown(e, i)}
          onClick={(e) => handleClick(e, i)}
          onKeyDown={handleKeyDown}
        >
          {content(item)}
        </button>
      ))}
      <div className="rubber-segment__lift" aria-hidden="true">
        <div ref={thumbRef} className="rubber-segment__thumb">
          {list.map((item) => (
            <span key={item.value} className="rubber-segment__item rubber-segment__copy">
              {content(item)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
