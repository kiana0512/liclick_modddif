import * as THREE from 'three';
import { prepareFbxModelExport, prepareTexturedModelExport } from '../src/engine/export/texturedExportUtils.ts';
import { exportModelFbx } from '../src/engine/export/exportFbx.ts';
import { bakeVisibleProjectedLayersToTexture } from '../src/engine/bake/bakeProjectedLayerToTexture.ts';
import { getMergeUvPostprocessOptions, compareUvMergeSources, compositeRgbaUnderInPlace, isUvPaintLayer } from '../src/engine/layers/mergeUvComposition.ts';
import { compositeRgbaUrlUnderWithWebGpu } from '../src/engine/performance/webGpuRgbaComposite.ts';
import { encodeRgbaPngBlob } from '../src/utils/encodeRgbaPng.ts';
import { serializeCamera } from '../src/engine/projection/ProjectionCamera.ts';
import { useLayerStore } from '../src/stores/layerStore.ts';
import { useSceneStore } from '../src/stores/sceneStore.ts';
import { useProjectStore } from '../src/stores/projectStore.ts';
import { useSettingsStore } from '../src/stores/settingsStore.ts';
const check = (condition, message) => { if (!condition) throw Error(message); };
const imageUrl = (paint, size=64) => {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
  const context=canvas.getContext('2d');context.scale(size/64,size/64);
  paint(context); return canvas.toDataURL();
};
async function pixels(blob) {
  const bitmap = await window.createImageBitmap(blob);
  const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0); bitmap.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}
export async function run() {
  const renderer = new THREE.WebGLRenderer({ antialias: true }); renderer.setSize(64, 64);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 20); camera.position.z = 5; camera.updateMatrixWorld(true);
  const cameraSnapshot = serializeCamera(camera, 1, new THREE.Vector3());
  const group = new THREE.Group(); const geometry = new THREE.PlaneGeometry(2, 2);
  const material = new THREE.MeshStandardMaterial({ color: '#f4f5f2' });
  // Deliberately undecodable original material source. The working color merge
  // does not consume it and neither may the unmerged FBX path.
  const original = new window.Image(); original.src = 'data:text/plain,not-an-image';
  material.map = new THREE.Texture(original);
  group.add(new THREE.Mesh(geometry, material)); group.updateMatrixWorld(true);
  const importedModel = { objectId: 'fixture', group, uvSets: ['UV0'], restoreStage: 'full' };
  const project = { id: 'fbx-fixture', name: 'FBX fixture', layers: [], bakedTextures: [], captures: [], objects: [], generations: [], references: [] };
  useProjectStore.setState({ projects: [project], currentProjectId: project.id });
  useSceneStore.setState({ importedModel, viewport: { gl: renderer }, localRepaintPreviewLayer: undefined });
  useSettingsStore.setState({ resolution: '2K' });
  const layers = [{ id: 'projection', name: 'Projection', type: 'projected', visible: true, objectId: 'fixture', order: 1, opacity: 1, camera: cameraSnapshot,
    imageUrl: imageUrl((ctx) => { ctx.fillStyle = '#b8792e'; ctx.fillRect(0, 0, 64, 64); ctx.fillStyle = '#2266aa'; ctx.fillRect(0, 0, 32, 32); }),
    depthTest: true, minimumProjectionFacing: 0.18 },
  { id: 'local-repaint-projection-fixture', name: 'Repaint', type: 'projected', visible: true, objectId: 'fixture', order: 0, opacity: 1, camera: cameraSnapshot,
    imageUrl: imageUrl((ctx) => { ctx.fillStyle = '#19cc38'; ctx.fillRect(0, 0, 64, 64); }),
    maskUrl: imageUrl((ctx) => { ctx.fillStyle = '#fff'; ctx.fillRect(25, 25, 14, 14); }), depthTest: true }];
  useLayerStore.setState({ layers });
  const initialProject = useProjectStore.getState().getCurrentProject();
  const input = { project, importedModel, target: 'scene' };
  const result = await prepareFbxModelExport(input);
  const unmerged = await pixels(result.textureBlob);
  check(unmerged.width === 2048 && unmerged.height === 2048, 'preserve 2K resolution');
  check(useLayerStore.getState().layers === layers && useProjectStore.getState().getCurrentProject() === initialProject, 'no layer/history/project writes');
  const center = (1024 * 2048 + 1024) * 4;
  check(unmerged.data[center + 1] > unmerged.data[center] * 2, 'local repaint present');
  check(unmerged.data.filter((_, index) => index % 4 === 3).every((v) => v === 255), 'opaque FBX atlas');
  // A real manual-color-merge pixel stage, then the already-merged FBX path.
  const { createProjectionMaskedImage } = await import('../src/engine/projection/createMaskedProjectedImage.ts');
  const { revokeRegisteredObjectUrl } = await import('../src/utils/blobUrlRegistry.ts');
  const masked = await createProjectionMaskedImage(layers[1].imageUrl, layers[1].maskUrl);
  const bake = await bakeVisibleProjectedLayersToTexture({ objectId: 'fixture', transientLayers: [layers[0], { ...layers[1], imageUrl: masked, maskUrl: undefined, ignoreSourceAlpha: false }], resolution: 2048,
    enableBackfaceCulling: true, enableDilation: false, dilationPixels: 0, ...getMergeUvPostprocessOptions(2048), repairMissingUvSeams: true,
    outputAlpha: 'transparent', commitToProject: false, markSourceLayersBaked: false, skipImageEncoding: true, skipCanvasUpload: true });
  revokeRegisteredObjectUrl(masked);
  const mergedUrl = URL.createObjectURL(await encodeRgbaPngBlob(2048, 2048, bake.imageData.data));
  useLayerStore.setState({ layers: [{ id: 'merged', name: 'Merged UV', type: 'uv', role: 'merged-uv', uvMergeVersion: 6, visible: true, opacity: 1, order: 0, objectId: 'fixture', imageUrl: mergedUrl }] });
  const merged = await pixels((await prepareFbxModelExport(input)).textureBlob);
  let mismatches = 0;
  for (let i = 0; i < merged.data.length; i++) if (merged.data[i] !== unmerged.data[i]) mismatches++;
  check(mismatches === 0, `manual merge parity: ${mismatches} differing channels`);
  useLayerStore.setState({ layers });
  const downloads = [];
  const oldClick = window.HTMLAnchorElement.prototype.click;
  window.HTMLAnchorElement.prototype.click = function () { downloads.push(window.fetch(this.href).then((r) => r.blob())); };
  try { for (const target of ['scene', 'object']) await exportModelFbx({ ...input, target, selectedObjectId: 'fixture' }); }
  finally { window.HTMLAnchorElement.prototype.click = oldClick; }
  check(downloads.length === 2, 'both FBX entries download');
  const sizes = [];
  for (const pending of downloads) {
    const blob = await pending; const bytes = new Uint8Array(await blob.arrayBuffer()); sizes.push(bytes.length);
    check(new window.TextDecoder().decode(bytes.slice(0, 18)) === 'Kaydara FBX Binary', 'FBX binary header');
    const pngHeader = [137, 80, 78, 71, 13, 10, 26, 10];
    const start = bytes.findIndex((_, i) => pngHeader.every((v, j) => bytes[i + j] === v));
    check(start > 0, 'embedded PNG'); let end = start + 8;
    while (end < bytes.length) {
      const length = new DataView(bytes.buffer).getUint32(end);
      const type = new window.TextDecoder().decode(bytes.slice(end + 4, end + 8)); end += length + 12;
      if (type === 'IEND') break;
    }
    const embedded = await pixels(new Blob([bytes.slice(start, end)], { type: 'image/png' }));
    check(embedded.width === 2048 && embedded.data[center + 1] === unmerged.data[center + 1], 'valid 2K embedded authored texture');
  }
  check(useLayerStore.getState().layers === layers && useProjectStore.getState().getCurrentProject() === initialProject, 'FBX downloads preserve source state');
  // Reproduce selected-UV repaint: ordinary UUIDs, no role/name discriminator.
  const paint = (id, color, order, opacity=1) => ({id,name:'User renamed layer',type:'uv',
    visible:true,objectId:'fixture',order,opacity,blendMode:'normal',
    imageUrl:imageUrl(ctx=>{ctx.fillStyle=color;ctx.fillRect(16,16,32,32);},2048)});
  const manual = [paint('manual-upper','#ff0000',0,0.5),paint('manual-lower','#0000ff',1)];
  const manualLayers = [...manual,...layers.map(layer=>({...layer,order:layer.order+2})),
    {...paint('hidden','#00ff00',0),visible:false}, {...paint('other','#00ff00',0),objectId:'other'}];
  useLayerStore.setState({layers:manualLayers});
  const beforeMerge = await pixels((await prepareFbxModelExport(input)).textureBlob);
  const sample = image => [...image.data.slice(center,center+4)];
  check(JSON.stringify(sample(beforeMerge))===JSON.stringify([128,0,128,255]),'two manual layers, half opacity, hidden/object isolation');
  // Exercise the same CPU/GPU-worker branch choice as explicit editor merge.
  let cpu = bake.imageData.data.slice(), gpu = cpu.slice();
  let mergeBackend;
  for (const layer of [...manual].sort(compareUvMergeSources)) {
    const bitmap = await window.createImageBitmap(await (await window.fetch(layer.imageUrl)).blob());
    const canvas = document.createElement('canvas'); canvas.width=canvas.height=2048;
    const ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0,2048,2048);bitmap.close();
    cpu=compositeRgbaUnderInPlace(ctx.getImageData(0,0,2048,2048).data,cpu,1,layer.opacity);
    const result=await compositeRgbaUrlUnderWithWebGpu(gpu,layer.imageUrl,2048,2048,layer.opacity,undefined,isUvPaintLayer(layer));
    gpu=result.data;mergeBackend=result.metrics.backend;
  }
  let manualMergeMismatches=0;
  for(let i=0;i<cpu.length;i++) if(cpu[i]!==gpu[i]) manualMergeMismatches++;
  check(manualMergeMismatches===0,`manual UV CPU/worker full-byte parity: ${manualMergeMismatches}, ${mergeBackend}`);
  const manualMergedUrl=URL.createObjectURL(await encodeRgbaPngBlob(2048,2048,cpu));
  useLayerStore.setState({layers:[{id:'merged-manual',name:'Merged',type:'uv',role:'merged-uv',
    visible:true,opacity:1,order:0,objectId:'fixture',imageUrl:manualMergedUrl}]});
  const afterMerge=await pixels((await prepareFbxModelExport(input)).textureBlob);
  let manualExportMismatches=0;
  for(let i=0;i<afterMerge.data.length;i++) if(afterMerge.data[i]!==beforeMerge.data[i]) manualExportMismatches++;
  check(manualExportMismatches===0,'manual repaint survives merge/export without duplicate opacity');
  // GLB/GLTF/OBJ share this preparation; use a valid original base for that path.
  material.map=null;
  useLayerStore.setState({layers:manualLayers});
  const standard=await prepareTexturedModelExport(input);
  const standardPixel=sample(await pixels(standard.textureBlob));
  // Canvas source-over uses the browser's premultiplied 8-bit rounding rather
  // than the merge kernel's straight-alpha rounding. Compare with that API.
  const golden=document.createElement('canvas');golden.width=golden.height=2048;
  const goldenContext=golden.getContext('2d',{willReadFrequently:true});
  for(const layer of [...manual].sort(compareUvMergeSources)) {
    const bitmap=await window.createImageBitmap(await (await window.fetch(layer.imageUrl)).blob());
    goldenContext.globalAlpha=layer.opacity;goldenContext.drawImage(bitmap,0,0);bitmap.close();
  }
  const expectedPixel=[...goldenContext.getImageData(1024,1024,1,1).data];
  check(JSON.stringify(standardPixel)===JSON.stringify(expectedPixel),`standard model export retains manual repaint: ${standardPixel}, expected ${expectedPixel}`);
  standard.texture?.dispose();URL.revokeObjectURL(manualMergedUrl);
  material.map=new THREE.Texture(original);
  URL.revokeObjectURL(mergedUrl); renderer.dispose(); geometry.dispose(); material.map.dispose(); material.dispose();
  return { resolution: '2048x2048', manualMergeByteMismatches: mismatches, manualPaintWorkerMismatches:manualMergeMismatches,
    manualPaintExportMismatches:manualExportMismatches, mergeBackend, standardExportPixel:standardPixel,
    fbxBytes: sizes, originalImageUndecodable: true, repaintPresent: true, sourceStateUnchanged: true };
}
