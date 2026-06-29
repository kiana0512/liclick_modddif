import { Canvas, useThree } from '@react-three/fiber';
import { Suspense, useCallback, useEffect, useRef, useState, type DragEvent, type PointerEvent, type WheelEvent } from 'react';
import * as THREE from 'three';
import { useDragInteractionStore } from '@/stores/dragInteractionStore';
import { useEditorHistoryStore } from '@/stores/editorHistoryStore';
import { useLayerStore } from '@/stores/layerStore';
import { useSceneStore } from '@/stores/sceneStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useToastStore } from '@/stores/toastStore';
import { useT } from '@/stores/i18nStore';
import { useWorkspaceLayoutStore } from '@/components/workspace/workspaceLayoutStore';
import { SceneRoot } from './SceneRoot';
import { CameraController } from './CameraController';
import { ViewCube } from './ViewCube';

type SurfacePaintTarget = {
  objectId: string;
  group: THREE.Object3D;
  boundingSize: THREE.Vector3;
};

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

const UV_PAINT_RESOLUTION = 1024;
type UvPaintLayer = {
  objectId: string;
  paintCanvas: HTMLCanvasElement;
  paintContext: CanvasRenderingContext2D;
  paintTexture: THREE.CanvasTexture;
  maskCanvas: HTMLCanvasElement;
  maskContext: CanvasRenderingContext2D;
  maskPattern: CanvasPattern;
  maskTexture: THREE.CanvasTexture;
  paintMaterial: THREE.MeshBasicMaterial;
  maskMaterial: THREE.MeshBasicMaterial;
  overlayMeshes: THREE.Mesh[];
  overlayTargets: Set<THREE.Mesh>;
};

type UvPaintHit = {
  model: SurfacePaintTarget;
  hit: THREE.Intersection<THREE.Object3D>;
  uv: THREE.Vector2;
  worldRadius: number;
  textureRadius: number;
};

type PaintDirtyRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type PaintStrokeDraft = {
  layer: UvPaintLayer;
  target: 'paint' | 'mask';
  beforeCanvas: HTMLCanvasElement;
  beforeMaskHasContent: boolean;
  bounds?: PaintDirtyRect;
};

type PaintableMeshCache = {
  objectId: string;
  groupUuid: string;
  meshes: THREE.Mesh[];
};

function createPaintCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = UV_PAINT_RESOLUTION;
  canvas.height = UV_PAINT_RESOLUTION;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Could not create UV paint canvas.');
  return { canvas, context };
}

function createInpaintMaskPattern(context: CanvasRenderingContext2D) {
  const patternCanvas = document.createElement('canvas');
  patternCanvas.width = 18;
  patternCanvas.height = 18;
  const patternContext = patternCanvas.getContext('2d');
  if (!patternContext) throw new Error('Could not create UV mask pattern.');
  patternContext.fillStyle = 'rgba(238, 104, 72, 0.72)';
  patternContext.fillRect(0, 0, patternCanvas.width, patternCanvas.height);
  patternContext.strokeStyle = 'rgba(24, 20, 18, 0.78)';
  patternContext.lineWidth = 5;
  patternContext.beginPath();
  patternContext.moveTo(-6, 18);
  patternContext.lineTo(18, -6);
  patternContext.moveTo(0, 24);
  patternContext.lineTo(24, 0);
  patternContext.stroke();
  const pattern = context.createPattern(patternCanvas, 'repeat');
  if (!pattern) throw new Error('Could not create UV mask brush pattern.');
  return pattern;
}

function configureCanvasTexture(texture: THREE.CanvasTexture, colorSpace: THREE.ColorSpace) {
  texture.colorSpace = colorSpace;
  texture.flipY = false;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
}

function disposeUvPaintLayer(layer?: UvPaintLayer) {
  if (!layer) return;
  layer.overlayMeshes.forEach((mesh) => mesh.removeFromParent());
  layer.paintTexture.dispose();
  layer.maskTexture.dispose();
  layer.paintMaterial.dispose();
  layer.maskMaterial.dispose();
}

function hasCanvasAlpha(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D) {
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let index = 3; index < data.length; index += 4) {
    if (data[index] > 0) return true;
  }
  return false;
}

function unionDirtyRect(a: PaintDirtyRect | undefined, b: PaintDirtyRect): PaintDirtyRect {
  if (!a) return b;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}

function createDirtyRect(fromX: number, fromY: number, toX: number, toY: number, radius: number): PaintDirtyRect {
  const padding = Math.ceil(radius + 3);
  const x = Math.max(0, Math.floor(Math.min(fromX, toX) - padding));
  const y = Math.max(0, Math.floor(Math.min(fromY, toY) - padding));
  const right = Math.min(UV_PAINT_RESOLUTION, Math.ceil(Math.max(fromX, toX) + padding));
  const bottom = Math.min(UV_PAINT_RESOLUTION, Math.ceil(Math.max(fromY, toY) + padding));
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

function SurfacePaintOverlay() {
  const { gl, camera, scene } = useThree();
  const cursorRef = useRef<THREE.Mesh>(null);
  const layerRef = useRef<UvPaintLayer>();
  const paintableMeshCacheRef = useRef<PaintableMeshCache>();
  const raycasterRef = useRef(new THREE.Raycaster());
  const pointerRef = useRef(new THREE.Vector2());
  const isPaintingRef = useRef(false);
  const lastUvRef = useRef<THREE.Vector2>();
  const strokeDraftRef = useRef<PaintStrokeDraft>();
  const dirtyTexturesRef = useRef(new Set<THREE.CanvasTexture>());
  const textureUpdateFrameRef = useRef<number>();
  const maskDirtyRef = useRef(false);
  const maskHasContentRef = useRef(false);
  const paintTool = useSceneStore((state) => state.paintTool);
  const paintMaskResetRevision = useSceneStore((state) => state.paintMaskResetRevision);
  const paintMaskSettings = useSceneStore((state) => state.paintMaskSettings);
  const paintToolSettings = useSceneStore((state) => state.paintToolSettings);
  const setPaintMaskDataUrl = useSceneStore((state) => state.setPaintMaskDataUrl);
  const setOrbitControlsEnabled = useSceneStore((state) => state.setOrbitControlsEnabled);
  const captureRuntimeHistory = useEditorHistoryStore((state) => state.captureRuntime);
  const importedModel = useSceneStore((state) => state.importedModel);
  const selectedObjectId = useSceneStore((state) => state.selectedObjectId);
  const layers = useLayerStore((state) => state.layers);
  const activeProjectedLayerId = useLayerStore((state) => state.activeProjectedLayerId);
  const pushToast = useToastStore((state) => state.pushToast);
  const showPanel = useWorkspaceLayoutStore((state) => state.showPanel);
  const setPanelCollapsed = useWorkspaceLayoutStore((state) => state.setPanelCollapsed);
  const t = useT();
  const isInpaintMode = paintTool === 'inpaint-add' || paintTool === 'inpaint-subtract';
  const enabled = paintTool === 'brush' || paintTool === 'eraser' || isInpaintMode;
  const activePaintLayer = layers.find(
    (layer) =>
      layer.id === activeProjectedLayerId &&
      layer.type === 'projected' &&
      layer.visible &&
      (!layer.objectId || layer.objectId === selectedObjectId),
  );
  const texturePaintReady = Boolean(activePaintLayer);

  const getTargetModel = useCallback((): SurfacePaintTarget | undefined => {
    if (importedModel && (!selectedObjectId || selectedObjectId === importedModel.objectId)) {
      return {
        objectId: importedModel.objectId,
        group: importedModel.group,
        boundingSize: new THREE.Vector3().fromArray(importedModel.boundingBox.size),
      };
    }
    let target: THREE.Object3D | undefined;
    scene.traverse((object) => {
      if (target) return;
      const objectId = object.userData.liclickObjectId;
      if (typeof objectId !== 'string') return;
      if (selectedObjectId && objectId !== selectedObjectId) return;
      if (object instanceof THREE.Group || object.children.length > 0) target = object;
    });
    if (!target) {
      scene.traverse((object) => {
        if (target) return;
        if (object instanceof THREE.Group && object.userData.liclickObjectId) target = object;
      });
    }
    if (!target) return undefined;
    const box = new THREE.Box3().setFromObject(target);
    const size = new THREE.Vector3();
    box.getSize(size);
    return {
      objectId: String(target.userData.liclickObjectId ?? selectedObjectId ?? 'surface-object'),
      group: target,
      boundingSize: size,
    };
  }, [importedModel, scene, selectedObjectId]);

  const getPaintableMeshes = useCallback((model: SurfacePaintTarget) => {
    const cached = paintableMeshCacheRef.current;
    if (cached?.objectId === model.objectId && cached.groupUuid === model.group.uuid) return cached.meshes;

    const meshes: THREE.Mesh[] = [];
    model.group.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      if (child.userData.liclickPaintOverlay) return;
      if (!child.geometry.getAttribute('uv')) return;
      meshes.push(child);
    });
    paintableMeshCacheRef.current = { objectId: model.objectId, groupUuid: model.group.uuid, meshes };
    return meshes;
  }, []);

  const getUvPaintLayer = useCallback((model: SurfacePaintTarget) => {
    if (layerRef.current?.objectId === model.objectId) return layerRef.current;
    disposeUvPaintLayer(layerRef.current);

    const paint = createPaintCanvas();
    const mask = createPaintCanvas();
    const maskPattern = createInpaintMaskPattern(mask.context);
    const paintTexture = new THREE.CanvasTexture(paint.canvas);
    const maskTexture = new THREE.CanvasTexture(mask.canvas);
    configureCanvasTexture(paintTexture, THREE.SRGBColorSpace);
    configureCanvasTexture(maskTexture, THREE.NoColorSpace);

    const paintMaterial = new THREE.MeshBasicMaterial({
      map: paintTexture,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      polygonOffset: true,
      polygonOffsetFactor: -6,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const maskMaterial = new THREE.MeshBasicMaterial({
      map: maskTexture,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      polygonOffset: true,
      polygonOffsetFactor: -8,
      side: THREE.DoubleSide,
      toneMapped: false,
    });

    layerRef.current = {
      objectId: model.objectId,
      paintCanvas: paint.canvas,
      paintContext: paint.context,
      paintTexture,
      maskCanvas: mask.canvas,
      maskContext: mask.context,
      maskPattern,
      maskTexture,
      paintMaterial,
      maskMaterial,
      overlayMeshes: [],
      overlayTargets: new Set(),
    };
    return layerRef.current;
  }, []);

  const ensureOverlayForMesh = useCallback((layer: UvPaintLayer, mesh: THREE.Mesh) => {
    if (layer.overlayTargets.has(mesh)) return;
    layer.overlayTargets.add(mesh);

    const paintOverlay = new THREE.Mesh(mesh.geometry, layer.paintMaterial);
    paintOverlay.name = 'Liclick UV Paint Overlay';
    paintOverlay.userData.liclickPaintOverlay = true;
    paintOverlay.renderOrder = 30;
    mesh.add(paintOverlay);
    layer.overlayMeshes.push(paintOverlay);

    const maskOverlay = new THREE.Mesh(mesh.geometry, layer.maskMaterial);
    maskOverlay.name = 'Liclick UV Inpaint Mask Overlay';
    maskOverlay.userData.liclickPaintOverlay = true;
    maskOverlay.renderOrder = 31;
    mesh.add(maskOverlay);
    layer.overlayMeshes.push(maskOverlay);
  }, []);

  useEffect(() => () => disposeUvPaintLayer(layerRef.current), []);

  const scheduleTextureUpdate = useCallback((texture: THREE.CanvasTexture) => {
    dirtyTexturesRef.current.add(texture);
    if (textureUpdateFrameRef.current !== undefined) return;
    textureUpdateFrameRef.current = window.requestAnimationFrame(() => {
      textureUpdateFrameRef.current = undefined;
      dirtyTexturesRef.current.forEach((dirtyTexture) => {
        dirtyTexture.needsUpdate = true;
      });
      dirtyTexturesRef.current.clear();
    });
  }, []);

  useEffect(() => () => {
    if (textureUpdateFrameRef.current !== undefined) window.cancelAnimationFrame(textureUpdateFrameRef.current);
  }, []);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    layer.maskContext.clearRect(0, 0, layer.maskCanvas.width, layer.maskCanvas.height);
    scheduleTextureUpdate(layer.maskTexture);
    maskDirtyRef.current = false;
    maskHasContentRef.current = false;
  }, [paintMaskResetRevision, scheduleTextureUpdate]);

  const getBrushWorldRadius = useCallback((model: SurfacePaintTarget) => {
    const maxDimension = Math.max(model.boundingSize.x, model.boundingSize.y, model.boundingSize.z, 1);
    const setting =
      paintTool === 'brush'
        ? paintToolSettings.brushSize
        : paintTool === 'eraser'
          ? paintToolSettings.eraserSize
          : paintMaskSettings.brushSize;
    const worldScale = paintTool === 'inpaint-add' || paintTool === 'inpaint-subtract' ? 0.3 : 0.45;
    return THREE.MathUtils.clamp((maxDimension * setting * worldScale) / 700, maxDimension * 0.004, maxDimension * 0.18);
  }, [paintMaskSettings.brushSize, paintTool, paintToolSettings.brushSize, paintToolSettings.eraserSize]);

  const getBrushTextureRadius = useCallback(() => {
    const setting =
      paintTool === 'brush'
        ? paintToolSettings.brushSize
        : paintTool === 'eraser'
          ? paintToolSettings.eraserSize
          : paintMaskSettings.brushSize;
    return THREE.MathUtils.clamp(setting * 0.45, 1.5, 96);
  }, [paintMaskSettings.brushSize, paintTool, paintToolSettings.brushSize, paintToolSettings.eraserSize]);

  const raycastModel = useCallback((event: globalThis.PointerEvent): UvPaintHit | undefined => {
    const model = getTargetModel();
    if (!model) return undefined;
    const rect = gl.domElement.getBoundingClientRect();
    pointerRef.current.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -(((event.clientY - rect.top) / rect.height) * 2 - 1),
    );
    raycasterRef.current.setFromCamera(pointerRef.current, camera);
    const hit = raycasterRef.current.intersectObjects(getPaintableMeshes(model), false)[0];
    if (!hit || !(hit.object instanceof THREE.Mesh) || !hit.face || !hit.uv) return undefined;
    return {
      model,
      hit,
      uv: hit.uv.clone(),
      worldRadius: getBrushWorldRadius(model),
      textureRadius: getBrushTextureRadius(),
    };
  }, [camera, getBrushTextureRadius, getBrushWorldRadius, getPaintableMeshes, getTargetModel, gl.domElement]);

  const warnMissingPaintLayer = useCallback(() => {
    showPanel('layers');
    setPanelCollapsed('layers', false);
    pushToast({
      tone: 'warning',
      title: t('paintLayerMissing'),
      description: t('paintLayerMissingHelp'),
      dedupeKey: 'paint-layer-missing',
    });
  }, [pushToast, setPanelCollapsed, showPanel, t]);

  const getCursorColor = useCallback(() => {
    if (paintTool === 'eraser') return '#ffffff';
    if (isInpaintMode) return '#ff8a68';
    return paintToolSettings.color;
  }, [isInpaintMode, paintTool, paintToolSettings.color]);

  const updateCursor = useCallback((event: globalThis.PointerEvent) => {
    const canPreviewBrush = enabled && (isInpaintMode || texturePaintReady);
    const result = canPreviewBrush ? raycastModel(event) : undefined;
    const cursor = cursorRef.current;
    if (!cursor) return result;
    if (!result) {
      cursor.visible = false;
      gl.domElement.style.cursor = enabled ? 'default' : '';
      return undefined;
    }
    const worldNormal = result.hit.face?.normal.clone() ?? new THREE.Vector3(0, 1, 0);
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(result.hit.object.matrixWorld);
    worldNormal.applyMatrix3(normalMatrix).normalize();
    const localPoint = result.model.group.worldToLocal(
      result.hit.point.clone().add(worldNormal.clone().multiplyScalar(result.worldRadius * 0.025)),
    );
    const localNormal = result.model.group.worldToLocal(result.hit.point.clone().add(worldNormal))
      .sub(result.model.group.worldToLocal(result.hit.point.clone()))
      .normalize();
    const worldScale = new THREE.Vector3();
    result.model.group.getWorldScale(worldScale);
    result.model.group.attach(cursor);
    cursor.position.copy(localPoint);
    cursor.quaternion.copy(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), localNormal));
    cursor.scale.setScalar(result.worldRadius / Math.max(worldScale.x, worldScale.y, worldScale.z, 0.0001));
    if (cursor.material instanceof THREE.MeshBasicMaterial) cursor.material.color.set(getCursorColor());
    cursor.visible = true;
    gl.domElement.style.cursor = 'none';
    return result;
  }, [enabled, getCursorColor, gl.domElement, isInpaintMode, raycastModel, texturePaintReady]);

  const drawBrushSegment = useCallback((
    context: CanvasRenderingContext2D,
    texture: THREE.CanvasTexture,
    fromUv: THREE.Vector2 | undefined,
    toUv: THREE.Vector2,
    radius: number,
    color: string | CanvasPattern,
    compositeOperation: GlobalCompositeOperation,
    hardness: number,
  ) => {
    const targetUvX = THREE.MathUtils.euclideanModulo(toUv.x, 1);
    const targetUvY = THREE.MathUtils.euclideanModulo(toUv.y, 1);
    const sourceUvX = fromUv ? THREE.MathUtils.euclideanModulo(fromUv.x, 1) : targetUvX;
    const sourceUvY = fromUv ? THREE.MathUtils.euclideanModulo(fromUv.y, 1) : targetUvY;
    const toX = targetUvX * UV_PAINT_RESOLUTION;
    const toY = targetUvY * UV_PAINT_RESOLUTION;
    const fromX = sourceUvX * UV_PAINT_RESOLUTION;
    const fromY = sourceUvY * UV_PAINT_RESOLUTION;
    const bounds = createDirtyRect(fromX, fromY, toX, toY, radius);
    const softness = 1 - THREE.MathUtils.clamp(hardness / 100, 0, 1);
    const innerRadius = Math.max(1, radius * (1 - softness * 0.55));

    context.save();
    context.globalCompositeOperation = compositeOperation;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    if (softness > 0.02) {
      context.globalAlpha = Math.max(0.18, 1 - softness * 0.68);
      context.strokeStyle = color;
      context.lineWidth = radius * 2;
      context.beginPath();
      context.moveTo(fromX, fromY);
      context.lineTo(toX, toY);
      context.stroke();
    }
    context.globalAlpha = 1;
    context.strokeStyle = color;
    context.lineWidth = innerRadius * 2;
    context.beginPath();
    context.moveTo(fromX, fromY);
    context.lineTo(toX, toY);
    context.stroke();
    context.restore();
    scheduleTextureUpdate(texture);
    return bounds;
  }, [scheduleTextureUpdate]);

  const paintAt = useCallback((result: UvPaintHit) => {
    const layer = getUvPaintLayer(result.model);
    if (result.hit.object instanceof THREE.Mesh) ensureOverlayForMesh(layer, result.hit.object);
    const lastUv = lastUvRef.current;
    const uvDistance = lastUv?.distanceTo(result.uv) ?? 0;
    const fromUv = uvDistance > 0.18 ? undefined : lastUv;

    if (paintTool === 'brush') {
      const bounds = drawBrushSegment(
        layer.paintContext,
        layer.paintTexture,
        fromUv,
        result.uv,
        result.textureRadius,
        paintToolSettings.color,
        'source-over',
        paintToolSettings.brushHardness,
      );
      if (strokeDraftRef.current?.target === 'paint') {
        strokeDraftRef.current.bounds = unionDirtyRect(strokeDraftRef.current.bounds, bounds);
      }
    } else if (paintTool === 'eraser') {
      const bounds = drawBrushSegment(
        layer.paintContext,
        layer.paintTexture,
        fromUv,
        result.uv,
        result.textureRadius,
        '#000000',
        'destination-out',
        paintToolSettings.eraserHardness,
      );
      if (strokeDraftRef.current?.target === 'paint') {
        strokeDraftRef.current.bounds = unionDirtyRect(strokeDraftRef.current.bounds, bounds);
      }
    } else if (paintTool === 'inpaint-add') {
      const bounds = drawBrushSegment(
        layer.maskContext,
        layer.maskTexture,
        fromUv,
        result.uv,
        result.textureRadius,
        layer.maskPattern,
        'source-over',
        paintMaskSettings.brushHardness,
      );
      if (strokeDraftRef.current?.target === 'mask') {
        strokeDraftRef.current.bounds = unionDirtyRect(strokeDraftRef.current.bounds, bounds);
      }
      maskDirtyRef.current = true;
      maskHasContentRef.current = true;
    } else if (paintTool === 'inpaint-subtract') {
      const bounds = drawBrushSegment(
        layer.maskContext,
        layer.maskTexture,
        fromUv,
        result.uv,
        result.textureRadius,
        '#000000',
        'destination-out',
        paintMaskSettings.brushHardness,
      );
      if (strokeDraftRef.current?.target === 'mask') {
        strokeDraftRef.current.bounds = unionDirtyRect(strokeDraftRef.current.bounds, bounds);
      }
      maskDirtyRef.current = true;
    }

    lastUvRef.current = result.uv.clone();
  }, [
    drawBrushSegment,
    ensureOverlayForMesh,
    getUvPaintLayer,
    paintMaskSettings.brushHardness,
    paintTool,
    paintToolSettings.brushHardness,
    paintToolSettings.color,
    paintToolSettings.eraserHardness,
  ]);

  const commitMaskIfDirty = useCallback(() => {
    if (!maskDirtyRef.current) return;
    maskDirtyRef.current = false;
    setPaintMaskDataUrl(undefined, maskHasContentRef.current);
  }, [setPaintMaskDataUrl]);

  const beginStrokeHistory = useCallback((result: UvPaintHit) => {
    const layer = getUvPaintLayer(result.model);
    const target = isInpaintMode ? 'mask' : 'paint';
    const sourceCanvas = target === 'mask' ? layer.maskCanvas : layer.paintCanvas;
    const beforeCanvas = document.createElement('canvas');
    beforeCanvas.width = sourceCanvas.width;
    beforeCanvas.height = sourceCanvas.height;
    beforeCanvas.getContext('2d')?.drawImage(sourceCanvas, 0, 0);
    strokeDraftRef.current = { layer, target, beforeCanvas, beforeMaskHasContent: maskHasContentRef.current };
  }, [getUvPaintLayer, isInpaintMode]);

  const commitStrokeHistory = useCallback(() => {
    const draft = strokeDraftRef.current;
    strokeDraftRef.current = undefined;
    if (!draft?.bounds) return;

    const targetCanvas = draft.target === 'mask' ? draft.layer.maskCanvas : draft.layer.paintCanvas;
    const targetContext = draft.target === 'mask' ? draft.layer.maskContext : draft.layer.paintContext;
    const targetTexture = draft.target === 'mask' ? draft.layer.maskTexture : draft.layer.paintTexture;
    const beforeContext = draft.beforeCanvas.getContext('2d', { willReadFrequently: true });
    if (!beforeContext) return;

    const { x, y, width, height } = draft.bounds;
    const beforeImageData = beforeContext.getImageData(x, y, width, height);
    const afterImageData = targetContext.getImageData(x, y, width, height);
    const beforeMaskHasContent = draft.beforeMaskHasContent;
    const afterMaskHasContent =
      draft.target === 'mask'
        ? paintTool === 'inpaint-add'
          ? true
          : hasCanvasAlpha(targetCanvas, targetContext)
        : maskHasContentRef.current;

    if (draft.target === 'mask') maskHasContentRef.current = afterMaskHasContent;

    captureRuntimeHistory({
      undo: () => {
        targetContext.putImageData(beforeImageData, x, y);
        scheduleTextureUpdate(targetTexture);
        if (draft.target === 'mask') {
          maskHasContentRef.current = beforeMaskHasContent;
          setPaintMaskDataUrl(undefined, beforeMaskHasContent);
        }
      },
      redo: () => {
        targetContext.putImageData(afterImageData, x, y);
        scheduleTextureUpdate(targetTexture);
        if (draft.target === 'mask') {
          maskHasContentRef.current = afterMaskHasContent;
          setPaintMaskDataUrl(undefined, afterMaskHasContent);
        }
      },
    });
  }, [captureRuntimeHistory, paintTool, scheduleTextureUpdate, setPaintMaskDataUrl]);

  useEffect(() => {
    const canvas = gl.domElement;
    const cursorMesh = cursorRef.current;
    const handlePointerMove = (event: globalThis.PointerEvent) => {
      const result = updateCursor(event);
      if (isPaintingRef.current && result) {
        event.preventDefault();
        event.stopPropagation();
        paintAt(result);
      }
    };
    const handlePointerDown = (event: globalThis.PointerEvent) => {
      if (!enabled || event.button !== 0) return;
      if (!isInpaintMode && !texturePaintReady) {
        const result = raycastModel(event);
        if (!result) return;
        event.preventDefault();
        event.stopPropagation();
        warnMissingPaintLayer();
        return;
      }
      const result = updateCursor(event);
      if (!result) return;
      event.preventDefault();
      event.stopPropagation();
      isPaintingRef.current = true;
      lastUvRef.current = undefined;
      beginStrokeHistory(result);
      setOrbitControlsEnabled(false);
      paintAt(result);
    };
    const handlePointerUp = () => {
      if (!isPaintingRef.current) return;
      isPaintingRef.current = false;
      lastUvRef.current = undefined;
      setOrbitControlsEnabled(true);
      commitStrokeHistory();
      commitMaskIfDirty();
    };
    const handlePointerLeave = () => {
      if (cursorMesh) cursorMesh.visible = false;
      if (!isPaintingRef.current) gl.domElement.style.cursor = '';
    };
    canvas.addEventListener('pointermove', handlePointerMove, true);
    canvas.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('pointerup', handlePointerUp, true);
    canvas.addEventListener('pointerleave', handlePointerLeave);
    return () => {
      canvas.removeEventListener('pointermove', handlePointerMove, true);
      canvas.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('pointerup', handlePointerUp, true);
      canvas.removeEventListener('pointerleave', handlePointerLeave);
      if (cursorMesh) cursorMesh.visible = false;
      if (isPaintingRef.current) {
        isPaintingRef.current = false;
        setOrbitControlsEnabled(true);
        commitStrokeHistory();
        commitMaskIfDirty();
      }
      gl.domElement.style.cursor = '';
    };
  }, [
    commitMaskIfDirty,
    beginStrokeHistory,
    commitStrokeHistory,
    enabled,
    gl,
    isInpaintMode,
    paintAt,
    raycastModel,
    setOrbitControlsEnabled,
    texturePaintReady,
    updateCursor,
    warnMissingPaintLayer,
  ]);

  return (
    <mesh ref={cursorRef} visible={false} userData={{ liclickPaintOverlay: true }}>
      <ringGeometry args={[0.84, 1, 64]} />
      <meshBasicMaterial color="#ffffff" depthTest={false} depthWrite={false} transparent opacity={0.96} side={THREE.DoubleSide} />
    </mesh>
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
  const t = useT();

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
          alpha: true,
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
            setViewportIssue(t('viewportContextLostHelp'));
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
          <SurfacePaintOverlay />
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
            <div className="text-sm font-semibold">{t('viewportNeedsRestore')}</div>
            <div className="text-xs leading-5 text-white/66">{viewportIssue}</div>
            <button
              type="button"
              className="mx-auto h-9 rounded-md bg-white px-4 text-xs font-semibold text-black transition hover:bg-white/90"
              onClick={() => {
                setViewportIssue(undefined);
                setCanvasKey((key) => key + 1);
              }}
            >
              {t('reloadViewport')}
            </button>
          </div>
        </div>
      )}
      <ViewCube />
      {!hasImportedModel && (
        <button
          type="button"
          onClick={onOpenImport}
          className="absolute bottom-4 left-4 rounded-md border border-white/10 bg-black/42 px-3 py-2 text-xs text-white/66 backdrop-blur transition hover:bg-white/10 hover:text-white"
        >
          {t('dropModelImport')}
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
