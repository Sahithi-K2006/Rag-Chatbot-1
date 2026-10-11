import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from "react";

const HeroGradient = lazy(() => import("./HeroGradient"));

/** Static wash: what everyone sees first, and all they see without WebGL or with reduced motion. */
const CssWash = () => (
  <div
    aria-hidden
    className="absolute inset-0"
    style={{
      background:
        "radial-gradient(60% 80% at 15% 20%, #e2e7ff 0%, transparent 60%), radial-gradient(50% 70% at 85% 30%, #f1e9ff 0%, transparent 60%), radial-gradient(70% 90% at 50% 100%, #fbf4e6 0%, transparent 65%), #fbf9f4",
    }}
  />
);

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    console.warn("Shader gradient unavailable, using static background:", error.message);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function webglOk() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

export function HeroBackdrop() {
  const [live, setLive] = useState(false);
  useEffect(() => {
    // Wait for the browser to be idle so the chat UI is interactive before three.js loads.
    const start = () => setLive(webglOk());
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(start, { timeout: 1500 });
      return () => window.cancelIdleCallback(id);
    }
    const t = setTimeout(start, 300); // Safari has no requestIdleCallback
    return () => clearTimeout(t);
  }, []);
  return (
    <>
      <CssWash />
      {live && (
        <Boundary>
          <Suspense fallback={null}>
            <div className="absolute inset-0 animate-[fade-in_1.2s_ease-out_both]">
              <HeroGradient />
            </div>
          </Suspense>
        </Boundary>
      )}
      {/* Readability veil: keeps text contrast independent of what the shader renders. */}
      <div aria-hidden className="absolute inset-0 bg-gradient-to-r from-[#fbf9f4]/85 via-[#fbf9f4]/55 to-[#fbf9f4]/20" />
    </>
  );
}
