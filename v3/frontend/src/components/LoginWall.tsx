import { useEffect, useRef } from "react";

type Frame = { src: string; event?: boolean };

const reel = (name: string, event = false): Frame => ({
  src: `/login-reel/${name}.jpg`,
  event,
});

// Static, privacy-checked copies built by scripts/build-login-reel.py.
// The login must never request /api, so nothing here is fetched from the backend.
const rows: Frame[][] = [
  [
    reel("demo-landing-entry-1", true),
    reel("demo-kerb-waiting-2"),
    reel("demo-parking-people-1"),
    reel("demo-stairs-empty-1"),
    reel("demo-parking-machine-1"),
    reel("demo-landing-entry-3"),
  ],
  [
    reel("demo-parking-holdout-1"),
    reel("demo-courtyard-entry-1", true),
    reel("demo-landing-entry-4"),
    reel("demo-kerb-waiting-3"),
    reel("demo-parking-people-2"),
    reel("demo-stairs-entry-1"),
  ],
  [
    reel("demo-kerb-waiting-1", true),
    reel("demo-courtyard-entry-2"),
    reel("demo-parking-people-3"),
    reel("demo-landing-entry-2", true),
    reel("demo-parking-holdout-2"),
    reel("demo-kerb-waiting-4"),
  ],
];

const DEVELOP_EVERY = 2400;
const DEVELOP_FOR = 2200;
const MAX_DEVELOPED = 2;

export function LoginWall() {
  const wallRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const wall = wallRef.current;
    if (!wall) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timers = new Set<number>();
    const tick = () => {
      if (document.hidden) return;
      const developed = wall.querySelectorAll(".jl-tile.is-developed").length;
      if (developed >= MAX_DEVELOPED) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const candidates = Array.from(
        wall.querySelectorAll<HTMLElement>(".jl-tile:not(.is-developed)"),
      ).filter((tile) => {
        if (tile.offsetParent === null) return false;
        const r = tile.getBoundingClientRect();
        return r.right > 0 && r.left < vw && r.bottom > 0 && r.top < vh;
      });
      const tile = candidates[Math.floor(Math.random() * candidates.length)];
      if (!tile) return;
      tile.classList.add("is-developed");
      const timer = window.setTimeout(() => {
        tile.classList.remove("is-developed");
        timers.delete(timer);
      }, DEVELOP_FOR);
      timers.add(timer);
    };
    const interval = window.setInterval(tick, DEVELOP_EVERY);
    return () => {
      window.clearInterval(interval);
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, []);

  return (
    <div className="jl-wall" ref={wallRef} aria-hidden="true">
      <div className="jl-wall-rows">
        {rows.map((row, r) => (
          <div className={`jl-row jl-row-${r + 1}`} key={r}>
            <div className="jl-track">
              {[...row, ...row].map((frame, i) => (
                <img
                  key={i}
                  className={frame.event ? "jl-tile is-event" : "jl-tile"}
                  src={frame.src}
                  alt=""
                  loading="eager"
                  decoding="async"
                  draggable={false}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="jl-wall-scrim" />
    </div>
  );
}
