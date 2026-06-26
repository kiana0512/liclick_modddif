import { Canvas, useThree } from '@react-three/fiber';
import { Suspense, useEffect, useRef, useState, type DragEvent, type PointerEvent, type WheelEvent } from 'react';
import * as THREE from 'three';
import { useDragInteractionStore } from '@/stores/dragInteractionStore';
import { useSceneStore } from '@/stores/sceneStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { SceneRoot } from './SceneRoot';
import { CameraController } from './CameraController';
import { ViewCube } from './ViewCube';

type ViewportCanvasProps = {
  hasImportedModel: boolean;
  onImportModel: (file: File) => void;
  onImportReferenceImages: (files: File[]) => void;
  onOpenImport: () => void;
};

const MODEL_FILE_EXTENSIONS = new Set(['glb', 'gltf', 'fbx', 'obj', 'stl']);
const IMAGE_FILE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp']);

function RendererSettings() {
  const { gl } = useThree();
  const exposure = useSettingsStore((state) => state.exposure);

  useEffect(() => {
    gl.outputColorSpace = THREE.SRGBColorSpace;
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = exposure;
  }, [exposure, gl]);

  return null;
}

function getFileExtension(file: File) {
  return file.name.split('.').pop()?.toLowerCase();
}

function getDragPayload(event: DragEvent<HTMLDivElement>) {
  const files = Array.from(event.dataTransfer.files);
  const modelFile = files.find((file) => {
    const extension = getFileExtension(file);
    return Boolean(extension && MODEL_FILE_EXTENSIONS.has(extension));
  });
  const imageFiles = files.filter((file) => {
    const extension = getFileExtension(file);
    if (extension && IMAGE_FILE_EXTENSIONS.has(extension)) return true;
    return file.type.startsWith('image/');
  });
  return {
    modelFile,
    imageFiles,
    dragType: modelFile ? 'model-file' : imageFiles.length > 0 ? 'asset-file' : undefined,
  } as const;
}

function PaintMaskOverlay() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isPaintingRef = useRef(false);
  const paintTool = useSceneStore((state) => state.paintTool);
  const markPaintMaskChanged = useSceneStore((state) => state.markPaintMaskChanged);
  const enabled = paintTool !== 'none';

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      const previous = document.createElement('canvas');
      previous.width = canvas.width;
      previous.height = canvas.height;
      previous.getContext('2d')?.drawImage(canvas, 0, 0);
      canvas.width = Math.max(1, Math.round(rect.width * ratio));
      canvas.height = Math.max(1, Math.round(rect.height * ratio));
      canvas.getContext('2d')?.drawImage(previous, 0, 0, canvas.width, canvas.height);
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  function paint(event: PointerEvent<HTMLCanvasElement>) {
    if (!enabled) return;
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = canvas.width / rect.width;
    const x = (event.clientX - rect.left) * ratio;
    const y = (event.clientY - rect.top) * ratio;
    context.globalCompositeOperation = paintTool === 'eraser' ? 'destination-out' : 'source-over';
    context.fillStyle = 'rgba(238, 77, 214, 0.38)';
    context.beginPath();
    context.arc(x, y, 18 * ratio, 0, Math.PI * 2);
    context.fill();
  }

  return (
    <canvas
      ref={canvasRef}
      className={enabled ? 'absolute inset-0 z-10 cursor-crosshair' : 'pointer-events-none absolute inset-0 z-10'}
      onPointerDown={(event) => {
        if (!enabled) return;
        isPaintingRef.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        paint(event);
      }}
      onPointerMove={(event) => {
        if (!isPaintingRef.current) return;
        paint(event);
      }}
      onPointerUp={(event) => {
        if (!isPaintingRef.current) return;
        isPaintingRef.current = false;
        event.currentTarget.releasePointerCapture(event.pointerId);
        markPaintMaskChanged();
      }}
      onPointerCancel={() => {
        isPaintingRef.current = false;
      }}
    />
  );
}

export function ViewportCanvas({
  hasImportedModel,
  onImportModel,
  onImportReferenceImages,
  onOpenImport,
}: ViewportCanvasProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [captureFrameVisible, setCaptureFrameVisible] = useState(false);
  const [canvasKey, setCanvasKey] = useState(0);
  const [viewportIssue, setViewportIssue] = useState<string>();
  const recoveryAttemptsRef = useRef(0);
  const captureFrameTimerRef = useRef<number>();
  const activeDragType = useDragInteractionStore((state) => state.activeDragType);
  const startFileDrag = useDragInteractionStore((state) => state.startFileDrag);
  const clearDrag = useDragInteractionStore((state) => state.clearDrag);
  const exposure = useSettingsStore((state) => state.exposure);

  useEffect(() => () => window.clearTimeout(captureFrameTimerRef.current), []);

  function pulseCaptureFrame() {
    setCaptureFrameVisible(true);
    window.clearTimeout(captureFrameTimerRef.current);
    captureFrameTimerRef.current = window.setTimeout(() => {
      setCaptureFrameVisible(false);
    }, 1800);
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    if (event.buttons === 0) return;
    pulseCaptureFrame();
  }

  function handleWheel(event: WheelEvent<HTMLDivElement>) {
    if (event.deltaX === 0 && event.deltaY === 0 && event.deltaZ === 0) return;
    pulseCaptureFrame();
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    if (activeDragType === 'panel') {
      clearDrag();
      return;
    }
    const payload = getDragPayload(event);
    if (payload.modelFile) {
      onImportModel(payload.modelFile);
      clearDrag();
      return;
    }
    if (payload.imageFiles.length > 0) onImportReferenceImages(payload.imageFiles);
    clearDrag();
  }

  return (
    <div
      className="relative h-full w-full bg-[#080914]"
      onPointerDownCapture={pulseCaptureFrame}
      onPointerMoveCapture={handlePointerMove}
      onWheelCapture={handleWheel}
      onDragOver={(event) => {
        if (activeDragType === 'panel') return;
        event.preventDefault();
        const payload = getDragPayload(event);
        if (!payload.dragType) return;
        startFileDrag(payload.dragType);
        setIsDragging(true);
      }}
      onDragLeave={() => {
        setIsDragging(false);
        if (activeDragType !== 'panel') clearDrag();
      }}
      onDrop={handleDrop}
    >
      <Canvas
        key={canvasKey}
        dpr={[1, 1.5]}
        camera={{ position: [3.2, 2.4, 4], fov: 45, near: 0.1, far: 100 }}
        gl={{
          preserveDrawingBuffer: false,
          powerPreference: 'high-performance',
          outputColorSpace: THREE.SRGBColorSpace,
          toneMapping: THREE.ACESFilmicToneMapping,
          toneMappingExposure: exposure,
        }}
        onCreated={({ gl }) => {
          gl.outputColorSpace = THREE.SRGBColorSpace;
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          gl.toneMappingExposure = exposure;
          setViewportIssue(undefined);
          recoveryAttemptsRef.current = 0;
          const canvas = gl.domElement;
          const handleContextLost = (event: Event) => {
            event.preventDefault();
            recoveryAttemptsRef.current += 1;
            if (recoveryAttemptsRef.current <= 2) {
              window.setTimeout(() => setCanvasKey((key) => key + 1), 250);
              return;
            }
            setViewportIssue('WebGL 渲染上下文已中断。已尝试自动恢复，当前项目数据仍然保留。');
          };
          const handleContextRestored = () => {
            setViewportIssue(undefined);
            setCanvasKey((key) => key + 1);
          };
          canvas.addEventListener('webglcontextlost', handleContextLost);
          canvas.addEventListener('webglcontextrestored', handleContextRestored);
        }}
        onError={(error) => {
          console.error('[Liclick 3D Texture] Viewport renderer failed:', error);
          setViewportIssue(error instanceof Error ? error.message : '视口渲染失败。');
        }}
      >
        <color attach="background" args={['#080914']} />
        <Suspense fallback={null}>
          <RendererSettings />
          <SceneRoot />
        </Suspense>
        <CameraController />
      </Canvas>
      <div
        className={`pointer-events-none absolute left-1/2 top-1/2 z-20 h-[82%] w-[72%] max-w-[1280px] -translate-x-1/2 -translate-y-1/2 rounded-[18px] border-[3px] border-dashed border-[#d9795c]/75 shadow-[0_0_0_1px_rgba(217,121,92,0.12)] transition-opacity duration-300 ${
          captureFrameVisible ? 'opacity-100' : 'opacity-0'
        }`}
        aria-hidden="true"
      />
      {viewportIssue && (
        <div className="absolute inset-0 z-30 grid place-items-center bg-[#080914]/86 px-5 text-white backdrop-blur-sm">
          <div className="grid max-w-[420px] gap-3 rounded-lg border border-white/14 bg-black/50 p-4 text-center shadow-2xl">
            <div className="text-sm font-semibold">视口需要恢复</div>
            <div className="text-xs leading-5 text-white/66">{viewportIssue}</div>
            <button
              type="button"
              className="mx-auto h-9 rounded-md bg-white px-4 text-xs font-semibold text-black transition hover:bg-white/90"
              onClick={() => {
                setViewportIssue(undefined);
                setCanvasKey((key) => key + 1);
              }}
            >
              重新加载视口
            </button>
          </div>
        </div>
      )}
      <PaintMaskOverlay />
      <ViewCube />
      {!hasImportedModel && (
        <button
          type="button"
          onClick={onOpenImport}
          className="absolute bottom-4 left-4 rounded-md border border-white/10 bg-black/42 px-3 py-2 text-xs text-white/66 backdrop-blur transition hover:bg-white/10 hover:text-white"
        >
          Drop GLB here / Import Model
        </button>
      )}
      {isDragging && activeDragType === 'model-file' && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center border-2 border-dashed border-liclick-pink bg-liclick-purple/18 text-lg font-semibold text-white backdrop-blur-sm">
          Drop model to import
        </div>
      )}
      {isDragging && activeDragType === 'asset-file' && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center border-2 border-dashed border-liclick-pink bg-liclick-purple/18 text-lg font-semibold text-white backdrop-blur-sm">
          Drop image to add reference
        </div>
      )}
    </div>
  );
}
