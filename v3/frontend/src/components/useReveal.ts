import { useEffect, type RefObject } from "react";

// Fades [data-reveal] children in as they scroll into view.
// Adds .reveal-ready to the root only when motion is allowed, so content is never hidden otherwise.
export function useReveal(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = ref.current;
    if (
      !root ||
      !("IntersectionObserver" in window) ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    root.classList.add("reveal-ready");
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("is-in");
          io.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -6% 0px", threshold: 0.06 },
    );
    const watch = () =>
      root
        .querySelectorAll<HTMLElement>("[data-reveal]:not(.is-in)")
        .forEach((el) => io.observe(el));
    watch();
    const mo = new MutationObserver(watch);
    mo.observe(root, { childList: true, subtree: true });
    return () => {
      io.disconnect();
      mo.disconnect();
    };
  }, [ref]);
}
