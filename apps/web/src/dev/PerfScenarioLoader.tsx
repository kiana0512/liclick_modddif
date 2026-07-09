import { useEffect } from 'react';
import * as THREE from 'three';
import { useLayerStore } from '@/stores/layerStore';
import { useProjectStore } from '@/stores/projectStore';
import { useSceneStore } from '@/stores/sceneStore';
import type { ModelLoadResult } from '@/engine/loaders/modelImportTypes';
import type { BakedTexture } from '@/engine/bake/uvBakeTypes';
import type { SerializedCamera } from '@/types/capture';
import type { Layer } from '@/types/layer';
import type { ModelBoundingBox, SceneObject, Transform } from '@/types/model';
import type { Project } from '@/types/project';

type PerfScenario = '100-models' | '100-layers' | '100-layers-unbaked';

type PerfMetrics = {
  scenario: PerfScenario;
  startedAt: number;
  setupMs: number;
  sampledFrames: number;
  averageFrameMs: number;
  p95FrameMs: number;
  maxFrameMs: number;
  fps: number;
  fallbackTicks: number;
};

declare global {
  interface Window {
    __liclickPerfMetrics?: PerfMetrics;
  }
}

const objectTransform: Transform = {
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
};

const boundingBox: ModelBoundingBox = {
  min: [-0.5, -0.5, -0.5],
  max: [0.5, 0.5, 0.5],
  center: [0, 0, 0],
  size: [1, 1, 1],
};

function getScenario(): PerfScenario | undefined {
  const value = new URLSearchParams(window.location.search).get('perfScenario');
  return value === '100-models' || value === '100-layers' || value === '100-layers-unbaked' ? value : undefined;
}

function createImageDataUrl(index: number) {
  const hue = (index * 47) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="hsl(${hue} 84% 58%)"/><circle cx="16" cy="16" r="9" fill="white" fill-opacity=".24"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function createSerializedCamera(): SerializedCamera {
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(0, 1.4, 4);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return {
    type: 'perspective',
    projection: 'perspective',
    position: camera.position.toArray(),
    quaternion: camera.quaternion.toArray(),
    target: [0, 0, 0],
    near: camera.near,
    far: camera.far,
    fov: camera.fov,
    zoom: camera.zoom,
    projectionMatrix: camera.projectionMatrix.toArray(),
    matrixWorld: camera.matrixWorld.toArray(),
    viewMatrix: camera.matrixWorld.clone().invert().toArray(),
    aspect: camera.aspect,
  };
}

function createSyntheticModel(index: number, total: number): { object: SceneObject; model: ModelLoadResult } {
  const objectId = `perf-object-${index}`;
  const grid = Math.ceil(Math.sqrt(total));
  const spacing = 1.25;
  const x = (index % grid - (grid - 1) / 2) * spacing;
  const z = (Math.floor(index / grid) - (grid - 1) / 2) * spacing;
  const group = new THREE.Group();
  group.name = `Perf Model ${index + 1}`;
  group.userData.liclickObjectId = objectId;
  group.position.set(x, 0.5, z);

  const geometry = new THREE.BoxGeometry(0.72, 0.72, 0.72, 4, 4, 4);
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHSL((index * 0.071) % 1, 0.54, 0.52),
    roughness: 0.72,
    metalness: 0.02,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  group.updateMatrixWorld(true);

  const object: SceneObject = {
    id: objectId,
    name: `Perf Model ${index + 1}`,
    type: 'mesh',
    format: 'glb',
    materialSlots: [{ id: 'mat-01', name: 'Perf material' }],
    uvSets: ['UV0'],
    boundingBox,
    originalBoundingBox: boundingBox,
    transform: objectTransform,
    visible: true,
    selected: index === 0,
    childMeshCount: 1,
  };

  const model: ModelLoadResult = {
    objectId,
    name: object.name,
    format: 'glb',
    group,
    sourceFileName: `${object.name}.glb`,
    materialSlots: ['Perf material'],
    uvSets: ['UV0'],
    boundingBox,
    originalBoundingBox: boundingBox,
    importNormalizationTransform: {
      position: [x, 0.5, z],
      scale: [1, 1, 1],
      targetMaxDimension: 1,
      grounded: true,
      normalized: true,
    },
    childMeshCount: 1,
    warnings: [],
  };

  return { object, model };
}

function createLayers(objectId: string, count: number) {
  const camera = createSerializedCamera();
  return Array.from({ length: count }, (_, index): Layer => ({
    id: `perf-layer-${index}`,
    name: `Perf Layer ${index + 1}`,
    type: 'projected',
    imageUrl: createImageDataUrl(index),
    objectId,
    objectMatrixWorld: new THREE.Matrix4().identity().toArray(),
    camera,
    generationId: `perf-generation-${index}`,
    captureId: `perf-capture-${index}`,
    visible: true,
    opacity: 0.72,
    blendMode: 'normal',
    adjustments: { hue: 0, saturation: 0, lightness: 0 },
    order: index,
    createdAt: new Date(2026, 5, 26, 10, 0, index).toISOString(),
  }));
}

function createBakedTexture(objectId: string, layers: Layer[]): BakedTexture {
  const sourceLayerIds = [...layers].sort((a, b) => b.order - a.order).map((layer) => layer.id);
  return {
    id: 'perf-baked-100-layer-stack',
    objectId,
    sourceLayerId: sourceLayerIds[0] ?? '',
    sourceLayerIds,
    imageUrl: createImageDataUrl(999),
    width: 1024,
    height: 1024,
    format: 'png',
    createdAt: new Date().toISOString(),
    coverageRatio: 1,
    report: {
      id: 'perf-bake-report',
      objectId,
      layerId: sourceLayerIds[0] ?? '',
      width: 1024,
      height: 1024,
      totalTriangles: 12,
      processedTriangles: 12,
      coveredPixels: 1024 * 1024,
      skippedPixels: 0,
      totalTexels: 1024 * 1024,
      inFrustumTexels: 1024 * 1024,
      maskRejectedTexels: 0,
      depthRejectedTexels: 0,
      backfaceRejectedTexels: 0,
      writtenTexels: 1024 * 1024,
      coverageRatio: 1,
      warnings: ['Perf scenario baked texture uses order-independent CPU compositing.'],
      durationMs: 0,
    },
  };
}

function createProject(scenario: PerfScenario, objects: SceneObject[], layers: Layer[], bakedTextures: BakedTexture[]): Project {
  return {
    id: `perf-${scenario}`,
    name: `Perf ${scenario}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    thumbnail: '',
    objects,
    references: [],
    captures: [],
    generations: [],
    layers,
    bakedTextures,
    workspaceMode: 'none',
    dirty: false,
    activeObjectId: objects[0]?.id,
    activeLayerId: layers[0]?.id,
    settings: {
      resolution: '2K',
      displayMode: 'pbr',
      projectionMode: 'perspective',
      colorManagement: 'srgb',
    },
  };
}

function startFrameSampler(scenario: PerfScenario, setupMs: number) {
  document.body.dataset.perfSamplerStarted = 'true';
  const frameDurations: number[] = [];
  const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const sampleStartedAt = nowMs();
  let previous = sampleStartedAt;
  let frame = 0;
  let fallbackTicks = 0;
  const warmupFrames = 30;
  const frameLimit = 240;

  function scheduleTick() {
    let settled = false;
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      fallbackTicks += 1;
      tick(nowMs());
    }, 50);
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame((now) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        tick(now);
      });
    }
  }

  function tick(now: number) {
    if (frame >= warmupFrames) {
      frameDurations.push(now - previous);
    }
    previous = now;
    frame += 1;
    document.body.dataset.perfSamplerFrame = String(frame);
    if (frame < warmupFrames + frameLimit) {
      scheduleTick();
      return;
    }
    const sorted = [...frameDurations].sort((a, b) => a - b);
    const total = frameDurations.reduce((sum, value) => sum + value, 0);
    const averageFrameMs = total / Math.max(1, frameDurations.length);
    const p95FrameMs = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
    const maxFrameMs = sorted[sorted.length - 1] ?? 0;
    window.__liclickPerfMetrics = {
      scenario,
      startedAt: sampleStartedAt,
      setupMs,
      sampledFrames: frameDurations.length,
      averageFrameMs,
      p95FrameMs,
      maxFrameMs,
      fps: 1000 / averageFrameMs,
      fallbackTicks,
    };
    document.body.dataset.perfMetrics = JSON.stringify(window.__liclickPerfMetrics);
    document.body.dataset.perfScenarioReady = 'true';
  }

  scheduleTick();
}

export function PerfScenarioLoader() {
  useEffect(() => {
    const scenario = getScenario();
    if (!scenario) return undefined;

    document.body.dataset.perfScenario = scenario;
    document.body.dataset.perfScenarioReady = 'false';
    const setupTimer = window.setTimeout(() => {
      const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const modelCount = scenario === '100-models' ? 100 : 1;
      const synthetic = Array.from({ length: modelCount }, (_, index) => createSyntheticModel(index, modelCount));
      const objects = synthetic.map((item) => item.object);
      const models = synthetic.map((item) => item.model);
      const layers = scenario === '100-models' ? [] : createLayers(objects[0].id, 100);
      const bakedTextures = scenario === '100-layers' ? [createBakedTexture(objects[0].id, layers)] : [];
      const project = createProject(scenario, objects, layers, bakedTextures);

      useSceneStore.setState({
        objects,
        importedModels: models,
        importedModel: models[0],
        selectedObjectId: objects[0]?.id,
        displayMode: 'pbr',
        transformMode: 'select',
        paintTool: 'none',
        importWarnings: [],
      });
      useLayerStore.setState({
        layers,
        activeProjectedLayerId: layers[0]?.id,
      });
      useProjectStore.getState().replaceCurrentProject(project);
      const viewport = useSceneStore.getState().viewport;
      if (viewport) {
        viewport.camera.position.set(6, 4, 8);
        viewport.camera.lookAt(0, 0.5, 0);
        viewport.controls?.target.set(0, 0.5, 0);
        viewport.controls?.update();
      }

      const setupMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt;
      startFrameSampler(scenario, setupMs);
    }, 50);

    return () => {
      window.clearTimeout(setupTimer);
      document.body.dataset.perfScenarioReady = 'false';
      delete document.body.dataset.perfMetrics;
      delete document.body.dataset.perfSamplerFrame;
      delete document.body.dataset.perfSamplerStarted;
      delete window.__liclickPerfMetrics;
    };
  }, []);

  return null;
}
