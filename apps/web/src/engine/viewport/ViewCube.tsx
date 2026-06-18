import { useEffect, useRef, useState } from 'react';
import { Vector3 } from 'three';
import { useSceneStore } from '@/stores/sceneStore';

type CubeFace = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';

const faceLabels: Record<CubeFace, string> = {
  front: 'Front',
  back: 'Back',
  left: 'Left',
  right: 'Right',
  top: 'Top',
  bottom: 'Bottom',
};

function getDominantFace(direction: Vector3): CubeFace {
  const absX = Math.abs(direction.x);
  const absY = Math.abs(direction.y);
  const absZ = Math.abs(direction.z);
  if (absY >= absX && absY >= absZ) return direction.y >= 0 ? 'top' : 'bottom';
  if (absX >= absZ) return direction.x >= 0 ? 'right' : 'left';
  return direction.z >= 0 ? 'front' : 'back';
}

function faceTransform(face: CubeFace) {
  const transforms: Record<CubeFace, string> = {
    front: 'translateZ(32px)',
    back: 'rotateY(180deg) translateZ(32px)',
    right: 'rotateY(90deg) translateZ(32px)',
    left: 'rotateY(-90deg) translateZ(32px)',
    top: 'rotateX(90deg) translateZ(32px)',
    bottom: 'rotateX(-90deg) translateZ(32px)',
  };
  return transforms[face];
}

export function ViewCube() {
  const viewport = useSceneStore((state) => state.viewport);
  const [rotation, setRotation] = useState({ pitch: -24, yaw: 38 });
  const [activeFace, setActiveFace] = useState<CubeFace>('front');
  const lastStateRef = useRef({ pitch: -24, yaw: 38, face: 'front' as CubeFace });

  useEffect(() => {
    let frame = 0;
    const cameraPosition = new Vector3();
    const target = new Vector3();
    const direction = new Vector3();
    const origin = new Vector3(0, 0, 0);

    const update = () => {
      if (viewport) {
        viewport.camera.getWorldPosition(cameraPosition);
        target.copy(viewport.controls?.target ?? origin);
        direction.copy(cameraPosition).sub(target).normalize();
        const yaw = Math.atan2(direction.x, direction.z) * (180 / Math.PI);
        const pitch = Math.atan2(direction.y, Math.hypot(direction.x, direction.z)) * (180 / Math.PI);
        const nextState = { pitch: -pitch, yaw, face: getDominantFace(direction) };
        const previous = lastStateRef.current;
        if (
          Math.abs(previous.pitch - nextState.pitch) > 0.35 ||
          Math.abs(previous.yaw - nextState.yaw) > 0.35 ||
          previous.face !== nextState.face
        ) {
          lastStateRef.current = nextState;
          setRotation({ pitch: nextState.pitch, yaw: nextState.yaw });
          setActiveFace(nextState.face);
        }
      }
      frame = requestAnimationFrame(update);
    };

    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [viewport]);

  return (
    <div className="pointer-events-none absolute right-4 top-4 z-50 grid h-28 w-28 place-items-center rounded-xl border border-white/16 bg-black/50 shadow-[0_16px_42px_rgba(0,0,0,0.42)] backdrop-blur-md">
      <div className="absolute top-1.5 rounded bg-white/90 px-1.5 py-0.5 text-[9px] font-black uppercase text-[#14151d]">
        {faceLabels[activeFace]}
      </div>
      <div className="mt-3 h-16 w-16 [perspective:460px]">
        <div
          className="relative h-16 w-16 [transform-style:preserve-3d] transition-transform duration-75"
          style={{ transform: `rotateX(${rotation.pitch}deg) rotateY(${rotation.yaw}deg)` }}
        >
          {(Object.keys(faceLabels) as CubeFace[]).map((face) => (
            <div
              key={face}
              className="absolute grid h-16 w-16 place-items-center rounded-sm border border-white/35 bg-white text-[10px] font-black uppercase tracking-normal text-[#191a22] shadow-[0_4px_12px_rgba(0,0,0,0.34)]"
              style={{ transform: faceTransform(face), backfaceVisibility: 'hidden' }}
            >
              {faceLabels[face]}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
