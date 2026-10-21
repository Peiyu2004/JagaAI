import { useLayoutEffect, useRef } from "react";

export type DetectionFrameState =
  | "hidden"
  | "focus"
  | "busy"
  | "error"
  | "success";

const OUTSET = 6;

// Amber selection frame borrowed from the TechText wordmark. It glides between
// whichever element of the sign-in card is currently "detected".
export function DetectionFrame({
  target,
  state,
  label,
  container,
}: {
  target: HTMLElement | null;
  state: DetectionFrameState;
  label: string;
  container: HTMLElement | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const wasHidden = useRef(true);
  const visible = state !== "hidden" && !!target && !!container;
  // Keep the last label while fading out instead of blanking it.
  const shownLabel = useRef(label);
  if (visible) shownLabel.current = label;

  useLayoutEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    if (!visible || !target || !container) {
      wasHidden.current = true;
      return;
    }
    const measure = () => {
      const c = container.getBoundingClientRect();
      const t = target.getBoundingClientRect();
      const x = t.left - c.left - container.clientLeft - OUTSET;
      const y = t.top - c.top - container.clientTop - OUTSET;
      frame.style.setProperty("--fx", `${x}px`);
      frame.style.setProperty("--fy", `${y}px`);
      frame.style.setProperty("--fw", `${t.width + OUTSET * 2}px`);
      frame.style.setProperty("--fh", `${t.height + OUTSET * 2}px`);
    };
    if (wasHidden.current) {
      // Jump to the target first so the frame never flies in from 0,0.
      frame.classList.add("is-jumping");
      measure();
      void frame.offsetWidth;
      frame.classList.remove("is-jumping");
      wasHidden.current = false;
    } else {
      measure();
    }
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [visible, target, container, state]);

  return (
    <div
      ref={ref}
      className={`jl-frame is-${visible ? state : "hidden"}`}
      aria-hidden="true"
    >
      <div className="jl-frame-box">
        <span className="jl-frame-label">{shownLabel.current}</span>
        <i className="jl-frame-dot tl" />
        <i className="jl-frame-dot tr" />
        <i className="jl-frame-dot bl" />
        <i className="jl-frame-dot br" />
        <span className="jl-frame-scan" />
      </div>
    </div>
  );
}
