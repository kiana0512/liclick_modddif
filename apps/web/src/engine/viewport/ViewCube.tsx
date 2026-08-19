import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from 'react';
import { Vector3 } from 'three';
import { cn } from '@/components/common/cn';
import { useSceneStore } from '@/stores/sceneStore';

type CubeFace = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';
type FaceEdge = 'left' | 'right' | 'top' | 'bottom';
type SnapTarget = { direction: Vector3; edges: FaceEdge[]; face: CubeFace; label: string };

const cubeSize = 76;
const cubeHalf = cubeSize / 2;
const hoverMarkerThickness = 7;

const faceLabels: Record<CubeFace, string> = {
  front: 'Front',
  back: 'Back',
  left: 'Left',
  right: 'Right',
  top: 'Top',
  bottom: 'Bottom',
};

const faceDirections: Record<CubeFace, Vector3> = {
  front: new Vector3(0, 0, 1),
  back: new Vector3(0, 0, -1),
  left: new Vector3(-1, 0, 0),
  right: new Vector3(1, 0, 0),
  top: new Vector3(0, 1, 0),
  bottom: new Vector3(0, -1, 0),
};

const faceNeighbors: Record<CubeFace, Record<FaceEdge, CubeFace>> = {
  front: { left: 'left', right: 'right', top: 'top', bottom: 'bottom' },
  back: { left: 'right', right: 'left', top: 'top', bottom: 'bottom' },
  left: { left: 'back', right: 'front', top: 'top', bottom: 'bottom' },
  right: { left: 'front', right: 'back', top: 'top', bottom: 'bottom' },
  top: { left: 'left', right: 'right', top: 'back', bottom: 'front' },
  bottom: { left: 'left', right: 'right', top: 'front', bottom: 'back' },
};

function getViewLabel(direction: Vector3) {
  const absX = Math.abs(direction.x);
  const absY = Math.abs(direction.y);
  const absZ = Math.abs(direction.z);
  const strongest = Math.max(absX, absY, absZ);
  const threshold = strongest * 0.68;
  const labels: string[] = [];

  if (absY >= threshold) labels.push(faceLabels[direction.y >= 0 ? 'top' : 'bottom']);
  if (absZ >= threshold) labels.push(faceLabels[direction.z >= 0 ? 'front' : 'back']);
  if (absX >= threshold) labels.push(faceLabels[direction.x >= 0 ? 'right' : 'left']);

  return labels.length > 0 ? labels.join('/') : faceLabels.front;
}

function faceTransform(face: CubeFace) {
  const transforms: Record<CubeFace, string> = {
    front: `translateZ(${cubeHalf}px)`,
    back: `rotateY(180deg) translateZ(${cubeHalf}px)`,
    right: `rotateY(90deg) translateZ(${cubeHalf}px)`,
    left: `rotateY(-90deg) translateZ(${cubeHalf}px)`,
    top: `rotateX(90deg) translateZ(${cubeHalf}px)`,
    bottom: `rotateX(-90deg) translateZ(${cubeHalf}px)`,
  };
  return transforms[face];
}

function faceDirection(face: CubeFace) {
  return faceDirections[face].clone();
}

function axisSign(value: number) {
  if (Math.abs(value) < 0.001) return 0;
  return value > 0 ? 1 : -1;
}

function faceHoverMarkerStyle(edges: FaceEdge[]): CSSProperties | undefined {
  if (edges.length === 1) {
    switch (edges[0]) {
      case 'left':
        return { left: 0, top: 0, width: hoverMarkerThickness, height: '100%' };
      case 'right':
        return { right: 0, top: 0, width: hoverMarkerThickness, height: '100%' };
      case 'top':
        return { left: 0, top: 0, width: '100%', height: hoverMarkerThickness };
      case 'bottom':
        return { left: 0, bottom: 0, width: '100%', height: hoverMarkerThickness };
    }
  }
  if (edges.length === 2) {
    return {
      ...(edges.includes('left') ? { left: 0 } : { right: 0 }),
      ...(edges.includes('top') ? { top: 0 } : { bottom: 0 }),
      width: 16,
      height: 16,
    };
  }
  return undefined;
}

function upForDirection(direction: Vector3) {
  const horizontalLength = Math.hypot(direction.x, direction.z);
  if (horizontalLength < 0.001)
    return direction.y >= 0 ? new Vector3(0, 0, -1) : new Vector3(0, 0, 1);

  const worldUp = new Vector3(0, 1, 0);
  const up = worldUp.sub(direction.clone().multiplyScalar(worldUp.dot(direction)));
  return up.lengthSq() > 0.000001 ? up.normalize() : new Vector3(0, 1, 0);
}

function getSnapTarget(face: CubeFace, event: MouseEvent<HTMLButtonElement>): SnapTarget {
  const target = event.currentTarget;
  const width = target.clientWidth;
  const height = target.clientHeight;
  const edgeSize = Math.min(width, height) * 0.24;
  const x = event.nativeEvent.offsetX;
  const y = event.nativeEvent.offsetY;
  const direction = faceDirection(face);
  const edges: FaceEdge[] = [];
  const neighbors = faceNeighbors[face];

  if (x <= edgeSize) edges.push('left');
  else if (x >= width - edgeSize) edges.push('right');

  if (y <= edgeSize) edges.push('top');
  else if (y >= height - edgeSize) edges.push('bottom');

  edges.forEach((edge) => direction.add(faceDirection(neighbors[edge])));
  direction.normalize();

  return { direction, edges, face, label: getViewLabel(direction) };
}

export function ViewCube() {
  const viewport = useSceneStore((state) => state.viewport);
  const [rotation, setRotation] = useState({ pitch: -24, yaw: 38 });
  const [activeLabel, setActiveLabel] = useState(faceLabels.front);
  const [hoveredTarget, setHoveredTarget] = useState<SnapTarget>();
  const lastStateRef = useRef({ pitch: -24, yaw: 38, label: faceLabels.front });
  const lastHoverKeyRef = useRef('');

  const snapToDirection = useCallback(
    (direction: Vector3, event?: MouseEvent) => {
      event?.preventDefault();
      event?.stopPropagation();
      if (!viewport) return;

      const target = viewport.controls?.target?.clone() ?? new Vector3(0, 0, 0);
      const currentPosition = new Vector3();
      viewport.camera.getWorldPosition(currentPosition);
      const distance = Math.max(currentPosition.distanceTo(target), 0.8);
      const snapDirection = direction.clone().normalize();
      viewport.camera.position.copy(target).add(snapDirection.multiplyScalar(distance));
      viewport.camera.up.copy(upForDirection(direction));
      viewport.camera.lookAt(target);
      viewport.controls?.target.copy(target);
      viewport.controls?.update();
      viewport.camera.updateMatrixWorld();
    },
    [viewport],
  );

  const snapFromFaceClick = useCallback(
    (face: CubeFace, event: MouseEvent<HTMLButtonElement>) => {
      snapToDirection(getSnapTarget(face, event).direction, event);
    },
    [snapToDirection],
  );

  const updateHoverTarget = useCallback((face: CubeFace, event: MouseEvent<HTMLButtonElement>) => {
    const nextTarget = getSnapTarget(face, event);
    const nextKey = `${nextTarget.face}:${nextTarget.edges.join('-')}`;
    if (lastHoverKeyRef.current === nextKey) return;

    lastHoverKeyRef.current = nextKey;
    setHoveredTarget(nextTarget);
  }, []);

  const clearHoverTarget = useCallback(() => {
    if (!lastHoverKeyRef.current) return;

    lastHoverKeyRef.current = '';
    setHoveredTarget(undefined);
  }, []);

  useEffect(() => {
    const cameraPosition = new Vector3();
    const target = new Vector3();
    const direction = new Vector3();
    const origin = new Vector3(0, 0, 0);

    const update = () => {
      if (viewport) {
        viewport.camera.getWorldPosition(cameraPosition);
        target.copy(viewport.controls?.target ?? origin);
        direction.copy(cameraPosition).sub(target).normalize();
        const rawYaw = Math.atan2(direction.x, direction.z) * (180 / Math.PI);
        // atan2 wraps at the back view (+180 -> -180). Feeding that wrapped
        // value to a CSS transition makes the cube spin almost a full turn and
        // visibly twitch while the camera crosses the seam. Keep yaw on the
        // nearest continuous revolution instead.
        let yaw = rawYaw;
        while (yaw - lastStateRef.current.yaw > 180) yaw -= 360;
        while (yaw - lastStateRef.current.yaw < -180) yaw += 360;
        const pitch =
          Math.atan2(direction.y, Math.hypot(direction.x, direction.z)) * (180 / Math.PI);
        const nextState = { pitch: -pitch, yaw, label: getViewLabel(direction) };
        const previous = lastStateRef.current;
        if (
          Math.abs(previous.pitch - nextState.pitch) > 0.35 ||
          Math.abs(previous.yaw - nextState.yaw) > 0.35 ||
          previous.label !== nextState.label
        ) {
          lastStateRef.current = nextState;
          setRotation({ pitch: nextState.pitch, yaw: nextState.yaw });
          setActiveLabel(nextState.label);
        }
      }
    };

    update();
    return viewport?.controls?.subscribeChange?.(update);
  }, [viewport]);

  const displayLabel = hoveredTarget?.label ?? activeLabel;

  return (
    <div className="absolute right-4 top-4 z-10 grid h-32 w-32 place-items-start justify-items-center">
      <div
        className={cn(
          'z-10 max-w-[7.5rem] rounded px-1.5 py-0.5 text-[8px] font-black uppercase tracking-normal shadow-[0_3px_12px_rgba(0,0,0,0.3)] transition-colors',
          hoveredTarget ? 'bg-liclick-pink text-white' : 'bg-white/90 text-[#14151d]',
        )}
        data-testid="view-cube-active-label"
      >
        {displayLabel}
      </div>
      <div className="mt-2 [perspective:540px]" style={{ width: cubeSize, height: cubeSize }}>
        <div
          className="relative [transform-style:preserve-3d] will-change-transform"
          style={{
            width: cubeSize,
            height: cubeSize,
            // CSS rotates the cube itself while `yaw` describes the camera
            // orbit. Those rotations are inverse operations. Using the same
            // sign mirrored the visible corner (LEFT | FRONT instead of the
            // user-facing FRONT | RIGHT).
            transform: `rotateX(${rotation.pitch}deg) rotateY(${-rotation.yaw}deg)`,
          }}
        >
          {(Object.keys(faceLabels) as CubeFace[]).map((face) => {
            const hoverEdges = hoveredTarget?.face === face ? hoveredTarget.edges : [];
            const centerHovered = hoveredTarget?.face === face && hoverEdges.length === 0;
            const hoverMarkerStyle = faceHoverMarkerStyle(hoverEdges);

            return (
              <button
                type="button"
                key={face}
                data-testid={`view-cube-face-${face}`}
                aria-label={`Snap view to ${faceLabels[face]}`}
                className={cn(
                  'absolute grid place-items-center overflow-hidden rounded-md border text-[11px] font-black uppercase tracking-normal shadow-[0_4px_12px_rgba(0,0,0,0.26)] transition-colors focus:outline-none focus:ring-2 focus:ring-liclick-pink/80',
                  centerHovered
                    ? 'border-liclick-pink bg-liclick-pink text-white'
                    : 'border-[#31333b] bg-white text-[#191a22] hover:border-liclick-pink/70',
                )}
                style={{
                  width: cubeSize,
                  height: cubeSize,
                  transform: faceTransform(face),
                  backfaceVisibility: 'hidden',
                }}
                onClick={(event) => snapFromFaceClick(face, event)}
                onMouseMove={(event) => updateHoverTarget(face, event)}
                onMouseLeave={clearHoverTarget}
              >
                <span className="pointer-events-none absolute inset-[8px] rounded-sm bg-white/70" />
                <span className="pointer-events-none relative z-10">{faceLabels[face]}</span>
                {hoverMarkerStyle && (
                  <span
                    className="pointer-events-none absolute z-20 rounded-sm bg-liclick-pink shadow-[0_0_12px_rgba(255,98,210,0.92)]"
                    data-testid={
                      hoverEdges.length === 2 ? 'view-cube-hover-vertex' : 'view-cube-hover-edge'
                    }
                    style={hoverMarkerStyle}
                  />
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
