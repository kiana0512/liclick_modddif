import type * as THREE from 'three';
import type {Layer} from '@/types/layer';
import type {BakeReport,UvBakeResolution} from './uvBakeTypes';
import {getProjectedLayerStackSignature} from './layerStackCache';
import {getDebugUvBakeStatus} from './uvBakeDebugControls';
const attributeIdentities=new WeakMap<object,number>();
let nextAttributeIdentity=1;
function attributeIdentity(value:object|undefined|null) {
  if(!value) return 0;
  let id=attributeIdentities.get(value);
  if(!id) {id=nextAttributeIdentity++;attributeIdentities.set(value,id);}
  return id;
}
export type ReusableProjectionBakePurpose = 'merge-uv' | 'content-aware-repair';

export type ReusableProjectionBakeEntry = {
  signature: string;
  imageData: ImageData;
  report: BakeReport;
};

export function compareProjectedLayersForDeterministicBake(left: Layer, right: Layer) {
  const orderDelta = right.order - left.order;
  if (orderDelta !== 0) return orderDelta;
  return left.id.localeCompare(right.id);
}

export function createReusableProjectionBakeSignature(input: {
  purpose: ReusableProjectionBakePurpose;
  projectId?: string;
  objectId: string;
  resolution: UvBakeResolution;
  group: THREE.Object3D;
  layers: Layer[];
  optionSignature: string;
}) {
  input.group.updateMatrixWorld(true);
  const geometryState:string[]=[];
  input.group.traverse(node=>{
    geometryState.push(`${node.uuid}:${node.visible}`);
    const mesh=node as THREE.Mesh;
    if(!mesh.isMesh) return;
    const geometry=mesh.geometry;
    geometryState.push([node.uuid,node.visible,node.matrixWorld.elements.join(','),geometry.uuid,
      `${attributeIdentity(geometry.index)}:${geometry.index?.version}`,...['position','normal','uv'].map(name=>{
        const attribute=geometry.getAttribute(name);
        return attribute ? `${attributeIdentity(attribute)}:${attribute.count}:${'version' in attribute ? attribute.version : `${attributeIdentity(attribute.data)}:${attribute.data.version}`}` : '';
      }),geometry.drawRange.start,geometry.drawRange.count].join(':'));
  });
  const normalizedLayers = [...input.layers].sort(compareProjectedLayersForDeterministicBake);
  // `getProjectedLayerStackSignature` includes every visual layer setting and
  // live-canvas revision. Append the exact transient asset URLs as well: blob
  // URLs are deliberately omitted from the persistent cache signature, but are
  // safe and necessary for this short-lived editor-session cache.
  const stackSignature = getProjectedLayerStackSignature(
    input.projectId,
    input.objectId,
    input.resolution,
    normalizedLayers,
    {
      method: 'gpu',
      outputAlpha: 'transparent',
      enableDilation: false,
      dilationPixels: 0,
    },
  );
  const exactAssets = normalizedLayers
    .map(
      (layer) =>
        `${layer.id}:${layer.contentRevision ?? 0}:${layer.imageUrl ?? ''}:${layer.maskUrl ?? ''}:${layer.depthUrl ?? ''}:${layer.normalUrl ?? ''}:${layer.depthEncoding ?? ''}`,
    )
    .join('|');
  return [
    'editor-projection-bake-cache-v12',
    geometryState.join('|'),
    input.purpose,
    stackSignature,
    input.group.matrixWorld.elements.join(','),
    JSON.stringify(getDebugUvBakeStatus()),
    input.optionSignature,
    exactAssets,
    // Include the full authored contract: visibility policy, alpha handling,
    // camera near/far and future layer fields must also invalidate this cache.
    JSON.stringify(normalizedLayers),
  ].join('||');
}

export function cloneProjectionBakeImageData(imageData: ImageData) {
  return new ImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height);
}
