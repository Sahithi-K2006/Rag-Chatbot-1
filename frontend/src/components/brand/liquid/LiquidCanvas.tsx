// Minimal WebGL2 renderer for paper-design/liquid-logo's liquid-metal shader (see ./LICENSE.md).
// Differences from upstream canvas.tsx: no toast library, sized to its container, capped pixel ratio,
// paused while the tab is hidden, and full GPU cleanup on unmount.
import { useEffect, useRef } from "react";
import { liquidFragSource } from "./liquidFrag";
import { parseLogoImage } from "./parseLogoImage";

const vertexSource = `#version 300 es
precision mediump float;
in vec2 a_position;
out vec2 vUv;
void main() { vUv = .5 * (a_position + 1.); gl_Position = vec4(a_position, 0.0, 1.0); }`;

// Upstream defaults, slowed down: a brand mark should shimmer, not churn.
const PARAMS = { patternScale: 2, refraction: 0.015, edge: 0.4, patternBlur: 0.005, liquid: 0.07, speed: 0.12 };
const masks = new Map<string, Promise<ImageData>>();

export default function LiquidCanvas({ src, onError }: { src: string; onError: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current!;
    const gl = canvas.getContext("webgl2", { antialias: true, alpha: true, premultipliedAlpha: true });
    if (!gl) return onError();
    let raf = 0;
    let disposed = false;
    const cleanup: (() => void)[] = [];

    const compile = (type: number, source: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader compile failed");
      return s;
    };

    try {
      const program = gl.createProgram()!;
      gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSource));
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, liquidFragSource));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error("shader link failed");
      gl.useProgram(program);
      const u = (name: string) => gl.getUniformLocation(program, name);
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const pos = gl.getAttribLocation(program, "a_position");
      gl.enableVertexAttribArray(pos);
      gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
      gl.uniform1f(u("u_edge"), PARAMS.edge);
      gl.uniform1f(u("u_patternBlur"), PARAMS.patternBlur);
      gl.uniform1f(u("u_patternScale"), PARAMS.patternScale);
      gl.uniform1f(u("u_refraction"), PARAMS.refraction);
      gl.uniform1f(u("u_liquid"), PARAMS.liquid);
      gl.uniform1f(u("u_ratio"), 1);
      cleanup.push(() => {
        gl.deleteBuffer(buffer);
        gl.deleteProgram(program);
      });

      if (!masks.has(src)) masks.set(src, parseLogoImage(src).then((r) => r.imageData));
      masks
        .get(src)!
        .then((img) => {
          if (disposed) return;
          const side = Math.round(canvas.clientWidth * Math.min(devicePixelRatio, 2));
          canvas.width = canvas.height = side;
          gl.viewport(0, 0, side, side);
          gl.uniform1f(u("u_img_ratio"), img.width / img.height);
          const tex = gl.createTexture();
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, img.width, img.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, img.data);
          gl.uniform1i(u("u_image_texture"), 0);
          cleanup.push(() => gl.deleteTexture(tex));

          let t = 0;
          let last = performance.now();
          const frame = (now: number) => {
            t += (now - last) * PARAMS.speed;
            last = now;
            gl.uniform1f(u("u_time"), t);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            raf = requestAnimationFrame(frame);
          };
          const onVisibility = () => {
            cancelAnimationFrame(raf);
            if (!document.hidden) {
              last = performance.now();
              raf = requestAnimationFrame(frame);
            }
          };
          document.addEventListener("visibilitychange", onVisibility);
          cleanup.push(() => document.removeEventListener("visibilitychange", onVisibility));
          raf = requestAnimationFrame(frame);
        })
        .catch(() => !disposed && onError());
    } catch (e) {
      console.warn("Liquid logo unavailable, using static mark:", (e as Error).message);
      onError();
    }

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      cleanup.forEach((fn) => fn());
    };
  }, [src, onError]);

  // The shader renders neutral chrome; a light tint turns it into the brand's blue steel on ivory.
  return <canvas ref={ref} className="block size-full [filter:sepia(.4)_hue-rotate(195deg)_saturate(1.8)_brightness(1.55)_contrast(.72)]" />;
}
