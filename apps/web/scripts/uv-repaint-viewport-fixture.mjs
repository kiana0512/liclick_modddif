import React from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three';
import { ViewportCanvas } from '../src/engine/viewport/ViewportCanvas.tsx';
import { useSceneStore } from '../src/stores/sceneStore.ts';
import { useLayerStore } from '../src/stores/layerStore.ts';
import { useProjectStore } from '../src/stores/projectStore.ts';
import { useSettingsStore } from '../src/stores/settingsStore.ts';
import { useEditorHistoryStore } from '../src/stores/editorHistoryStore.ts';
import { useWorkspaceLayoutStore } from '../src/components/workspace/workspaceLayoutStore.ts';
import { serializeCamera } from '../src/engine/projection/ProjectionCamera.ts';
import {
  flushLiveUvCommits,
  getLiveProjectedCanvasState,
  getLiveProjectedTextureBlob,
} from '../src/engine/projection/liveProjectedCanvasTextureRegistry.ts';
import { paintHistoryBoundary } from '../src/engine/paint/paintHistoryBoundary.ts';
import { prepareFbxModelExport } from '../src/engine/export/texturedExportUtils.ts';
import { RepaintLayerNotice } from '../src/components/localRepaint/RepaintLayerNotice.tsx';

export function showLayerDialog() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  window.dialogResult = undefined;
  const finish = result => { window.dialogResult = result; root.unmount(); host.remove(); };
  root.render(React.createElement(RepaintLayerNotice, {
    onCreate: () => finish('create'), onCancel: () => finish('cancel'),
  }));
}

const tick = () => new Promise((resolve) => window.requestAnimationFrame(resolve));
async function until(test, label) {
  const deadline = performance.now() + 25000;
  while (!test()) {
    if (performance.now() > deadline)
      throw Error(`${label}: ${JSON.stringify(document.body.dataset)}`);
    await tick();
  }
}
export async function setup({ manual = false } = {}) {
  const group = new THREE.Group();
  group.add(
    new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.MeshStandardMaterial({ color: '#808080', side: THREE.DoubleSide }),
    ),
  );
  const bounds = { min: [-1, -1, 0], max: [1, 1, 0], center: [0, 0, 0], size: [2, 2, 0] };
  const model = {
    objectId: 'uv-fixture',
    name: 'UV fixture',
    format: 'glb',
    group,
    sourceFileName: 'fixture.glb',
    materialSlots: ['Base'],
    uvSets: ['UV0'],
    boundingBox: bounds,
    originalBoundingBox: bounds,
    childMeshCount: 1,
    warnings: [],
    restoreStage: 'full',
  };
  const object = {
    id: model.objectId,
    name: model.name,
    type: 'mesh',
    format: 'glb',
    materialSlots: [{ id: 'Base', name: 'Base' }],
    uvSets: ['UV0'],
    boundingBox: bounds,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    visible: true,
    selected: true,
  };
  const project = {
    id: 'isolated-uv-repaint',
    name: 'UV fixture',
    layers: [],
    bakedTextures: [],
    captures: [],
    objects: [object],
    generations: [],
    references: [],
  };
  useProjectStore.setState({ projects: [project], currentProjectId: project.id });
  useSettingsStore.setState({ resolution: '1K' });
  useWorkspaceLayoutStore.setState({ mode: 'texture' });
  useSceneStore.getState().setImportedModel(model, object);
  useSceneStore.setState({ displayMode: 'flat', paintTool: 'none' });
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;inset:0';
  document.body.append(host);
  const root = createRoot(host);
  root.render(
    React.createElement(ViewportCanvas, {
      hasImportedModel: true,
      showCaptureFrame: false,
      showViewCube: false,
      onImportModels() {},
      onImportReferenceImages() {},
      onOpenImport() {},
    }),
  );
  await until(() => useSceneStore.getState().viewport, 'viewport mount');
  host.firstElementChild.style.cssText = 'position:absolute;inset:0';
  const runtime = useSceneStore.getState().viewport;
  await until(() => runtime.gl.domElement.width > 400, 'viewport resize');
  runtime.camera.position.set(0, 0, 5);
  runtime.camera.lookAt(0, 0, 0);
  runtime.camera.updateMatrixWorld();
  runtime.controls.target.set(0, 0, 0);
  runtime.controls.update();
  const source = document.createElement('canvas');
  source.width = source.height = 128;
  source.getContext('2d').fillStyle = '#d34422';
  source.getContext('2d').fillRect(0, 0, 128, 128);
  const mask = document.createElement('canvas');
  mask.width = mask.height = 128;
  mask.getContext('2d').fillStyle = '#fff';
  mask.getContext('2d').fillRect(0, 0, 128, 128);
  const manualLayer = manual ? useLayerStore.getState().addEmptyLayer({ objectId: object.id, name: '手动 A' }) : undefined;
  useSceneStore.getState().setLocalRepaintProjectionSource({
    ...(manualLayer ? { destinationMode: 'selected-uv', targetLayerId: manualLayer.id, targetLayerType: 'uv', targetLayerName: manualLayer.name } : {}),
    generationId: 'fixture-gen',
    captureId: 'fixture-capture',
    objectId: object.id,
    imageUrl: source.toDataURL(),
    allowedMaskUrl: mask.toDataURL(),
    ignoreSourceAlpha: false,
    camera: serializeCamera(
      runtime.camera,
      runtime.gl.domElement.width / runtime.gl.domElement.height,
      new THREE.Vector3(),
    ),
  });
  await until(
    () => document.body.dataset.localRepaintGpuReadyGeneration === 'fixture-gen',
    'UV preparation',
  );
  useSceneStore.getState().setPaintTool('inpaint-apply');
  useSceneStore.getState().setLocalRepaintBrushSettings({ brushSize: 20, brushFeather: 0 });
  await tick();
  await tick();
  window.uvFixture = {
    addManualLayer() {
      return useLayerStore.getState().addEmptyLayer({ objectId: object.id, name: '手动 B' }).id;
    },
    selectManual(id) { useLayerStore.getState().setActiveLayer(id); },
    removeManual(id) { useLayerStore.getState().deleteLayer(id); },
    async roundTripManual() {
      await flushLiveUvCommits();
      const frozen = useSceneStore.getState().localRepaintProjectionSource;
      const selected = useLayerStore.getState().activeProjectedLayerId;
      const rows = await Promise.all(useLayerStore.getState().layers.map(async layer => {
        if (!layer.imageUrl) return layer;
        const blob = await getLiveProjectedTextureBlob(layer.imageUrl);
        const imageUrl = await new Promise((resolve, reject) => {
          const reader = new window.FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
        return { ...layer, imageUrl };
      }));
      useSceneStore.getState().setPaintTool('none');
      useSceneStore.getState().setLocalRepaintProjectionSource(undefined);
      for (let i = 0; i < 12; i++) await tick();
      useLayerStore.getState().setLayers(JSON.parse(JSON.stringify(rows)));
      useLayerStore.getState().setActiveLayer(selected);
      useSceneStore.getState().setLocalRepaintProjectionSource({ ...frozen, autoActivate: true });
      await until(() => document.body.dataset.localRepaintGpuReadyTarget === selected, 'saved PNG reopen');
      for (let i = 0; i < 4; i++) await tick();
    },
    async manualState() {
      await flushLiveUvCommits();
      return useLayerStore.getState().layers.map((layer) => {
        const canvas = getLiveProjectedCanvasState(layer.imageUrl)?.canvas;
        const bytes = canvas?.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let hash = 2166136261, red = 0, green = 0, blue = 0;
        if (bytes) for (let i = 0; i < bytes.length; i += 4) {
          for (let j = 0; j < 4; j++) hash = Math.imul(hash ^ bytes[i+j], 16777619) >>> 0;
          if (!bytes[i+3]) continue;
          if (bytes[i] > 150 && bytes[i+1] < 120) red++;
          if (bytes[i+1] > 150 && bytes[i] < 120) green++;
          if (bytes[i+2] > 150 && bytes[i] < 120) blue++;
        }
        return { id: layer.id, name: layer.name, type: layer.type, hash, red, green, blue };
      });
    },
    navigationState() {
      return { position: runtime.camera.position.toArray(), target: runtime.controls.target.toArray() };
    },
    resetNavigation() {
      runtime.camera.position.set(0, 0, 5);
      runtime.camera.up.set(0, 1, 0);
      runtime.controls.target.set(0, 0, 0);
      runtime.controls.update();
    },
    setSurfaceTilt(angle) {
      group.children.find(child => child.isMesh).rotation.y = angle;
      group.updateMatrixWorld(true);
    },
    async nextLayer(generationId = 'fixture-gen-second', color = '#22bb44') {
      const frozen = useSceneStore.getState().localRepaintProjectionSource;
      useSceneStore.getState().setPaintTool('none');
      source.getContext('2d').fillStyle = color;
      source.getContext('2d').fillRect(0, 0, 128, 128);
      useSceneStore.getState().setLocalRepaintProjectionSource({
        ...frozen,
        generationId,
        imageUrl: source.toDataURL(),
      });
      await until(
        () => document.body.dataset.localRepaintGpuReadyGeneration === generationId,
        'second UV preparation',
      );
      useSceneStore.getState().setLocalRepaintBrushSettings({ brushSize: 6, brushFeather: 0 });
      useSceneStore.getState().setPaintTool('inpaint-apply');
      await tick();
      await tick();
    },
    visibility(id, visible) {
      useLayerStore.getState().setLayerVisibility([id], visible);
    },
    addBase() {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 128;
      canvas.getContext('2d').fillStyle = '#887744';
      canvas.getContext('2d').fillRect(0, 0, 128, 128);
      const layers = useLayerStore.getState().layers;
      useLayerStore.setState({ layers: [...layers, {
        ...layers[0], id: 'fixture-base', role: 'merged-uv',
        order: layers.length, imageUrl: canvas.toDataURL(),
      }] });
    },
    async pixels(offsets = [0, 100]) {
      await flushLiveUvCommits();
      for (let i = 0; i < 12; i++) await tick();
      runtime.gl.render(runtime.scene, runtime.camera);
      const gl = runtime.gl.getContext();
      const canvas = runtime.gl.domElement;
      return offsets.map((offset) => {
        const pixel = new Uint8Array(4);
        gl.readPixels(
          Math.round(canvas.width / 2 + offset * canvas.width / canvas.clientWidth),
          Math.round(canvas.height / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel,
        );
        return [...pixel];
      });
    },
    async state() {
      await flushLiveUvCommits();
      const layer = useLayerStore
        .getState()
        .layers.find((row) => row.id.startsWith('local-repaint-uv-native-v1'));
      const canvas = layer && getLiveProjectedCanvasState(layer.imageUrl)?.canvas;
      const bytes = canvas?.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let painted = 0;
      if (bytes) for (let i = 3; i < bytes.length; i += 4) if (bytes[i]) painted++;
      return {
        layer,
        painted,
        center: canvas
          ? [
              ...canvas.getContext('2d').getImageData(canvas.width / 2, canvas.height / 2, 1, 1)
                .data,
            ]
          : [],
        history: useEditorHistoryStore.getState().past.length,
        tool: useSceneStore.getState().paintTool,
      };
    },
    erase() {
      const layer = useLayerStore
        .getState()
        .layers.find((row) => row.id.startsWith('local-repaint-uv-native-v1'));
      useLayerStore.setState({ activeProjectedLayerId: layer.id });
      useSceneStore.getState().setPaintTool('eraser');
    },
    undo() {
      paintHistoryBoundary.run(() => useEditorHistoryStore.getState().undo());
    },
    redo() {
      paintHistoryBoundary.run(() => useEditorHistoryStore.getState().redo());
    },
    async reopen() {
      const frozen = useSceneStore.getState().localRepaintProjectionSource;
      useSceneStore.getState().setPaintTool('none');
      useSceneStore.getState().setLocalRepaintProjectionSource(undefined);
      for (let i = 0; i < 8; i++) await tick();
      delete document.body.dataset.localRepaintGpuReadyGeneration;
      useSceneStore.getState().setLocalRepaintProjectionSource({ ...frozen });
      await until(
        () => document.body.dataset.localRepaintGpuReadyGeneration === 'fixture-gen',
        'reopen existing UV result',
      );
      useSceneStore.getState().setPaintTool('inpaint-apply');
    },
    async fbxTexture() {
      const result = await prepareFbxModelExport({
        project: useProjectStore.getState().getCurrentProject(),
        importedModel: model,
        target: 'scene',
      });
      const bitmap = await window.createImageBitmap(result.textureBlob);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      return [...context.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data];
    },
    async png() {
      const layer = useLayerStore
        .getState()
        .layers.find((row) => row.id.startsWith('local-repaint-uv-native-v1'));
      const blob = await getLiveProjectedTextureBlob(layer.imageUrl);
      const bitmap = await window.createImageBitmap(blob);
      const result = [bitmap.width, bitmap.height];
      bitmap.close();
      return result;
    },
    close() {
      root.unmount();
    },
  };
  return { ready: true };
}
