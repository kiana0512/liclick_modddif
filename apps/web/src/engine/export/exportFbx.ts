import { zlibSync } from 'fflate';
import * as THREE from 'three';
import type { ModelExportInput } from './exportTypes';
import { downloadBlob, getExportFilename } from './exportUtils';
import { EXPORT_BASECOLOR_MATERIAL_NAME, prepareTexturedModelExport } from './texturedExportUtils';

type FbxMeshRecord = {
  geometryId: number;
  modelId: number;
  name: string;
  vertices: number[];
  polygonVertexIndex: number[];
  normals: number[];
  uvs: number[];
  uvIndex: number[];
  edges: number[];
};

type FbxValue =
  | { type: 'bool'; value: boolean }
  | { type: 'int32'; value: number }
  | { type: 'int64'; value: number }
  | { type: 'float64'; value: number }
  | { type: 'string'; value: string }
  | { type: 'bytes'; value: Uint8Array }
  | { type: 'int32Array'; value: number[]; encodedPayload?: Uint8Array }
  | { type: 'float64Array'; value: number[]; encodedPayload?: Uint8Array };

type FbxNode = {
  name: string;
  props?: FbxValue[];
  children?: FbxNode[];
};

const FBX_VERSION = 7400;
const FBX_HEADER = new Uint8Array([
  0x4b, 0x61, 0x79, 0x64, 0x61, 0x72, 0x61, 0x20, 0x46, 0x42, 0x58, 0x20, 0x42, 0x69, 0x6e, 0x61, 0x72, 0x79,
  0x20, 0x20, 0x00, 0x1a, 0x00,
]);
const FBX_FOOT_ID = new Uint8Array([
  0xfa, 0xbc, 0xab, 0x09, 0xd0, 0xc8, 0xd4, 0x66, 0xb1, 0x76, 0xfb, 0x83, 0x1c, 0xf7, 0x26, 0x7e,
]);
const FBX_END_MAGIC = new Uint8Array([
  0xf8, 0x5a, 0x8c, 0x6a, 0xde, 0xf5, 0xd9, 0x7e, 0xec, 0xe9, 0x0c, 0xe3, 0x75, 0x8f, 0x29, 0x0b,
]);
const BLOCK_SENTINEL_SIZE = 13;
const TEXTURE_SOCKET_NAME = 'base_color_texture';
const UV_SET_NAME = 'UVChannel_1';
const FBX_ENGINE_SIZE_CORRECTION = 100;

function sanitizeName(value: string | undefined, fallback: string) {
  const normalized = (value || fallback).normalize('NFKD').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '');
  return normalized || fallback;
}

function className(name: string, cls: string) {
  return `${name}\u0000\u0001${cls}`;
}

function bool(value: boolean): FbxValue {
  return { type: 'bool', value };
}

function int32(value: number): FbxValue {
  return { type: 'int32', value };
}

function int64(value: number): FbxValue {
  return { type: 'int64', value };
}

function float64(value: number): FbxValue {
  return { type: 'float64', value };
}

function str(value: string): FbxValue {
  return { type: 'string', value };
}

function bytes(value: Uint8Array): FbxValue {
  return { type: 'bytes', value };
}

function int32Array(value: number[]): FbxValue {
  return { type: 'int32Array', value };
}

function float64Array(value: number[]): FbxValue {
  return { type: 'float64Array', value };
}

function node(name: string, props: FbxValue[] = [], children: FbxNode[] = []): FbxNode {
  return { name, props, children };
}

function prop(name: string, type: string, label: string, flags: string, values: FbxValue[] = []) {
  return node('P', [str(name), str(type), str(label), str(flags), ...values]);
}

function propertyTemplate(name: string, properties: FbxNode[]) {
  return node('PropertyTemplate', [str(name)], [node('Properties70', [], properties)]);
}

function sanitizeNumber(value: number) {
  return Number.isFinite(value) ? value : 0;
}

function collectMeshRecords(root: THREE.Object3D) {
  const records: FbxMeshRecord[] = [];
  const position = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const uv = new THREE.Vector2();
  let nextId = 100000;

  root.updateMatrixWorld(true);
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh) || !(child.geometry instanceof THREE.BufferGeometry)) return;
    const geometry = child.geometry;
    const positions = geometry.getAttribute('position');
    if (!positions) return;
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
    const normals = geometry.getAttribute('normal');
    const uvs = geometry.getAttribute('uv');
    const index = geometry.getIndex();
    const triangleCount = index ? Math.floor(index.count / 3) : Math.floor(positions.count / 3);
    if (triangleCount <= 0) return;

    const record: FbxMeshRecord = {
      geometryId: nextId++,
      modelId: nextId++,
      name: sanitizeName(child.name, `Mesh_${records.length + 1}`),
      vertices: [],
      polygonVertexIndex: [],
      normals: [],
      uvs: [],
      uvIndex: [],
      edges: [],
    };
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(child.matrixWorld);
    let exportedVertexIndex = 0;

    for (let triangle = 0; triangle < triangleCount; triangle += 1) {
      for (let corner = 0; corner < 3; corner += 1) {
        const sourceIndex = index ? index.getX(triangle * 3 + corner) : triangle * 3 + corner;
        position.fromBufferAttribute(positions, sourceIndex).applyMatrix4(child.matrixWorld);
        position.multiplyScalar(FBX_ENGINE_SIZE_CORRECTION);
        record.vertices.push(sanitizeNumber(position.x), sanitizeNumber(position.y), sanitizeNumber(position.z));

        if (normals) {
          normal.fromBufferAttribute(normals, sourceIndex).applyMatrix3(normalMatrix).normalize();
        } else {
          normal.set(0, 1, 0);
        }
        record.normals.push(sanitizeNumber(normal.x), sanitizeNumber(normal.y), sanitizeNumber(normal.z));

        if (uvs) {
          uv.fromBufferAttribute(uvs, sourceIndex);
          record.uvs.push(sanitizeNumber(uv.x), sanitizeNumber(uv.y));
        } else {
          record.uvs.push(0, 0);
        }
        record.uvIndex.push(exportedVertexIndex);
        record.polygonVertexIndex.push(corner === 2 ? -(exportedVertexIndex + 1) : exportedVertexIndex);
        record.edges.push(exportedVertexIndex);
        exportedVertexIndex += 1;
      }
    }
    records.push(record);
  });

  return records;
}

function createGeometryNode(record: FbxMeshRecord) {
  return node('Geometry', [int64(record.geometryId), str(className(record.name, 'Geometry')), str('Mesh')], [
    node('Properties70'),
    node('GeometryVersion', [int32(124)]),
    node('Vertices', [float64Array(record.vertices)]),
    node('PolygonVertexIndex', [int32Array(record.polygonVertexIndex)]),
    node('Edges', [int32Array(record.edges)]),
    node('LayerElementNormal', [int32(0)], [
      node('Version', [int32(101)]),
      node('Name', [str('')]),
      node('MappingInformationType', [str('ByPolygonVertex')]),
      node('ReferenceInformationType', [str('Direct')]),
      node('Normals', [float64Array(record.normals)]),
    ]),
    node('LayerElementUV', [int32(0)], [
      node('Version', [int32(101)]),
      node('Name', [str(UV_SET_NAME)]),
      node('MappingInformationType', [str('ByPolygonVertex')]),
      node('ReferenceInformationType', [str('IndexToDirect')]),
      node('UV', [float64Array(record.uvs)]),
      node('UVIndex', [int32Array(record.uvIndex)]),
    ]),
    node('LayerElementMaterial', [int32(0)], [
      node('Version', [int32(101)]),
      node('Name', [str('')]),
      node('MappingInformationType', [str('AllSame')]),
      node('ReferenceInformationType', [str('IndexToDirect')]),
      node('Materials', [int32Array([0])]),
    ]),
    node('Layer', [int32(0)], [
      node('Version', [int32(100)]),
      node('LayerElement', [], [node('Type', [str('LayerElementNormal')]), node('TypedIndex', [int32(0)])]),
      node('LayerElement', [], [node('Type', [str('LayerElementMaterial')]), node('TypedIndex', [int32(0)])]),
      node('LayerElement', [], [node('Type', [str('LayerElementUV')]), node('TypedIndex', [int32(0)])]),
    ]),
  ]);
}

function createModelNode(record: FbxMeshRecord) {
  return node('Model', [int64(record.modelId), str(className(record.name, 'Model')), str('Mesh')], [
    node('Version', [int32(232)]),
    node('Properties70', [], [
      prop('Lcl Translation', 'Lcl Translation', '', 'A', [float64(0), float64(0), float64(0)]),
      prop('Lcl Rotation', 'Lcl Rotation', '', 'A', [float64(0), float64(0), float64(0)]),
      prop('Lcl Scaling', 'Lcl Scaling', '', 'A', [float64(1), float64(1), float64(1)]),
      prop('InheritType', 'enum', '', '', [int32(1)]),
    ]),
    node('MultiLayer', [int32(0)]),
    node('MultiTake', [int32(0)]),
    node('Shading', [bool(true)]),
    node('Culling', [str('CullingOff')]),
  ]);
}

function createMaterialNode(materialId: number, averageColor: [number, number, number]) {
  return node('Material', [int64(materialId), str(className(EXPORT_BASECOLOR_MATERIAL_NAME, 'Material')), str('')], [
    node('Version', [int32(102)]),
    node('ShadingModel', [str('Phong')]),
    node('MultiLayer', [int32(0)]),
    node('Properties70', [], [
      prop('ShadingModel', 'KString', '', '', [str('Phong')]),
      prop('EmissiveColor', 'Color', '', 'A', [float64(0), float64(0), float64(0)]),
      prop('EmissiveFactor', 'Number', '', 'A', [float64(0)]),
      prop('AmbientColor', 'Color', '', 'A', [float64(0), float64(0), float64(0)]),
      prop('AmbientFactor', 'Number', '', 'A', [float64(0)]),
      prop('DiffuseColor', 'Color', '', 'A', averageColor.map(float64)),
      prop('DiffuseFactor', 'Number', '', 'A', [float64(1)]),
      prop('TransparentColor', 'Color', '', 'A', [float64(0), float64(0), float64(0)]),
      prop('TransparencyFactor', 'Number', '', 'A', [float64(0)]),
      prop('Opacity', 'Number', '', 'A', [float64(1)]),
      prop('SpecularColor', 'Color', '', 'A', [float64(0), float64(0), float64(0)]),
      prop('SpecularFactor', 'Number', '', 'A', [float64(0)]),
      prop('Shininess', 'Number', '', 'A', [float64(20)]),
      prop('ReflectionFactor', 'Number', '', 'A', [float64(0)]),
    ]),
  ]);
}

function createTextureNode(input: { textureId: number; name: string; videoName: string; mediaPath: string }) {
  return node('Texture', [int64(input.textureId), str(className(input.name, 'Texture')), str('')], [
      node('Type', [str('TextureVideoClip')]),
      node('Version', [int32(202)]),
    node('TextureName', [str(className(input.name, 'Texture'))]),
    node('Media', [str(className(input.videoName, 'Video'))]),
    node('FileName', [str(input.mediaPath)]),
    node('Filename', [str(input.mediaPath)]),
    node('RelativeFilename', [str(input.mediaPath)]),
      node('Properties70', [], [
        prop('CurrentTextureBlendMode', 'enum', '', '', [int32(0)]),
        prop('AlphaSource', 'enum', '', '', [int32(0)]),
        prop('PremultiplyAlpha', 'bool', '', '', [int32(0)]),
        prop('UVSet', 'KString', '', '', [str(UV_SET_NAME)]),
        prop('UseMaterial', 'bool', '', '', [int32(1)]),
        prop('UseMipMap', 'bool', '', '', [int32(0)]),
        prop('WrapModeU', 'enum', '', '', [int32(1)]),
        prop('WrapModeV', 'enum', '', '', [int32(1)]),
      ]),
      node('Texture_Alpha_Source', [str('Black')]),
      node('Cropping', [int32(0), int32(0), int32(0), int32(0)]),
      node('ModelUVTranslation', [float64(0), float64(0)]),
      node('ModelUVScaling', [float64(1), float64(1)]),
  ]);
}

function createTextureNodes(input: { textureId: number; videoId: number; data: Uint8Array }) {
  const mediaName = 'liclick_image_0';
  const videoName = `${mediaName}.png`;
  const mediaPath = `liclick_export.fbm/${videoName}`;
  return [
    createTextureNode({ textureId: input.textureId, name: TEXTURE_SOCKET_NAME, videoName, mediaPath }),
    node('Video', [int64(input.videoId), str(className(videoName, 'Video')), str('Clip')], [
      node('Type', [str('Clip')]),
      node('Properties70', [], [prop('Path', 'KString', 'XRefUrl', '', [str(mediaPath)])]),
      node('UseMipMap', [int32(0)]),
      node('Filename', [str(mediaPath)]),
      node('RelativeFilename', [str(mediaPath)]),
      node('Content', [bytes(input.data)]),
    ]),
  ];
}

function createDocumentNode() {
  return node('Documents', [], [
    node('Count', [int32(1)]),
    node('Document', [int64(100), str('Scene'), str('Scene')], [node('Properties70'), node('RootNode', [int64(0)])]),
  ]);
}

function createDefinitionsNode(records: FbxMeshRecord[], hasTexture: boolean) {
  const textureCount = hasTexture ? 1 : 0;
  const objectCount = 1 + records.length * 2 + 1 + textureCount + (hasTexture ? 1 : 0);
  return node('Definitions', [], [
    node('Version', [int32(100)]),
    node('Count', [int32(objectCount)]),
    node('ObjectType', [str('GlobalSettings')], [node('Count', [int32(1)])]),
    node('ObjectType', [str('Geometry')], [
      node('Count', [int32(records.length)]),
      propertyTemplate('FbxMesh', [
        prop('Color', 'ColorRGB', 'Color', '', [float64(0.8), float64(0.8), float64(0.8)]),
        prop('BBoxMin', 'Vector3D', 'Vector', '', [float64(0), float64(0), float64(0)]),
        prop('BBoxMax', 'Vector3D', 'Vector', '', [float64(0), float64(0), float64(0)]),
        prop('Primary Visibility', 'bool', '', '', [bool(true)]),
        prop('Casts Shadows', 'bool', '', '', [bool(true)]),
        prop('Receive Shadows', 'bool', '', '', [bool(true)]),
      ]),
    ]),
    node('ObjectType', [str('Model')], [
      node('Count', [int32(records.length)]),
      propertyTemplate('FbxNode', [
        prop('QuaternionInterpolate', 'enum', '', '', [int32(0)]),
        prop('RotationOffset', 'Vector3D', 'Vector', '', [float64(0), float64(0), float64(0)]),
        prop('RotationPivot', 'Vector3D', 'Vector', '', [float64(0), float64(0), float64(0)]),
        prop('ScalingOffset', 'Vector3D', 'Vector', '', [float64(0), float64(0), float64(0)]),
        prop('ScalingPivot', 'Vector3D', 'Vector', '', [float64(0), float64(0), float64(0)]),
        prop('RotationOrder', 'enum', '', '', [int32(0)]),
        prop('InheritType', 'enum', '', '', [int32(0)]),
        prop('GeometricTranslation', 'Vector3D', 'Vector', '', [float64(0), float64(0), float64(0)]),
        prop('GeometricRotation', 'Vector3D', 'Vector', '', [float64(0), float64(0), float64(0)]),
        prop('GeometricScaling', 'Vector3D', 'Vector', '', [float64(1), float64(1), float64(1)]),
        prop('Show', 'bool', '', '', [bool(true)]),
        prop('Lcl Translation', 'Lcl Translation', '', 'A', [float64(0), float64(0), float64(0)]),
        prop('Lcl Rotation', 'Lcl Rotation', '', 'A', [float64(0), float64(0), float64(0)]),
        prop('Lcl Scaling', 'Lcl Scaling', '', 'A', [float64(1), float64(1), float64(1)]),
        prop('Visibility', 'Visibility', '', 'A', [float64(1)]),
        prop('Visibility Inheritance', 'Visibility Inheritance', '', '', [int32(1)]),
      ]),
    ]),
    node('ObjectType', [str('Material')], [
      node('Count', [int32(1)]),
      propertyTemplate('FbxSurfacePhong', [
        prop('ShadingModel', 'KString', '', '', [str('Phong')]),
        prop('DiffuseColor', 'Color', '', 'A', [float64(0.8), float64(0.8), float64(0.8)]),
        prop('DiffuseFactor', 'Number', '', 'A', [float64(1)]),
        prop('TransparencyFactor', 'Number', '', 'A', [float64(0)]),
        prop('Opacity', 'Number', '', 'A', [float64(1)]),
        prop('SpecularColor', 'Color', '', 'A', [float64(0.2), float64(0.2), float64(0.2)]),
        prop('SpecularFactor', 'Number', '', 'A', [float64(0)]),
        prop('Shininess', 'Number', '', 'A', [float64(20)]),
      ]),
    ]),
    node('ObjectType', [str('Texture')], [
      node('Count', [int32(textureCount)]),
      propertyTemplate('FbxFileTexture', [
        prop('TextureTypeUse', 'enum', '', '', [int32(0)]),
        prop('AlphaSource', 'enum', '', '', [int32(0)]),
        prop('Texture alpha', 'double', 'Number', '', [float64(1)]),
        prop('CurrentTextureBlendMode', 'enum', '', '', [int32(0)]),
        prop('CurrentMappingType', 'enum', '', '', [int32(0)]),
        prop('UVSet', 'KString', '', '', [str(UV_SET_NAME)]),
        prop('WrapModeU', 'enum', '', '', [int32(1)]),
        prop('WrapModeV', 'enum', '', '', [int32(1)]),
        prop('UseMaterial', 'bool', '', '', [bool(true)]),
        prop('UseMipMap', 'bool', '', '', [bool(false)]),
      ]),
    ]),
    node('ObjectType', [str('Video')], [
      node('Count', [int32(hasTexture ? 1 : 0)]),
      propertyTemplate('FbxVideo', [
        prop('Width', 'int', 'Integer', '', [int32(0)]),
        prop('Height', 'int', 'Integer', '', [int32(0)]),
        prop('Path', 'KString', 'Url', '', [str('')]),
        prop('AccessMode', 'enum', '', '', [int32(0)]),
      ]),
    ]),
  ]);
}

function createGlobalSettingsNode() {
  return node('GlobalSettings', [], [
    node('Version', [int32(1000)]),
    node('Properties70', [], [
      prop('UpAxis', 'int', 'Integer', '', [int32(1)]),
      prop('UpAxisSign', 'int', 'Integer', '', [int32(1)]),
      prop('FrontAxis', 'int', 'Integer', '', [int32(2)]),
      prop('FrontAxisSign', 'int', 'Integer', '', [int32(1)]),
      prop('CoordAxis', 'int', 'Integer', '', [int32(0)]),
      prop('CoordAxisSign', 'int', 'Integer', '', [int32(1)]),
      prop('UnitScaleFactor', 'double', 'Number', '', [float64(1)]),
      prop('OriginalUnitScaleFactor', 'double', 'Number', '', [float64(1)]),
    ]),
  ]);
}

function createHeaderNode() {
  return node('FBXHeaderExtension', [], [
    node('FBXHeaderVersion', [int32(1003)]),
    node('FBXVersion', [int32(FBX_VERSION)]),
    node('EncryptionType', [int32(0)]),
    node('CreationTimeStamp', [], [
      node('Version', [int32(1000)]),
      node('Year', [int32(2026)]),
      node('Month', [int32(1)]),
      node('Day', [int32(1)]),
      node('Hour', [int32(0)]),
      node('Minute', [int32(0)]),
      node('Second', [int32(0)]),
      node('Millisecond', [int32(0)]),
    ]),
    node('Creator', [str('Liclick 3D Texture')]),
  ]);
}

function createConnectionsNode(
  records: FbxMeshRecord[],
  materialId: number,
  textureId?: number,
  videoId?: number,
) {
  const children = records.flatMap((record) => [
    node('C', [str('OO'), int64(record.geometryId), int64(record.modelId)]),
    node('C', [str('OO'), int64(record.modelId), int64(0)]),
    node('C', [str('OO'), int64(materialId), int64(record.modelId)]),
  ]);

  if (textureId && videoId) {
    children.push(node('C', [str('OP'), int64(textureId), int64(materialId), str('DiffuseColor')]));
    children.push(node('C', [str('OO'), int64(videoId), int64(textureId)]));
  }

  return node('Connections', [], children);
}

function createFbxTree(input: {
  root: THREE.Object3D;
  textureFilename?: string;
  textureData?: Uint8Array;
  averageColor?: [number, number, number];
}) {
  const records = collectMeshRecords(input.root);
  if (records.length === 0) throw new Error('No mesh geometry is available for FBX export.');

  const materialId = 200000;
  const textureId = input.textureData ? 200001 : undefined;
  const videoId = input.textureData ? 200002 : undefined;
  const objectChildren: FbxNode[] = [
    ...records.map(createGeometryNode),
    ...records.map(createModelNode),
    createMaterialNode(materialId, input.textureData ? [1, 1, 1] : (input.averageColor ?? [1, 1, 1])),
  ];

  if (textureId && videoId && input.textureFilename && input.textureData) {
    objectChildren.push(...createTextureNodes({ textureId, videoId, data: input.textureData }));
  }

  return [
    createHeaderNode(),
    node('FileId', [bytes(new Uint8Array([0x28, 0xb3, 0x2a, 0xeb, 0xb6, 0x24, 0xcc, 0xc2, 0xbf, 0xc8, 0xb0, 0x2a, 0xa9, 0x2b, 0xfc, 0xf1]))]),
    node('CreationTime', [str('2026-01-01 00:00:00:000')]),
    node('Creator', [str('Liclick 3D Texture')]),
    createGlobalSettingsNode(),
    createDocumentNode(),
    node('References'),
    createDefinitionsNode(records, Boolean(input.textureData)),
    node('Objects', [], objectChildren),
    createConnectionsNode(records, materialId, textureId, videoId),
    node('Takes', [], [node('Current', [str('')])]),
  ];
}

function utf8(value: string) {
  return new TextEncoder().encode(value);
}

function uint8(value: number) {
  return new Uint8Array([value & 0xff]);
}

function uint32(value: number) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

function int32Bytes(value: number) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, value, true);
  return out;
}

function int64Bytes(value: number) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigInt64(0, BigInt(value), true);
  return out;
}

function float64Bytes(value: number) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, value, true);
  return out;
}

function stringPayload(value: string) {
  const data = utf8(value);
  return concatBytes([uint32(data.length), data]);
}

function arrayHeader(length: number, encoding: number, byteLength: number) {
  return concatBytes([uint32(length), uint32(encoding), uint32(byteLength)]);
}

function int32ArrayBody(values: number[]) {
  const body = new Uint8Array(values.length * 4);
  const view = new DataView(body.buffer);
  values.forEach((value, index) => view.setInt32(index * 4, value, true));
  return body;
}

function float64ArrayBody(values: number[]) {
  const body = new Uint8Array(values.length * 8);
  const view = new DataView(body.buffer);
  values.forEach((value, index) => view.setFloat64(index * 8, sanitizeNumber(value), true));
  return body;
}

function encodedArrayPayload(value: Extract<FbxValue, { type: 'int32Array' | 'float64Array' }>) {
  if (value.encodedPayload) return value.encodedPayload;
  const body = value.type === 'int32Array' ? int32ArrayBody(value.value) : float64ArrayBody(value.value);
  const compressed = zlibSync(body, { level: 6 });
  value.encodedPayload = concatBytes([arrayHeader(value.value.length, 1, compressed.byteLength), compressed]);
  return value.encodedPayload;
}

function valueToBytes(value: FbxValue) {
  switch (value.type) {
    case 'bool':
      return concatBytes([uint8(0x43), uint8(value.value ? 1 : 0)]);
    case 'int32':
      return concatBytes([uint8(0x49), int32Bytes(value.value)]);
    case 'int64':
      return concatBytes([uint8(0x4c), int64Bytes(value.value)]);
    case 'float64':
      return concatBytes([uint8(0x44), float64Bytes(value.value)]);
    case 'string':
      return concatBytes([uint8(0x53), stringPayload(value.value)]);
    case 'bytes':
      return concatBytes([uint8(0x52), uint32(value.value.byteLength), value.value]);
    case 'int32Array':
      return concatBytes([uint8(0x69), encodedArrayPayload(value)]);
    case 'float64Array':
      return concatBytes([uint8(0x64), encodedArrayPayload(value)]);
    default:
      return new Uint8Array();
  }
}

function valuePayloadLength(value: FbxValue) {
  switch (value.type) {
    case 'bool':
      return 1;
    case 'int32':
      return 4;
    case 'int64':
    case 'float64':
      return 8;
    case 'string':
      return 4 + utf8(value.value).byteLength;
    case 'bytes':
      return 4 + value.value.byteLength;
    case 'int32Array':
    case 'float64Array':
      return encodedArrayPayload(value).byteLength;
    default:
      return 0;
  }
}

function calculateEndOffset(fbxNode: FbxNode, startOffset: number, isLast: boolean): number {
  const nameBytes = utf8(fbxNode.name);
  const props = fbxNode.props ?? [];
  const children = fbxNode.children ?? [];
  let offset = startOffset + 12 + 1 + nameBytes.byteLength;
  offset += props.reduce((sum, value) => sum + 1 + valuePayloadLength(value), 0);

  if (children.length > 0) {
    children.forEach((child, index) => {
      offset = calculateEndOffset(child, offset, index === children.length - 1);
    });
    offset += BLOCK_SENTINEL_SIZE;
  }

  return offset;
}

function writeNode(fbxNode: FbxNode, startOffset: number, isLast: boolean): Uint8Array {
  const nameBytes = utf8(fbxNode.name);
  const props = fbxNode.props ?? [];
  const children = fbxNode.children ?? [];
  const propBytes = props.map(valueToBytes);
  const propListLength = propBytes.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const endOffset = calculateEndOffset(fbxNode, startOffset, isLast);
  const chunks: Uint8Array[] = [
    uint32(endOffset),
    uint32(props.length),
    uint32(propListLength),
    uint8(nameBytes.byteLength),
    nameBytes,
    ...propBytes,
  ];

  let childOffset = startOffset + chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  children.forEach((child, index) => {
    const childBytes = writeNode(child, childOffset, index === children.length - 1);
    chunks.push(childBytes);
    childOffset += childBytes.byteLength;
  });

  if (children.length > 0) {
    chunks.push(new Uint8Array(BLOCK_SENTINEL_SIZE));
  }

  return concatBytes(chunks);
}

function concatBytes(chunks: Uint8Array[]) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  chunks.forEach((chunk) => {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  });
  return output;
}

function createFbxBinary(input: {
  root: THREE.Object3D;
  textureFilename?: string;
  textureData?: Uint8Array;
  averageColor?: [number, number, number];
}) {
  const nodes = createFbxTree(input);
  const chunks: Uint8Array[] = [FBX_HEADER, uint32(FBX_VERSION)];
  let offset = FBX_HEADER.byteLength + 4;

  nodes.forEach((fbxNode, index) => {
    const nodeBytes = writeNode(fbxNode, offset, index === nodes.length - 1);
    chunks.push(nodeBytes);
    offset += nodeBytes.byteLength;
  });

  chunks.push(new Uint8Array(BLOCK_SENTINEL_SIZE));
  offset += BLOCK_SENTINEL_SIZE;
  chunks.push(FBX_FOOT_ID, new Uint8Array(4));
  offset += FBX_FOOT_ID.byteLength + 4;

  const padding = ((offset + 15) & ~15) - offset || 16;
  chunks.push(new Uint8Array(padding), uint32(FBX_VERSION), new Uint8Array(120), FBX_END_MAGIC);

  return concatBytes(chunks);
}

export async function exportModelFbx(input: ModelExportInput) {
  const { root, textureBlob, textureFilename, averageColor } = await prepareTexturedModelExport(input);
  const fbxFilename = getExportFilename(input.project.name, input.target, 'fbx');
  const textureData = textureBlob ? new Uint8Array(await textureBlob.arrayBuffer()) : undefined;
  const fbx = createFbxBinary({ root, textureFilename, textureData, averageColor });
  downloadBlob(new Blob([fbx], { type: 'application/octet-stream' }), fbxFilename);
}
