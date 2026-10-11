import { lazy, Suspense, useCallback, useEffect, useState } from "react";

/** Static brand mark: crisp at any size, no WebGL. Used everywhere except the welcome hero. */
export function Mark({ size = 28, className }: { size?: number; className?: string }) {
  return <img src="/favicon.svg" alt="" width={size} height={size} className={className} />;
}

const LiquidCanvas = lazy(() => import("./liquid/LiquidCanvas"));

function canAnimate() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  try {
    return !!document.createElement("canvas").getContext("webgl2");
  } catch {
    return false;
  }
}

/** Liquid-metal version of the mark for the welcome hero. The static mark renders first and stays
 *  if WebGL2 is missing, motion is reduced, or the shader fails, so it never blocks the page. */
export function LiquidMark({ size = 72 }: { size?: number }) {
  const [live, setLive] = useState(false);
  const [failed, setFailed] = useState(false);
  const onError = useCallback(() => setFailed(true), []);
  useEffect(() => setLive(canAnimate()), []);
  const fallback = (
    <span className="grid place-items-center rounded-[22%] bg-white/70 shadow-[inset_0_1px_0_rgba(255,255,255,.9),0_8px_24px_-10px_rgba(81,70,201,.45)]" style={{ width: size, height: size }}>
      <Mark size={Math.round(size * 0.78)} />
    </span>
  );
  if (!live || failed) return fallback;
  return (
    <span className="relative block" style={{ width: size, height: size }} aria-hidden>
      <Suspense fallback={fallback}>
        <LiquidCanvas src="/brand/kb-mark-mask.svg" onError={onError} />
      </Suspense>
    </span>
  );
}
