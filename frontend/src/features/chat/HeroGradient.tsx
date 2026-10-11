// Loaded lazily (its own chunk with three.js + react-three-fiber) only for the welcome hero.
import { ShaderGradient, ShaderGradientCanvas } from "@shadergradient/react";

/** A slow, pale ivory/periwinkle wash. Low pixel density and speed keep it cheap on laptops. */
export default function HeroGradient() {
  return (
    <ShaderGradientCanvas style={{ position: "absolute", inset: 0 }} pixelDensity={1} fov={40} pointerEvents="none" lazyLoad powerPreference="low-power">
      <ShaderGradient
        type="waterPlane"
        animate="on"
        uSpeed={0.08}
        uStrength={1.4}
        uDensity={1.1}
        uFrequency={4}
        color1="#dfe4ff"
        color2="#f4ecff"
        color3="#fbf6ea"
        brightness={1.25}
        lightType="3d"
        grain="off"
        cDistance={4.2}
        cPolarAngle={90}
        cAzimuthAngle={180}
        positionX={0}
        positionY={0}
        positionZ={0}
        rotationX={0}
        rotationY={10}
        rotationZ={50}
      />
    </ShaderGradientCanvas>
  );
}
