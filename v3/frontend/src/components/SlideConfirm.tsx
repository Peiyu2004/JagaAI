/**
 * Slide-to-confirm for consequential actions (adapted from React Bits "SlideCommit").
 * No animation library: a small spring integrator drives a CSS variable, so dragging
 * never re-renders React. Drag the capsule to the end (or focus it and press End or
 * Enter) to confirm; release early and it springs back. While onConfirm's promise is
 * pending it shows a spinner, then success or a shake-and-reset on error.
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { ArrowRight, Check } from "lucide-react";
import "./SlideConfirm.css";

type Phase = "idle" | "pending" | "done" | "error";

const PAD = 4;
const MIN_PENDING = 350; // ms: long enough that the spinner never just flickers
const K = 580; // spring stiffness
const C_COMMIT = 2 * Math.sqrt(K); // critically damped
const C_HOME = C_COMMIT * 0.62; // a little bounce when it returns home

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** Semi-implicit Euler spring; returns a cancel function. */
function spring(from: number, to: number, velocity: number, damping: number, onStep: (x: number) => void, onDone?: () => void) {
  let x = from;
  let v = velocity;
  let last = performance.now();
  let raf = requestAnimationFrame(function step(now) {
    let dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    while (dt > 0) {
      const h = Math.min(1 / 240, dt);
      v += (-K * (x - to) - damping * v) * h;
      x += v * h;
      dt -= h;
    }
    if (Math.abs(x - to) < 0.3 && Math.abs(v) < 4) {
      onStep(to);
      onDone?.();
      return;
    }
    onStep(x);
    raf = requestAnimationFrame(step);
  });
  return () => cancelAnimationFrame(raf);
}

const Spinner = ({ size }: { size: number }) => (
  <svg className="sc-spinner" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2.4" strokeOpacity="0.25" />
    <path d="M12 3a9 9 0 0 1 9 9" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
  </svg>
);

export type SlideConfirmProps = {
  label: string;
  doneLabel: string;
  errorLabel: string;
  /** May return a promise; a rejection shows the error state. */
  onConfirm: () => unknown;
  onDone?: () => void;
  onError?: (reason: unknown) => void;
  disabled?: boolean;
  /** Shown under the control while disabled, e.g. what to do first. */
  disabledHint?: string;
  height?: number;
  className?: string;
};

export function SlideConfirm({
  label,
  doneLabel,
  errorLabel,
  onConfirm,
  onDone,
  onError,
  disabled = false,
  disabledHint,
  height = 56,
  className = "",
}: SlideConfirmProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [held, setHeld] = useState(false);
  const [width, setWidth] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const handle = useRef<HTMLDivElement>(null);
  const x = useRef(0);
  const stop = useRef<(() => void) | null>(null);
  const grip = useRef<{ id: number; grab: number; hist: [number, number][]; moved: boolean } | null>(null);
  const timers = useRef<number[]>([]);
  const run = useRef(0);
  const reduce = useRef(false);

  const GRIP = height - PAD * 2;
  const TRAVEL = Math.max(1, width - PAD * 2 - GRIP);

  useLayoutEffect(() => {
    reduce.current = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const el = track.current;
    if (!el) return;
    const measure = () => setWidth(el.getBoundingClientRect().width);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(
    () => () => {
      stop.current?.();
      timers.current.forEach((t) => window.clearTimeout(t));
      run.current += 1;
    },
    [],
  );

  const later = (fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms));
  };

  /** Writes the position to CSS variables and the slider's ARIA value. */
  const paint = (v: number) => {
    x.current = v;
    const el = root.current;
    if (!el) return;
    // The spring may overshoot past home; the capsule never leaves the track.
    const shown = clamp(v, 0, TRAVEL);
    el.style.setProperty("--sc-x", `${shown}px`);
    el.style.setProperty("--sc-say", String(clamp(1 - shown / (TRAVEL * 0.55), 0, 1)));
    const pct = Math.round((shown / TRAVEL) * 100);
    handle.current?.setAttribute("aria-valuenow", String(pct));
  };

  const animateTo = (to: number, velocity = 0, damping = C_HOME, done?: () => void) => {
    stop.current?.();
    if (reduce.current) {
      paint(to);
      done?.();
      return;
    }
    stop.current = spring(x.current, to, velocity, damping, paint, done);
  };

  // Keep the capsule where it belongs when the width changes.
  useLayoutEffect(() => {
    paint(phase === "pending" || phase === "done" ? TRAVEL : clamp(x.current, 0, TRAVEL));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [TRAVEL]);

  const commit = () => {
    stop.current?.();
    paint(TRAVEL);
    const id = ++run.current;
    setPhase("pending");
    const started = performance.now();
    const settle = (fn: () => void) =>
      later(() => id === run.current && fn(), Math.max(0, MIN_PENDING - (performance.now() - started)));
    let out: unknown;
    try {
      out = onConfirm();
    } catch (reason) {
      settle(() => fail(reason));
      return;
    }
    Promise.resolve(out).then(
      () =>
        settle(() => {
          setPhase("done");
          onDone?.();
        }),
      (reason) => settle(() => fail(reason)),
    );
  };

  const fail = (reason: unknown) => {
    setPhase("error");
    onError?.(reason);
    animateTo(0, 0, C_HOME);
    later(() => setPhase("idle"), 1800);
  };

  const busy = phase === "pending" || phase === "done";

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || busy || grip.current || e.button !== 0) return;
    stop.current?.();
    const rect = track.current!.getBoundingClientRect();
    const at = e.clientX - rect.left - PAD;
    // Grabbing outside the capsule jumps it under the pointer's leading edge, like a real slider.
    const onCapsule = at <= x.current + GRIP;
    grip.current = { id: e.pointerId, grab: onCapsule ? at - x.current : GRIP / 2, hist: [], moved: false };
    if (!onCapsule) paint(clamp(at - GRIP / 2, 0, TRAVEL));
    track.current?.setPointerCapture(e.pointerId);
    setHeld(true);
    if (phase === "error") setPhase("idle");
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = grip.current;
    if (!g || g.id !== e.pointerId) return;
    const rect = track.current!.getBoundingClientRect();
    const next = clamp(e.clientX - rect.left - PAD - g.grab, 0, TRAVEL);
    if (Math.abs(next - x.current) > 0.5) g.moved = true;
    g.hist.push([e.timeStamp, next]);
    if (g.hist.length > 5) g.hist.shift();
    paint(next);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = grip.current;
    if (!g || g.id !== e.pointerId) return;
    grip.current = null;
    try {
      track.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    setHeld(false);
    if (x.current >= TRAVEL - 2) {
      commit();
      return;
    }
    const [t0, x0] = g.hist[0] ?? [0, x.current];
    const [t1, x1] = g.hist[g.hist.length - 1] ?? [0, x.current];
    const velocity = ((x1 - x0) / Math.max(1, t1 - t0)) * 1000;
    if (!g.moved) {
      // A tap: nudge to show it slides, then return.
      animateTo(Math.min(TRAVEL * 0.18, 40), 0, C_COMMIT, () => animateTo(0, 0, C_HOME));
      return;
    }
    animateTo(0, Math.min(0, velocity), C_HOME);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (disabled || busy) return;
    const step = TRAVEL / 10;
    if (e.key === "End" || e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.min(TRAVEL, x.current + step);
      paint(next);
      if (next >= TRAVEL) commit();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      e.preventDefault();
      paint(Math.max(0, x.current - step));
    } else if (e.key === "Home") {
      e.preventDefault();
      animateTo(0);
    }
  };

  const icon = Math.round(GRIP * 0.42);
  const style = {
    "--sc-h": `${height}px`,
    "--sc-grip": `${GRIP}px`,
    "--sc-pad": `${PAD}px`,
    "--sc-x": "0px",
    "--sc-say": "1",
  } as CSSProperties;

  return (
    <div
      ref={root}
      className={"sc" + (className ? ` ${className}` : "")}
      data-phase={phase}
      data-held={held ? "" : undefined}
      data-disabled={disabled ? "" : undefined}
      style={style}
    >
      <div
        ref={track}
        className="sc-track"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <span className="sc-label" aria-hidden="true">
          <span className="sc-text">{label}</span>
          <span className="sc-text sc-text-error">{errorLabel}</span>
        </span>
        <span className="sc-fill" aria-hidden="true" />
        <div
          ref={handle}
          className="sc-handle"
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={0}
          aria-busy={phase === "pending" || undefined}
          aria-disabled={disabled || undefined}
          onKeyDown={onKeyDown}
        >
          {phase === "pending" ? <Spinner size={icon} /> : <ArrowRight size={icon} strokeWidth={2.25} aria-hidden="true" />}
        </div>
        <span className="sc-done" aria-hidden="true">
          <Check size={Math.round(GRIP * 0.4)} strokeWidth={2.75} />
          {doneLabel}
        </span>
        <span className="sc-sr" aria-live="polite">
          {phase === "pending" ? "Working" : phase === "done" ? doneLabel : phase === "error" ? errorLabel : ""}
        </span>
      </div>
      {disabled && disabledHint && <p className="sc-hint">{disabledHint}</p>}
    </div>
  );
}
