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
  normalIndex: number[];
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
const FBX_MEDIA_FOLDER = 'liclick_export.fbm';
const FBX_MEDIA_ABSOLUTE_FOLDER = `/tmp/${FBX_MEDIA_FOLDER}`;
const FBX_MEDIA_FILE = 'liclick_image_0.png';
const UV_SET_NAME = 'UVMap';
const FBX_ENGINE_SIZE_CORRECTION = 100 / 3;
const FBX_RAW_ARRAY_BYTE_THRESHOLD = 16;
const FBX_GEOMETRY_ID_BASE = 496925943;
const FBX_MODEL_ID_BASE = 192504012;
const FBX_MATERIAL_ID = 949933121;
const FBX_DOCUMENT_ID = 97486879;
const FBX_BLENDER_CREATOR = 'Blender (stable FBX IO) - 5.1.1 - 5.15.0';
const FBX_BLENDER_APP_NAME = 'Blender (stable FBX IO)';
const FBX_BLENDER_APP_VENDOR = 'Blender Foundation';
const FBX_BLENDER_APP_VERSION = '5.1.1';

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

function tupleKey(values: number[]) {
  return values.map((value) => Math.round(value * 1_000_000)).join(',');
}

function pushIndexedTuple(table: number[], lookup: Map<string, number>, values: number[], keyPrefix = '') {
  const key = `${keyPrefix}${tupleKey(values)}`;
  const existing = lookup.get(key);
  if (existing !== undefined) return existing;
  const index = table.length / values.length;
  values.forEach((value) => table.push(sanitizeNumber(value)));
  lookup.set(key, index);
  return index;
}

function collectMeshRecords(root: THREE.Object3D) {
  const records: FbxMeshRecord[] = [];
  const position = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const uv = new THREE.Vector2();
  let nextRecordIndex = 0;

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
      geometryId: FBX_GEOMETRY_ID_BASE + nextRecordIndex,
      modelId: FBX_MODEL_ID_BASE + nextRecordIndex,
      name: sanitizeName(child.name, `Mesh_${records.length + 1}`),
      vertices: [],
      polygonVertexIndex: [],
      normals: [],
      normalIndex: [],
      uvs: [],
      uvIndex: [],
      edges: [],
    };
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(child.matrixWorld);
    const vertexLookup = new Map<string, number>();
    const normalLookup = new Map<string, number>();
    const uvLookup = new Map<string, number>();
    const edgeLookup = new Set<string>();

    for (let triangle = 0; triangle < triangleCount; triangle += 1) {
      const polygonVertexIndices: number[] = [];
      for (let corner = 0; corner < 3; corner += 1) {
        const sourceIndex = index ? index.getX(triangle * 3 + corner) : triangle * 3 + corner;
        const vertexIndex = Math.max(0, Math.min(sourceIndex, positions.count - 1));

        position.fromBufferAttribute(positions, vertexIndex).applyMatrix4(child.matrixWorld);
        const exportedVertexIndex = pushIndexedTuple(record.vertices, vertexLookup, [position.x, position.y, position.z]);
        polygonVertexIndices.push(exportedVertexIndex);

        if (normals && vertexIndex < normals.count) {
          normal.fromBufferAttribute(normals, vertexIndex).applyMatrix3(normalMatrix).normalize();
        } else {
          normal.set(0, 1, 0);
        }
        record.normalIndex.push(
          pushIndexedTuple(record.normals, normalLookup, [normal.x, normal.y, normal.z], `${sourceIndex}|`),
        );

        if (uvs && vertexIndex < uvs.count) {
          uv.fromBufferAttribute(uvs, vertexIndex);
          record.uvIndex.push(pushIndexedTuple(record.uvs, uvLookup, [uv.x, uv.y], `${exportedVertexIndex}|`));
        } else {
          record.uvIndex.push(pushIndexedTuple(record.uvs, uvLookup, [0, 0], `${exportedVertexIndex}|`));
        }
        record.polygonVertexIndex.push(corner === 2 ? -(exportedVertexIndex + 1) : exportedVertexIndex);
      }

      for (let corner = 0; corner < 3; corner += 1) {
        const a = polygonVertexIndices[corner];
        const b = polygonVertexIndices[(corner + 1) % 3];
        const key = a < b ? `${a}:${b}` : `${b}:${a}`;
        if (!edgeLookup.has(key)) {
          edgeLookup.add(key);
          record.edges.push(triangle * 3 + corner);
        }
      }
    }
    records.push(record);
    nextRecordIndex += 1;
  });

  return records;
}

function createGeometryNode(record: FbxMeshRecord) {
  return node('Geometry', [int64(record.geometryId), str(className(`${record.name}.003`, 'Geometry')), str('Mesh')], [
    node('Properties70'),
    node('GeometryVersion', [int32(124)]),
    node('Vertices', [float64Array(record.vertices)]),
    node('PolygonVertexIndex', [int32Array(record.polygonVertexIndex)]),
    node('Edges', [int32Array(record.edges)]),
    node('LayerElementNormal', [int32(0)], [
      node('Version', [int32(101)]),
      node('Name', [str('')]),
      node('MappingInformationType', [str('ByPolygonVertex')]),
      node('ReferenceInformationType', [str('IndexToDirect')]),
      node('Normals', [float64Array(record.normals)]),
      node('NormalsIndex', [int32Array(record.normalIndex)]),
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
      node('LayerElement', [], [node('Type', [str('LayerElementUV')]), node('TypedIndex', [int32(0)])]),
      node('LayerElement', [], [node('Type', [str('LayerElementMaterial')]), node('TypedIndex', [int32(0)])]),
    ]),
  ]);
}

function createModelNode(record: FbxMeshRecord) {
  return node('Model', [int64(record.modelId), str(className(record.name, 'Model')), str('Mesh')], [
    node('Version', [int32(232)]),
    node('Properties70', [], [
      prop('Lcl Rotation', 'Lcl Rotation', '', 'A', [float64(-0.0000043257111045250854), float64(0), float64(0)]),
      prop('Lcl Scaling', 'Lcl Scaling', '', 'A', [
        float64(FBX_ENGINE_SIZE_CORRECTION),
        float64(FBX_ENGINE_SIZE_CORRECTION),
        float64(FBX_ENGINE_SIZE_CORRECTION),
      ]),
      prop('DefaultAttributeIndex', 'int', 'Integer', '', [int32(0)]),
      prop('InheritType', 'enum', '', '', [int32(1)]),
    ]),
    node('MultiLayer', [int32(0)]),
    node('MultiTake', [int32(0)]),
    node('Shading', [bool(true)]),
    node('Culling', [str('CullingOff')]),
  ]);
}

function createMaterialNode(materialId: number, averageColor: [number, number, number]) {
  return node('Material', [int64(materialId), str(className(`${EXPORT_BASECOLOR_MATERIAL_NAME}.003`, 'Material')), str('')], [
    node('Version', [int32(102)]),
    node('ShadingModel', [str('Phong')]),
    node('MultiLayer', [int32(0)]),
    node('Properties70', [], [
      prop('DiffuseColor', 'Color', '', 'A', averageColor.map(float64)),
      prop('EmissiveColor', 'Color', '', 'A', [float64(1), float64(1), float64(1)]),
      prop('EmissiveFactor', 'Number', '', 'A', [float64(0)]),
      prop('AmbientColor', 'Color', '', 'A', [
        float64(0.05087608844041824),
        float64(0.05087608844041824),
        float64(0.05087608844041824),
      ]),
      prop('AmbientFactor', 'Number', '', 'A', [float64(0)]),
      prop('BumpFactor', 'double', 'Number', '', [float64(0)]),
      prop('SpecularColor', 'Color', '', 'A', [float64(1), float64(1), float64(1)]),
      prop('SpecularFactor', 'Number', '', 'A', [float64(0.25)]),
      prop('Shininess', 'Number', '', 'A', [float64(0)]),
      prop('ShininessExponent', 'Number', '', 'A', [float64(0)]),
      prop('ReflectionColor', 'Color', '', 'A', [float64(1), float64(1), float64(1)]),
      prop('ReflectionFactor', 'Number', '', 'A', [float64(0)]),
    ]),
  ]);
}

function createTextureNode(input: {
  textureId: number;
  name: string;
  videoName: string;
  fileName: string;
  relativeFileName: string;
}) {
  return node('Texture', [int64(input.textureId), str(className(input.name, 'Texture')), str('')], [
    node('Type', [str('TextureVideoClip')]),
    node('Version', [int32(202)]),
    node('TextureName', [str(className(input.name, 'Texture'))]),
    node('Media', [str(className(input.videoName, 'Video'))]),
    node('FileName', [str(input.fileName)]),
    node('RelativeFilename', [str(input.relativeFileName)]),
    node('Properties70', [], [
      prop('PremultiplyAlpha', 'bool', '', '', [int32(0)]),
      prop('WrapModeU', 'enum', '', '', [int32(1)]),
      prop('WrapModeV', 'enum', '', '', [int32(1)]),
      prop('UseMaterial', 'bool', '', '', [int32(1)]),
    ]),
  ]);
}

function createVideoNode(input: {
  videoId: number;
  videoName: string;
  fileName: string;
  relativeFileName: string;
  data: Uint8Array;
}) {
  return node('Video', [int64(input.videoId), str(className(input.videoName, 'Video')), str('Clip')], [
    node('Type', [str('Clip')]),
    node('Properties70', [], [prop('Path', 'KString', 'Url', '', [str(input.fileName)])]),
    node('UseMipMap', [int32(0)]),
    node('Filename', [str(input.fileName)]),
    node('RelativeFilename', [str(input.relativeFileName)]),
    node('Content', [bytes(input.data)]),
  ]);
}

function createTextureNodes(input: {
  textureId: number;
  videoId: number;
  data: Uint8Array;
}) {
  const baseVideoName = FBX_MEDIA_FILE;
  const baseRelativeFileName = `${FBX_MEDIA_FOLDER}/${FBX_MEDIA_FILE}`;
  const baseFileName = `${FBX_MEDIA_ABSOLUTE_FOLDER}/${FBX_MEDIA_FILE}`;
  return [
    createTextureNode({
      textureId: input.textureId,
      name: TEXTURE_SOCKET_NAME,
      videoName: baseVideoName,
      fileName: baseFileName,
      relativeFileName: baseRelativeFileName,
    }),
    createVideoNode({
      videoId: input.videoId,
      videoName: baseVideoName,
      fileName: baseFileName,
      relativeFileName: baseRelativeFileName,
      data: input.data,
    }),
  ];
}

function createDocumentNode() {
  return node('Documents', [], [
    node('Count', [int32(1)]),
    node('Document', [int64(FBX_DOCUMENT_ID), str('Scene'), str('Scene')], [
      node('Properties70', [], [
        prop('SourceObject', 'object', '', ''),
        prop('ActiveAnimStackName', 'KString', '', '', [str('')]),
      ]),
      node('RootNode', [int64(0)]),
    ]),
  ]);
}

function createSceneInfoNode() {
  return node('SceneInfo', [str(className('GlobalInfo', 'SceneInfo')), str('UserData')], [
    node('Type', [str('UserData')]),
    node('Version', [int32(100)]),
    node('MetaData', [], [
      node('Version', [int32(100)]),
      node('Title', [str('')]),
      node('Subject', [str('')]),
      node('Author', [str('')]),
      node('Keywords', [str('')]),
      node('Revision', [str('')]),
      node('Comment', [str('')]),
    ]),
    node('Properties70', [], [
      prop('DocumentUrl', 'KString', 'Url', '', [str('/foobar.fbx')]),
      prop('SrcDocumentUrl', 'KString', 'Url', '', [str('/foobar.fbx')]),
      prop('Original', 'Compound', '', ''),
      prop('Original|ApplicationVendor', 'KString', '', '', [str(FBX_BLENDER_APP_VENDOR)]),
      prop('Original|ApplicationName', 'KString', '', '', [str(FBX_BLENDER_APP_NAME)]),
      prop('Original|ApplicationVersion', 'KString', '', '', [str(FBX_BLENDER_APP_VERSION)]),
      prop('Original|DateTime_GMT', 'DateTime', '', '', [str('01/01/1970 00:00:00.000')]),
      prop('Original|FileName', 'KString', '', '', [str('/foobar.fbx')]),
      prop('LastSaved', 'Compound', '', ''),
      prop('LastSaved|ApplicationVendor', 'KString', '', '', [str(FBX_BLENDER_APP_VENDOR)]),
      prop('LastSaved|ApplicationName', 'KString', '', '', [str(FBX_BLENDER_APP_NAME)]),
      prop('LastSaved|ApplicationVersion', 'KString', '', '', [str(FBX_BLENDER_APP_VERSION)]),
      prop('LastSaved|DateTime_GMT', 'DateTime', '', '', [str('01/01/1970 00:00:00.000')]),
      prop('Original|ApplicationNativeFile', 'KString', '', '', [str('')]),
    ]),
  ]);
}

function createDefinitionsNode(records: FbxMeshRecord[], hasTexture: boolean) {
  const textureCount = hasTexture ? 1 : 0;
  const videoCount = hasTexture ? 1 : 0;
  const objectCount = 1 + records.length * 2 + 1 + textureCount + videoCount;
  const children = [
    node('Version', [int32(100)]),
    node('Count', [int32(objectCount)]),
    node('ObjectType', [str('GlobalSettings')], [node('Count', [int32(1)])]),
    node('ObjectType', [str('Geometry')], [
      node('Count', [int32(records.length)]),
      propertyTemplate('FbxMesh', [
        prop('Color', 'ColorRGB', 'Color', '', [float64(0.8), float64(0.8), float64(0.8)]),
        prop('BBoxMin', 'Vector3D', 'Vector', '', [float64(0), float64(0), float64(0)]),
        prop('BBoxMax', 'Vector3D', 'Vector', '', [float64(0), float64(0), float64(0)]),
        prop('Primary Visibility', 'bool', '', '', [int32(1)]),
        prop('Casts Shadows', 'bool', '', '', [int32(1)]),
        prop('Receive Shadows', 'bool', '', '', [int32(1)]),
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
        prop('TranslationActive', 'bool', '', '', [int32(0)]),
        prop('TranslationMin', 'Vector3D', 'Vector', '', [float64(0), float64(0), float64(0)]),
        prop('TranslationMax', 'Vector3D', 'Vector', '', [float64(0), float64(0), float64(0)]),
        prop('TranslationMinX', 'bool', '', '', [int32(0)]),
        prop('TranslationMinY', 'bool', '', '', [int32(0)]),
        prop('TranslationMinZ', 'bool', '', '', [int32(0)]),
        prop('TranslationMaxX', 'bool', '', '', [int32(0)]),
        prop('TranslationMaxY', 'bool', '', '', [int32(0)]),
        prop('TranslationMaxZ', 'bool', '', '', [int32(0)]),
        prop('RotationOrder', 'enum', '', '', [int32(0)]),
        prop('RotationSpaceForLimitOnly', 'bool', '', '', [int32(0)]),
        prop('RotationStiffnessX', 'double', 'Number', '', [float64(0)]),
        prop('RotationStiffnessY', 'double', 'Number', '', [float64(0)]),
        prop('RotationStiffnessZ', 'double', 'Number', '', [float64(0)]),
        prop('AxisLen', 'double', 'Number', '', [float64(10)]),
        prop('PreRotation', 'Vector3D', 'Vector', '', [float64(0), float64(0), float64(0)]),
        prop('PostRotation', 'Vector3D', 'Vector', '', [float64(0), float64(0), float64(0)]),
        prop('RotationActive', 'bool', '', '', [int32(0)]),
        prop('RotationMin', 'Vector3D', 'Vector', '', [float64(0), float64(0), float64(0)]),
        prop('RotationMax', 'Vector3D', 'Vector', '', [float64(0), float64(0), float64(0)]),
        prop('RotationMinX', 'bool', '', '', [int32(0)]),
        prop('RotationMinY', 'bool', '', '', [int32(0)]),
        prop('RotationMinZ', 'bool', '', '', [int32(0)]),
        prop('RotationMaxX', 'bool', '', '', [int32(0)]),
        prop('RotationMaxY', 'bool', '', '', [int32(0)]),
        prop('RotationMaxZ', 'bool', '', '', [int32(0)]),
        prop('InheritType', 'enum', '', '', [int32(0)]),
        prop('ScalingActive', 'bool', '', '', [int32(0)]),
        prop('ScalingMin', 'Vector3D', 'Vector', '', [float64(0), float64(0), float64(0)]),
        prop('ScalingMax', 'Vector3D', 'Vector', '', [float64(1), float64(1), float64(1)]),
        prop('ScalingMinX', 'bool', '', '', [int32(0)]),
        prop('ScalingMinY', 'bool', '', '', [int32(0)]),
        prop('ScalingMinZ', 'bool', '', '', [int32(0)]),
        prop('ScalingMaxX', 'bool', '', '', [int32(0)]),
        prop('ScalingMaxY', 'bool', '', '', [int32(0)]),
        prop('ScalingMaxZ', 'bool', '', '', [int32(0)]),
        prop('GeometricTranslation', 'Vector3D', 'Vector', '', [float64(0), float64(0), float64(0)]),
        prop('GeometricRotation', 'Vector3D', 'Vector', '', [float64(0), float64(0), float64(0)]),
        prop('GeometricScaling', 'Vector3D', 'Vector', '', [float64(1), float64(1), float64(1)]),
        prop('MinDampRangeX', 'double', 'Number', '', [float64(0)]),
        prop('MinDampRangeY', 'double', 'Number', '', [float64(0)]),
        prop('MinDampRangeZ', 'double', 'Number', '', [float64(0)]),
        prop('MaxDampRangeX', 'double', 'Number', '', [float64(0)]),
        prop('MaxDampRangeY', 'double', 'Number', '', [float64(0)]),
        prop('MaxDampRangeZ', 'double', 'Number', '', [float64(0)]),
        prop('MinDampStrengthX', 'double', 'Number', '', [float64(0)]),
        prop('MinDampStrengthY', 'double', 'Number', '', [float64(0)]),
        prop('MinDampStrengthZ', 'double', 'Number', '', [float64(0)]),
        prop('MaxDampStrengthX', 'double', 'Number', '', [float64(0)]),
        prop('MaxDampStrengthY', 'double', 'Number', '', [float64(0)]),
        prop('MaxDampStrengthZ', 'double', 'Number', '', [float64(0)]),
        prop('PreferedAngleX', 'double', 'Number', '', [float64(0)]),
        prop('PreferedAngleY', 'double', 'Number', '', [float64(0)]),
        prop('PreferedAngleZ', 'double', 'Number', '', [float64(0)]),
        prop('LookAtProperty', 'object', '', ''),
        prop('UpVectorProperty', 'object', '', ''),
        prop('Show', 'bool', '', '', [int32(1)]),
        prop('NegativePercentShapeSupport', 'bool', '', '', [int32(1)]),
        prop('DefaultAttributeIndex', 'int', 'Integer', '', [int32(-1)]),
        prop('Freeze', 'bool', '', '', [int32(0)]),
        prop('LODBox', 'bool', '', '', [int32(0)]),
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
        prop('MultiLayer', 'bool', '', '', [int32(0)]),
        prop('EmissiveColor', 'Color', '', 'A', [float64(0), float64(0), float64(0)]),
        prop('EmissiveFactor', 'Number', '', 'A', [float64(1)]),
        prop('AmbientColor', 'Color', '', 'A', [float64(0.2), float64(0.2), float64(0.2)]),
        prop('AmbientFactor', 'Number', '', 'A', [float64(1)]),
        prop('DiffuseColor', 'Color', '', 'A', [float64(0.8), float64(0.8), float64(0.8)]),
        prop('DiffuseFactor', 'Number', '', 'A', [float64(1)]),
        prop('TransparentColor', 'Color', '', 'A', [float64(0), float64(0), float64(0)]),
        prop('TransparencyFactor', 'Number', '', 'A', [float64(0)]),
        prop('Opacity', 'Number', '', 'A', [float64(1)]),
        prop('NormalMap', 'Vector3D', 'Vector', '', [float64(0), float64(0), float64(0)]),
        prop('Bump', 'Vector3D', 'Vector', '', [float64(0), float64(0), float64(0)]),
        prop('BumpFactor', 'double', 'Number', '', [float64(1)]),
        prop('DisplacementColor', 'ColorRGB', 'Color', '', [float64(0), float64(0), float64(0)]),
        prop('DisplacementFactor', 'double', 'Number', '', [float64(1)]),
        prop('VectorDisplacementColor', 'ColorRGB', 'Color', '', [float64(0), float64(0), float64(0)]),
        prop('VectorDisplacementFactor', 'double', 'Number', '', [float64(1)]),
        prop('SpecularColor', 'Color', '', 'A', [float64(0.2), float64(0.2), float64(0.2)]),
        prop('SpecularFactor', 'Number', '', 'A', [float64(1)]),
        prop('Shininess', 'Number', '', 'A', [float64(20)]),
        prop('ShininessExponent', 'Number', '', 'A', [float64(20)]),
        prop('ReflectionColor', 'Color', '', 'A', [float64(0), float64(0), float64(0)]),
        prop('ReflectionFactor', 'Number', '', 'A', [float64(1)]),
      ]),
    ]),
  ];

  if (hasTexture) {
    children.push(
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
        prop('UseMaterial', 'bool', '', '', [int32(1)]),
        prop('UseMipMap', 'bool', '', '', [int32(0)]),
      ]),
    ]),
    node('ObjectType', [str('Video')], [
      node('Count', [int32(videoCount)]),
      propertyTemplate('FbxVideo', [
        prop('Width', 'int', 'Integer', '', [int32(0)]),
        prop('Height', 'int', 'Integer', '', [int32(0)]),
        prop('Path', 'KString', 'Url', '', [str('')]),
        prop('AccessMode', 'enum', '', '', [int32(0)]),
      ]),
    ]),
    );
  }

  return node('Definitions', [], children);
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
      prop('OriginalUpAxis', 'int', 'Integer', '', [int32(-1)]),
      prop('OriginalUpAxisSign', 'int', 'Integer', '', [int32(1)]),
      prop('UnitScaleFactor', 'double', 'Number', '', [float64(1)]),
      prop('OriginalUnitScaleFactor', 'double', 'Number', '', [float64(1)]),
      prop('AmbientColor', 'ColorRGB', 'Color', '', [float64(0), float64(0), float64(0)]),
      prop('DefaultCamera', 'KString', '', '', [str('Producer Perspective')]),
      prop('TimeMode', 'enum', '', '', [int32(11)]),
      prop('TimeSpanStart', 'KTime', 'Time', '', [int64(0)]),
      prop('TimeSpanStop', 'KTime', 'Time', '', [int64(46186158000)]),
      prop('CustomFrameRate', 'double', 'Number', '', [float64(24)]),
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
      node('Month', [int32(7)]),
      node('Day', [int32(3)]),
      node('Hour', [int32(11)]),
      node('Minute', [int32(58)]),
      node('Second', [int32(12)]),
      node('Millisecond', [int32(703)]),
    ]),
    node('Creator', [str(FBX_BLENDER_CREATOR)]),
    createSceneInfoNode(),
  ]);
}

function createConnectionsNode(
  records: FbxMeshRecord[],
  materialId: number,
  textureId?: number,
  videoId?: number,
) {
  const children = records.flatMap((record) => [
    node('C', [str('OO'), int64(record.modelId), int64(0)]),
    node('C', [str('OO'), int64(record.geometryId), int64(record.modelId)]),
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
  textureData?: Uint8Array;
  averageColor?: [number, number, number];
}) {
  const records = collectMeshRecords(input.root);
  if (records.length === 0) throw new Error('No mesh geometry is available for FBX export.');

  const materialId = FBX_MATERIAL_ID;
  const textureId = input.textureData ? FBX_MATERIAL_ID + 1 : undefined;
  const videoId = input.textureData ? FBX_MATERIAL_ID + 2 : undefined;
  const objectChildren: FbxNode[] = [
    ...records.map(createGeometryNode),
    ...records.map(createModelNode),
    createMaterialNode(materialId, input.textureData ? [0.800000011920929, 0.800000011920929, 0.800000011920929] : (input.averageColor ?? [1, 1, 1])),
  ];

  if (textureId && videoId && input.textureData) {
    objectChildren.push(...createTextureNodes({
      textureId,
      videoId,
      data: input.textureData,
    }));
  }

  return [
    createHeaderNode(),
    node('FileId', [bytes(new Uint8Array([0x28, 0xb3, 0x2a, 0xeb, 0xb6, 0x24, 0xcc, 0xc2, 0xbf, 0xc8, 0xb0, 0x2a, 0xa9, 0x2b, 0xfc, 0xf1]))]),
    node('CreationTime', [str('1970-01-01 10:00:00:000')]),
    node('Creator', [str(FBX_BLENDER_CREATOR)]),
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
  if (body.byteLength <= FBX_RAW_ARRAY_BYTE_THRESHOLD || compressed.byteLength >= body.byteLength) {
    value.encodedPayload = concatBytes([arrayHeader(value.value.length, 0, body.byteLength), body]);
    return value.encodedPayload;
  }
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

function calculateEndOffset(fbxNode: FbxNode, startOffset: number, _isLast: boolean): number {
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

async function createPngTextureData(blob: Blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d');
  if (!context) {
    bitmap.close();
    return new Uint8Array(await blob.arrayBuffer());
  }
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const pngBlob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  return pngBlob ? new Uint8Array(await pngBlob.arrayBuffer()) : new Uint8Array(await blob.arrayBuffer());
}

export async function exportModelFbx(input: ModelExportInput) {
  // FBX importers do not consistently preserve the alpha semantics of an
  // embedded base-color PNG. In Blender, transparent and feathered UV texels
  // were interpreted against the material color and exposed the sparse bake as
  // stripes and speckles. Export the same opaque final composition used by the
  // viewport, OBJ and GLB paths so the embedded texture is self-contained.
  const { root, textureBlob, textureFilename, averageColor } = await prepareTexturedModelExport(input);
  const fbxFilename = getExportFilename(input.project.name, input.target, 'fbx');
  if (textureBlob && textureFilename) {
    const textureData = await createPngTextureData(textureBlob);
    const fbx = createFbxBinary({ root, textureData, averageColor });
    downloadBlob(new Blob([fbx], { type: 'application/octet-stream' }), fbxFilename);
    return;
  }
  const fbx = createFbxBinary({ root, averageColor });
  downloadBlob(new Blob([fbx], { type: 'application/octet-stream' }), fbxFilename);
}
