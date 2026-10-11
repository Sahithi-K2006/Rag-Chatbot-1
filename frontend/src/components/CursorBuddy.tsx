import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion, useSpring, useTransform, useVelocity } from "motion/react";

// ----- on/off preference (per browser) -----
const KEY = "kb.buddy";
const listeners = new Set<() => void>();
const read = () => {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
};
export const buddyPref = {
  subscribe: (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn)),
  get: read,
  set(on: boolean) {
    try {
      localStorage.setItem(KEY, on ? "on" : "off");
    } catch {
      /* private mode: preference just won't persist */
    }
    listeners.forEach((fn) => fn());
  },
};
export const useBuddyEnabled = () => useSyncExternalStore(buddyPref.subscribe, buddyPref.get);

type Mood = "idle" | "happy" | "press" | "sleep";
const OFFSET = { x: 22, y: 22 }; // sits below-right of the pointer so it never covers what you click
const SLEEP_AFTER_MS = 6000;

/** Bridgey: a small robot that trails the mouse pointer. Mouse/trackpad only, never with reduced motion,
 *  never intercepts clicks. Looks where it's heading, cheers on buttons, squishes on click, naps when idle. */
export function CursorBuddy() {
  const enabled = useBuddyEnabled();
  const [supported] = useState(() => window.matchMedia("(pointer: fine)").matches && !window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [visible, setVisible] = useState(false);
  const [mood, setMood] = useState<Mood>("idle");
  const moodRef = useRef<Mood>("idle");

  const x = useSpring(-100, { stiffness: 140, damping: 17, mass: 0.7 });
  const y = useSpring(-100, { stiffness: 140, damping: 17, mass: 0.7 });
  const vx = useVelocity(x);
  const vy = useVelocity(y);
  const tilt = useTransform(vx, [-1200, 1200], [-18, 18], { clamp: true });
  const lookX = useTransform(vx, [-700, 700], [-2.2, 2.2], { clamp: true });
  const lookY = useTransform(vy, [-700, 700], [-1.6, 1.6], { clamp: true });

  useEffect(() => {
    if (!enabled || !supported) return;
    let sleepTimer = 0;
    const set = (m: Mood) => {
      if (moodRef.current !== m) setMood((moodRef.current = m));
    };
    const wake = () => {
      clearTimeout(sleepTimer);
      sleepTimer = window.setTimeout(() => set("sleep"), SLEEP_AFTER_MS);
    };
    const move = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      x.set(e.clientX + OFFSET.x);
      y.set(e.clientY + OFFSET.y);
      setVisible(true);
      if (moodRef.current !== "press") set((e.target as Element | null)?.closest?.("button:not(:disabled), a, [role=radio]") ? "happy" : "idle");
      wake();
    };
    const down = () => {
      set("press");
      wake();
    };
    const up = () => set("idle");
    const leave = () => setVisible(false);
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerdown", down);
    window.addEventListener("pointerup", up);
    document.documentElement.addEventListener("pointerleave", leave);
    return () => {
      clearTimeout(sleepTimer);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("pointerup", up);
      document.documentElement.removeEventListener("pointerleave", leave);
    };
  }, [enabled, supported, x, y]);

  if (!enabled || !supported) return null;

  return (
    <motion.div aria-hidden className="pointer-events-none fixed top-0 left-0 z-[60]" style={{ x, y, rotate: tilt }} animate={{ opacity: visible ? 1 : 0 }} transition={{ duration: 0.25 }}>
      <motion.div
        animate={mood === "press" ? { scaleX: 1.15, scaleY: 0.82, y: 3 } : mood === "happy" ? { scale: 1.08, y: [0, -4, 0] } : { scale: 1, y: [0, -2.5, 0] }}
        transition={mood === "press" ? { type: "spring", stiffness: 700, damping: 18 } : { y: { repeat: Infinity, duration: mood === "happy" ? 0.7 : 2.4, ease: "easeInOut" }, scale: { type: "spring", stiffness: 400, damping: 15 } }}
        style={{ originY: 1 }}
      >
        <svg width="40" height="46" viewBox="0 0 40 46" className="drop-shadow-[0_6px_10px_rgba(60,60,140,0.28)]">
          <defs>
            <linearGradient id="bb-head" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#ffffff" />
              <stop offset="1" stopColor="#e6e9fb" />
            </linearGradient>
          </defs>
          {/* antenna */}
          <path d="M20 9V4" stroke="#5146c9" strokeWidth="2" strokeLinecap="round" />
          <motion.circle cx="20" cy="3.5" r="2.6" fill="#ffd35c" stroke="#4b3cb8" strokeWidth="1.2" animate={{ scale: mood === "happy" ? [1, 1.35, 1] : [1, 1.12, 1] }} transition={{ repeat: Infinity, duration: mood === "happy" ? 0.6 : 1.8 }} />
          {/* ears */}
          <rect x="2.5" y="17" width="4" height="9" rx="2" fill="#5146c9" />
          <rect x="33.5" y="17" width="4" height="9" rx="2" fill="#5146c9" />
          {/* head */}
          <rect x="5.5" y="8.5" width="29" height="25" rx="10" fill="url(#bb-head)" stroke="#5146c9" strokeWidth="1.6" />
          {/* face screen */}
          <rect x="9.5" y="13" width="21" height="15" rx="6.5" fill="#1a2036" />
          <motion.g style={{ x: lookX, y: lookY }}>
            {mood === "happy" ? (
              <>
                <path d="M13.8 21.5q2.2-3 4.4 0M21.8 21.5q2.2-3 4.4 0" fill="none" stroke="#9fe8ff" strokeWidth="1.8" strokeLinecap="round" />
                <path d="M17.5 24.2q2.5 2 5 0" fill="none" stroke="#9fe8ff" strokeWidth="1.4" strokeLinecap="round" />
              </>
            ) : mood === "sleep" ? (
              <path d="M13.8 20.8h4.4M21.8 20.8h4.4" stroke="#9fe8ff" strokeWidth="1.8" strokeLinecap="round" />
            ) : (
              <g className="animate-[bb-blink_4.2s_infinite] [transform-box:fill-box] [transform-origin:center]">
                <rect x="14" y="17.5" width="4" height={mood === "press" ? 2 : 5.5} rx="2" fill="#9fe8ff" />
                <rect x="22" y="17.5" width="4" height={mood === "press" ? 2 : 5.5} rx="2" fill="#9fe8ff" />
              </g>
            )}
          </motion.g>
          {/* cheeks */}
          <circle cx="11.5" cy="30" r="1.6" fill="#ffb3c7" opacity=".85" />
          <circle cx="28.5" cy="30" r="1.6" fill="#ffb3c7" opacity=".85" />
          {/* body */}
          <rect x="12" y="34" width="16" height="9" rx="4.5" fill="#5146c9" />
          <circle cx="20" cy="38.5" r="1.7" fill="#ffd35c" />
        </svg>
      </motion.div>
      <AnimatePresence>
        {mood === "sleep" && (
          <motion.span initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="absolute -top-2 left-9 font-serif text-sm text-indigo italic">
            z<span className="text-xs">z</span>
          </motion.span>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
