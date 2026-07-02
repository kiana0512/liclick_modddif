import { zlibSync } from 'fflate';
import * as THREE from 'three';
import { createZipBlob } from './exportZip';
import { downloadBlob, slugifyExportName } from './exportUtils';
import { validateComfyControlExportPackage } from './comfyControlInputExporterValidation';
import type { ModelLoadResult } from '@/engine/loaders/modelImportTypes';
import type { ViewportRuntime } from '@/stores/sceneStore';
import type { Project, ReferenceImage } from '@/types/project';

export interface ComfyControlExportOptions {
  modelId?: string;
  viewId?: string;
  outputRoot?: string;
  width?: number;
  height?: number;
  exportCurrentViewOnly?: boolean;
  exportCanonicalViews?: boolean;
  canonicalViews?: Array<'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso'>;
  includeMaterialReference?: boolean;
  includeCurrentTextureRender?: boolean;
  includeMissingMask?: boolean;
  includeDepth?: boolean;
  includeNormal?: boolean;
  includePosition?: boolean;
  includeEdge?: boolean;
  includeAO?: boolean;
  includeCurvature?: boolean;
  includeIdBuffers?: boolean;
  includeUVBuffers?: boolean;
  includePoseBuffers?: boolean;
  includeAngleBuffers?: boolean;
  includeVisibilityBuffers?: boolean;
  linearDepth?: boolean;
  saveExr?: boolean;
  savePng16?: boolean;
  saveDebugPng8?: boolean;
  transparentBackground?: boolean;
  backgroundColor?: [number, number, number, number];
  materialPrompt?: string;
  negativePrompt?: string;
  seed?: number;
}

export type ComfyControlInputExporterRequest = {
  project: Project;
  viewport: ViewportRuntime;
  importedModel: ModelLoadResult;
  selectedObjectId?: string;
  references?: ReferenceImage[];
  options?: ComfyControlExportOptions;
};

export type ComfyControlExportResult = {
  zipBlob: Blob;
  filename: string;
  rootPrefix: string;
  manifest: ComfyControlManifest;
  comfyuiInputs: unknown;
  validation: ReturnType<typeof validateComfyControlExportPackage>;
};

type ZipFile = Parameters<typeof createZipBlob>[0][number];

type FileManifestEntry = {
  available: boolean;
  type?: string;
  bit_depth?: number;
  channels?: string[];
  color_space?: string;
  value_space?: string;
  unit?: string;
  normalization?: string | null;
  width?: number;
  height?: number;
  hash?: string;
  description?: string;
  generated_from?: string;
  reason?: string;
};

type ComfyControlManifest = {
  schema_version: string;
  exporter_version: string;
  created_at: string;
  model: Record<string, unknown>;
  view: Record<string, unknown>;
  files: Record<string, FileManifestEntry>;
  depth: Record<string, unknown>;
  coordinate_system: Record<string, unknown>;
  warnings: string[];
  errors: string[];
};

type RenderedImage = {
  imageData: ImageData;
  blob: Blob;
};

type TargetMeshSnapshot = {
  object: THREE.Object3D;
  visible: boolean;
  material?: THREE.Material | THREE.Material[];
};

const exporterVersion = '0.1.0';
const textEncoder = new TextEncoder();

const expectedFiles = [
  'render/01_white_render.png',
  'render/02_clay_render.png',
  'render/03_current_texture_render.png',
  'render/04_albedo_render.png',
  'render/05_lit_render_debug.png',
  'masks/01_object_mask.png',
  'masks/02_object_mask_soft.png',
  'masks/03_missing_mask.png',
  'masks/04_visible_mask.png',
  'masks/05_background_mask.png',
  'masks/06_occlusion_mask.png',
  'masks/07_selection_mask.png',
  'geometry/01_depth_linear.exr',
  'geometry/01_depth_linear_16.png',
  'geometry/01_depth_preview_8.png',
  'geometry/02_depth_inverse_16.png',
  'geometry/03_depth_normalized_16.png',
  'geometry/04_position_world.exr',
  'geometry/05_position_object.exr',
  'geometry/06_position_view.exr',
  'geometry/07_normal_world.png',
  'geometry/08_normal_view.png',
  'geometry/09_normal_object.png',
  'geometry/10_normal_tangent.png',
  'geometry/11_view_direction.png',
  'geometry/12_facing_ratio.png',
  'geometry/13_camera_angle.png',
  'geometry/14_surface_angle.png',
  'edges/01_silhouette_edge.png',
  'edges/02_depth_edge.png',
  'edges/03_normal_edge.png',
  'edges/04_combined_edge.png',
  'edges/05_canny_ready_edge.png',
  'edges/06_hed_soft_edge.png',
  'edges/07_scribble_edge.png',
  'edges/08_mlsd_line_map.png',
  'edges/09_curvature_edge.png',
  'edges/10_uv_seam_edge.png',
  'edges/11_material_boundary_edge.png',
  'ids/01_part_id.png',
  'ids/02_material_id.png',
  'ids/03_face_id.exr',
  'ids/04_face_id_preview.png',
  'ids/05_mesh_id.png',
  'ids/06_instance_id.png',
  'material/01_material_reference.png',
  'material/02_material_reference_cropped.png',
  'material/03_color_hint.png',
  'material/04_gray_hint.png',
  'material/05_basecolor_palette.json',
  'material/06_material_slots.json',
  'material/07_texture_slots.json',
  'material/08_existing_basecolor.png',
  'material/09_existing_roughness.png',
  'material/10_existing_metallic.png',
  'material/11_existing_normal.png',
  'uv/01_uv_map.exr',
  'uv/02_uv_preview.png',
  'uv/03_uv_island_id.png',
  'uv/04_uv_seams.png',
  'uv/05_uv_density.png',
  'pose/01_object_pose.json',
  'pose/02_camera_pose.json',
  'pose/03_relative_pose.json',
  'pose/04_pose_control_map.png',
  'pose/05_bbox_2d.json',
  'pose/06_bbox_3d.json',
  'pose/07_keypoints_2d.json',
  'pose/08_keypoints_3d.json',
  'visibility/01_visibility_map.png',
  'visibility/02_triangle_visibility.exr',
  'visibility/03_texel_visibility.png',
  'visibility/04_front_facing_mask.png',
  'visibility/05_back_facing_mask.png',
  'visibility/06_grazing_angle_mask.png',
  'controlnet_ready/control_depth.png',
  'controlnet_ready/control_edge.png',
  'controlnet_ready/control_canny.png',
  'controlnet_ready/control_hed.png',
  'controlnet_ready/control_scribble.png',
  'controlnet_ready/control_gray.png',
  'controlnet_ready/control_mlsd.png',
  'controlnet_ready/control_pose.png',
  'controlnet_ready/control_inpaint_mask.png',
  'controlnet_ready/control_color_hint.png',
  'debug/debug_grid_overlay.png',
  'debug/debug_mask_overlay.png',
  'debug/debug_depth_overlay.png',
  'debug/debug_normal_overlay.png',
  'debug/debug_edge_overlay.png',
  'debug/debug_id_overlay.png',
  'debug/debug_contact_sheet.png',
  'camera/camera_metadata.json',
  'camera/matrices.json',
  'camera/view_axes.json',
  'manifest.json',
  'comfyui_inputs.json',
  'README.md',
];

export async function exportComfyControlInputs(request: ComfyControlInputExporterRequest) {
  const result = await createComfyControlInputPackage(request);
  downloadBlob(result.zipBlob, result.filename);
  return result;
}

export async function createComfyControlInputPackage({
  project,
  viewport,
  importedModel,
  selectedObjectId,
  references = [],
  options,
}: ComfyControlInputExporterRequest): Promise<ComfyControlExportResult> {
  const width = clampExportSize(options?.width ?? 1024);
  const height = clampExportSize(options?.height ?? options?.width ?? 1024);
  const objectId = options?.modelId ?? selectedObjectId ?? importedModel.objectId;
  const modelSlug = slugifyExportName(importedModel.name || project.name || objectId);
  const viewId = slugifyExportName(options?.viewId ?? 'current_mvp_view');
  const rootPrefix = `exports/comfy_control/${modelSlug}/${viewId}`;
  const createdAt = new Date().toISOString();
  const files: ZipFile[] = [];
  const manifestFiles: Record<string, FileManifestEntry> = {};
  const warnings: string[] = [];
  const errors: string[] = [];

  viewport.scene.updateMatrixWorld(true);
  viewport.camera.updateMatrixWorld(true);
  const targetRoot = findTargetRoot(importedModel, objectId);
  const targetMeshes = collectTargetMeshes(viewport.scene, objectId);
  if (targetMeshes.length === 0) throw new Error('No mesh was found for the selected Comfy control export object.');
  const modelStats = inspectModel(importedModel, targetMeshes);
  const bounds = new THREE.Box3().setFromObject(targetRoot);
  const materialReference = chooseMaterialReference(references, objectId);

  async function addFile(path: string, data: BlobPart | Blob, entry: FileManifestEntry) {
    const blob = data instanceof Blob ? data : new Blob([data], { type: entry.type ?? 'application/octet-stream' });
    files.push({ path: `${rootPrefix}/${path}`, data: blob });
    manifestFiles[path] = {
      ...entry,
      available: true,
      hash: await hashBlob(blob),
    };
  }

  async function addPng(path: string, imageData: ImageData, description: string, generatedFrom?: string) {
    const blob = await imageDataToPngBlob(imageData);
    await addFile(path, blob, {
      available: true,
      type: 'image/png',
      bit_depth: 8,
      color_space: 'sRGB',
      width: imageData.width,
      height: imageData.height,
      description,
      generated_from: generatedFrom,
    });
    return blob;
  }

  const white = await renderObjectPass({
    viewport,
    objectId,
    width,
    height,
    clearColor: '#000000',
    clearAlpha: 1,
    materialForMesh: () => new THREE.MeshBasicMaterial({ color: '#ffffff' }),
  });
  await addFile('render/01_white_render.png', white.blob, pngEntry(width, height, 'White material render of current MVP view'));

  const clay = await renderObjectPass({
    viewport,
    objectId,
    width,
    height,
    clearColor: '#000000',
    clearAlpha: 1,
    materialForMesh: () => new THREE.MeshStandardMaterial({ color: '#d7d2c7', roughness: 0.9, metalness: 0 }),
  });
  await addFile('render/02_clay_render.png', clay.blob, pngEntry(width, height, 'Clay debug render of current MVP view'));

  const currentTexture = await renderObjectPass({
    viewport,
    objectId,
    width,
    height,
    clearColor: '#000000',
    clearAlpha: 1,
  });
  await addFile(
    'render/03_current_texture_render.png',
    currentTexture.blob,
    pngEntry(width, height, 'Current viewport material render; may include viewport lighting in browser MVP'),
  );
  await addFile(
    'render/05_lit_render_debug.png',
    currentTexture.blob,
    pngEntry(width, height, 'Lit debug render copied from current texture render'),
  );

  const albedo = await renderObjectPass({
    viewport,
    objectId,
    width,
    height,
    clearColor: '#000000',
    clearAlpha: 1,
    materialForMesh: createAlbedoMaterial,
  });
  await addFile('render/04_albedo_render.png', albedo.blob, pngEntry(width, height, 'Best-effort baseColor/albedo render'));

  const hardMask = maskFromWhiteRender(white.imageData);
  const maskImage = grayscaleImageData(width, height, hardMask);
  const maskStats = countMaskPixels(hardMask);
  await addPng('masks/01_object_mask.png', maskImage, 'Hard object mask; white=model, black=background');

  const softMask = featherMask(hardMask, width, height);
  await addPng('masks/02_object_mask_soft.png', grayscaleImageData(width, height, softMask), 'Soft object mask, 1px feather');

  const hasBaseColorTexture = modelStats.textureSlots.some((slot) => slot.slot === 'baseColor');
  const missingMask = hasBaseColorTexture ? new Uint8ClampedArray(width * height) : hardMask.slice();
  await addPng(
    'masks/03_missing_mask.png',
    grayscaleImageData(width, height, missingMask),
    hasBaseColorTexture
      ? 'Missing mask fallback: black because at least one baseColor texture exists'
      : 'Missing mask fallback: full visible object because no baseColor texture was detected',
  );
  await addPng('masks/04_visible_mask.png', maskImage, 'Visible model mask for current view', 'masks/01_object_mask.png');
  await addPng('masks/05_background_mask.png', grayscaleImageData(width, height, invertMask(hardMask)), 'Background mask');
  await addPng('masks/07_selection_mask.png', maskImage, 'Selected object mask fallback', 'masks/01_object_mask.png');

  const depthPass = await renderObjectPass({
    viewport,
    objectId,
    width,
    height,
    clearColor: '#000000',
    clearAlpha: 1,
    materialForMesh: () => createDepthMaterial(viewport.camera),
  });
  const depthGray = copyMaskedChannel(depthPass.imageData, hardMask, 0);
  const depthStats = countNonZeroPixels(depthGray);
  await addPng('geometry/01_depth_preview_8.png', grayscaleImageData(width, height, depthGray), '8-bit true Web3D linear depth preview');
  await addFile(
    'geometry/01_depth_linear_16.png',
    encodeGrayscalePng16(width, height, depthGray),
    {
      available: true,
      type: 'image/png',
      bit_depth: 16,
      color_space: 'linear',
      width,
      height,
      value_space: 'normalized_linear_view_depth',
      unit: 'normalized',
      normalization: 'uint16 = uint8_preview * 257; shader encodes white=near, black=far from camera near/far',
      description: '16-bit PNG browser fallback derived from true Web3D linear depth render',
    },
  );
  await addFile(
    'geometry/02_depth_inverse_16.png',
    encodeGrayscalePng16(width, height, invertMask(depthGray)),
    {
      available: true,
      type: 'image/png',
      bit_depth: 16,
      color_space: 'linear',
      width,
      height,
      value_space: 'inverse_normalized_linear_view_depth',
      unit: 'normalized',
      normalization: 'inverse of geometry/01_depth_linear_16.png; white=far',
      description: 'Inverse depth compatibility map',
    },
  );
  await addFile(
    'geometry/03_depth_normalized_16.png',
    encodeGrayscalePng16(width, height, depthGray),
    {
      available: true,
      type: 'image/png',
      bit_depth: 16,
      color_space: 'linear',
      width,
      height,
      value_space: 'normalized_linear_view_depth',
      unit: 'normalized',
      normalization: 'white=near, black=far',
      description: 'Normalized linear depth compatibility map',
    },
  );

  const normalWorld = await renderObjectPass({
    viewport,
    objectId,
    width,
    height,
    clearColor: '#000000',
    clearAlpha: 1,
    materialForMesh: () => createNormalMaterial('world'),
  });
  const normalView = await renderObjectPass({
    viewport,
    objectId,
    width,
    height,
    clearColor: '#000000',
    clearAlpha: 1,
    materialForMesh: () => createNormalMaterial('view'),
  });
  const normalObject = await renderObjectPass({
    viewport,
    objectId,
    width,
    height,
    clearColor: '#000000',
    clearAlpha: 1,
    materialForMesh: () => createNormalMaterial('object'),
  });
  await addFile('geometry/07_normal_world.png', normalWorld.blob, pngEntry(width, height, 'World-space normal encoded normal*0.5+0.5'));
  await addFile('geometry/08_normal_view.png', normalView.blob, pngEntry(width, height, 'View-space normal encoded normal*0.5+0.5'));
  await addFile('geometry/09_normal_object.png', normalObject.blob, pngEntry(width, height, 'Object-space normal encoded normal*0.5+0.5'));

  await addPng('debug/debug_depth_overlay.png', overlayMask(depthPass.imageData, hardMask), 'Depth overlay debug');
  await addPng('debug/debug_normal_overlay.png', overlayMask(normalView.imageData, hardMask), 'Normal overlay debug');

  const viewDirection = await renderObjectPass({
    viewport,
    objectId,
    width,
    height,
    clearColor: '#000000',
    clearAlpha: 1,
    materialForMesh: () => createViewDirectionMaterial(viewport.camera),
  });
  const facingRatio = await renderObjectPass({
    viewport,
    objectId,
    width,
    height,
    clearColor: '#000000',
    clearAlpha: 1,
    materialForMesh: () => createFacingRatioMaterial(),
  });
  await addPng('geometry/11_view_direction.png', viewDirection.imageData, 'World-space view direction encoded to 0-1');
  await addPng('geometry/12_facing_ratio.png', facingRatio.imageData, 'Facing ratio map; white faces camera directly');
  await addPng('geometry/13_camera_angle.png', facingRatio.imageData, 'Camera angle fallback encoded from facing ratio');
  await addPng('geometry/14_surface_angle.png', facingRatio.imageData, 'Surface angle fallback encoded from facing ratio');

  const uvPreview = modelStats.hasUv
    ? await renderObjectPass({
        viewport,
        objectId,
        width,
        height,
        clearColor: '#000000',
        clearAlpha: 1,
        materialForMesh: () => createUvMaterial(),
      })
    : undefined;
  if (uvPreview) await addFile('uv/02_uv_preview.png', uvPreview.blob, pngEntry(width, height, 'Visible UV coordinates preview'));

  const meshId = await renderObjectPass({
    viewport,
    objectId,
    width,
    height,
    clearColor: '#000000',
    clearAlpha: 1,
    materialForMesh: (mesh, index) => new THREE.MeshBasicMaterial({ color: stableColor(mesh.name || `mesh-${index}`) }),
  });
  const materialId = await renderObjectPass({
    viewport,
    objectId,
    width,
    height,
    clearColor: '#000000',
    clearAlpha: 1,
    materialForMesh: (mesh) => createMaterialIdMaterial(mesh),
  });
  await addFile('ids/01_part_id.png', meshId.blob, pngEntry(width, height, 'Part id fallback: one stable color per mesh'));
  await addFile('ids/02_material_id.png', materialId.blob, pngEntry(width, height, 'Material id map: one stable color per material slot'));
  await addFile('ids/05_mesh_id.png', meshId.blob, pngEntry(width, height, 'Mesh id map', 'ids/01_part_id.png'));
  await addFile('ids/06_instance_id.png', meshId.blob, pngEntry(width, height, 'Instance id fallback copied from mesh id', 'ids/05_mesh_id.png'));

  const silhouette = maskBoundary(hardMask, width, height, 1);
  const depthEdge = imageGradientEdge(depthPass.imageData, hardMask, 18);
  const normalEdge = imageGradientEdge(normalView.imageData, hardMask, 42);
  const materialBoundary = imageGradientEdge(materialId.imageData, hardMask, 12);
  const uvSeam = uvPreview ? imageGradientEdge(uvPreview.imageData, hardMask, 54) : new Uint8ClampedArray(width * height);
  const curvatureEdge = normalEdge.slice();
  const combinedEdge = combineMasks([silhouette, depthEdge, normalEdge, materialBoundary, uvSeam]);
  const hedSoft = blurMask(combinedEdge, width, height);
  const scribble = simplifyEdge(combinedEdge, width, height);
  await addPng('edges/01_silhouette_edge.png', grayscaleImageData(width, height, silhouette), 'Silhouette edge from object mask');
  await addPng('edges/02_depth_edge.png', grayscaleImageData(width, height, depthEdge), 'Depth discontinuity edge');
  await addPng('edges/03_normal_edge.png', grayscaleImageData(width, height, normalEdge), 'Normal discontinuity edge');
  await addPng('edges/04_combined_edge.png', grayscaleImageData(width, height, combinedEdge), 'Combined edge map');
  await addPng('edges/05_canny_ready_edge.png', grayscaleImageData(width, height, combinedEdge), 'Canny-ready edge map', 'edges/04_combined_edge.png');
  await addPng('edges/06_hed_soft_edge.png', grayscaleImageData(width, height, hedSoft), 'HED-like soft edge fallback');
  await addPng('edges/07_scribble_edge.png', grayscaleImageData(width, height, scribble), 'Simplified scribble edge fallback');
  await addPng('edges/08_mlsd_line_map.png', grayscaleImageData(width, height, combinedEdge), 'MLSD fallback copied from combined edge');
  await addPng('edges/09_curvature_edge.png', grayscaleImageData(width, height, curvatureEdge), 'Curvature fallback from normal variation');
  await addPng('edges/10_uv_seam_edge.png', grayscaleImageData(width, height, uvSeam), 'Visible UV seam approximation');
  await addPng('edges/11_material_boundary_edge.png', grayscaleImageData(width, height, materialBoundary), 'Material boundary edge from material id map');

  const referenceImageData = materialReference ? await tryLoadImageData(materialReference.url) : undefined;
  if (materialReference && referenceImageData) {
    await addFile('material/01_material_reference.png', await imageDataToPngBlob(referenceImageData), {
      available: true,
      type: 'image/png',
      bit_depth: 8,
      color_space: 'sRGB',
      width: referenceImageData.width,
      height: referenceImageData.height,
      description: `Copied material reference: ${materialReference.name}`,
    });
    await addPng(
      'material/02_material_reference_cropped.png',
      cropCenterSquare(referenceImageData, width, height),
      'Material reference center-cropped/padded to export resolution',
    );
  }
  const averageColor = referenceImageData ? averageImageColor(referenceImageData) : averageObjectColor(albedo.imageData, hardMask);
  const colorHint = colorHintImage(width, height, hardMask, averageColor);
  const grayHint = grayFromColorHint(colorHint);
  await addPng('material/03_color_hint.png', colorHint, 'Flat color hint aligned to object mask');
  await addPng('material/04_gray_hint.png', grayHint, 'Gray control hint derived from color hint');

  const palette = {
    dominant_colors: [
      {
        hex: rgbToHex(averageColor),
        rgb: averageColor,
        ratio: 1,
        source: referenceImageData ? 'material_reference' : 'albedo_render',
      },
    ],
    average_color: rgbToHex(averageColor),
    recommended_prompt_terms: options?.materialPrompt ? [options.materialPrompt] : [],
  };
  await addJson('material/05_basecolor_palette.json', palette, addFile);
  await addJson('material/06_material_slots.json', modelStats.materialSlots, addFile);
  await addJson('material/07_texture_slots.json', modelStats.textureSlots, addFile);

  await addPng('visibility/01_visibility_map.png', maskImage, 'Visibility map fallback: same as object mask');
  await addPng('visibility/04_front_facing_mask.png', thresholdFacing(facingRatio.imageData, hardMask, 64, false), 'Front-facing mask');
  await addPng('visibility/05_back_facing_mask.png', thresholdFacing(facingRatio.imageData, hardMask, 64, true), 'Back-facing/grazing fallback mask');
  await addPng('visibility/06_grazing_angle_mask.png', thresholdFacing(facingRatio.imageData, hardMask, 64, true), 'Grazing angle mask');

  const bbox2d = computeBbox2d(hardMask, width, height);
  const cameraMetadata = createCameraMetadata(viewId, modelSlug, width, height, viewport.camera, viewport.controls?.target);
  const matrices = createMatrices(targetRoot, viewport.camera);
  const viewAxes = createViewAxes(targetRoot, viewport.camera);
  const objectPose = createObjectPose(targetRoot, bounds);
  const cameraPose = createCameraPose(viewport.camera, viewport.controls?.target);
  const relativePose = createRelativePose(bounds, viewport.camera);
  await addJson('camera/camera_metadata.json', cameraMetadata, addFile);
  await addJson('camera/matrices.json', matrices, addFile);
  await addJson('camera/view_axes.json', viewAxes, addFile);
  await addJson('pose/01_object_pose.json', objectPose, addFile);
  await addJson('pose/02_camera_pose.json', cameraPose, addFile);
  await addJson('pose/03_relative_pose.json', relativePose, addFile);
  await addPng('pose/04_pose_control_map.png', createPoseControlMap(width, height, bbox2d), 'Pose fallback: 2D bbox and axes');
  await addJson('pose/05_bbox_2d.json', bbox2d, addFile);
  await addJson('pose/06_bbox_3d.json', createBbox3d(bounds, viewport.camera), addFile);
  await addJson('pose/07_keypoints_2d.json', { available: false, reason: 'No semantic keypoints or skeleton are available.' }, addFile);
  await addJson('pose/08_keypoints_3d.json', { available: false, reason: 'No semantic keypoints or skeleton are available.' }, addFile);

  await addFile(
    'controlnet_ready/control_depth.png',
    await manifestBlobFromImage(depthGray, width, height),
    pngEntry(width, height, 'ControlNet-ready depth', 'geometry/01_depth_preview_8.png'),
  );
  await addPng('controlnet_ready/control_edge.png', grayscaleImageData(width, height, combinedEdge), 'ControlNet-ready combined edge');
  await addPng('controlnet_ready/control_canny.png', grayscaleImageData(width, height, combinedEdge), 'ControlNet-ready canny edge fallback');
  await addPng('controlnet_ready/control_hed.png', grayscaleImageData(width, height, hedSoft), 'ControlNet-ready HED soft edge fallback');
  await addPng('controlnet_ready/control_scribble.png', grayscaleImageData(width, height, scribble), 'ControlNet-ready scribble fallback');
  await addPng('controlnet_ready/control_gray.png', grayHint, 'ControlNet-ready gray hint');
  await addPng('controlnet_ready/control_mlsd.png', grayscaleImageData(width, height, combinedEdge), 'ControlNet-ready MLSD fallback');
  await addPng('controlnet_ready/control_pose.png', createPoseControlMap(width, height, bbox2d), 'ControlNet-ready pose fallback');
  await addPng('controlnet_ready/control_inpaint_mask.png', grayscaleImageData(width, height, missingMask), 'ControlNet-ready inpaint mask');
  await addPng('controlnet_ready/control_color_hint.png', colorHint, 'ControlNet-ready color hint');

  await addPng('debug/debug_grid_overlay.png', debugOverlay(white.imageData, combinedEdge, [238, 116, 68]), 'Grid/edge overlay debug');
  await addPng('debug/debug_mask_overlay.png', debugOverlay(currentTexture.imageData, hardMask, [236, 76, 214]), 'Mask overlay debug');
  await addPng('debug/debug_edge_overlay.png', debugOverlay(currentTexture.imageData, combinedEdge, [255, 255, 255]), 'Edge overlay debug');
  await addPng('debug/debug_id_overlay.png', materialId.imageData, 'ID overlay debug');
  await addPng(
    'debug/debug_contact_sheet.png',
    createContactSheet([
      ['white', white.imageData],
      ['mask', maskImage],
      ['depth', grayscaleImageData(width, height, depthGray)],
      ['normal_view', normalView.imageData],
      ['combined_edge', grayscaleImageData(width, height, combinedEdge)],
      ['color_hint', colorHint],
      ['material_id', materialId.imageData],
      ['uv_preview', uvPreview?.imageData ?? emptyImageData(width, height)],
      ['facing_ratio', facingRatio.imageData],
      ['current_texture', currentTexture.imageData],
    ]),
    'Debug contact sheet',
  );

  const comfyuiInputs = createComfyuiInputs(modelSlug, viewId, width, height, options, Boolean(materialReference));
  await addJson('comfyui_inputs.json', comfyuiInputs, addFile);
  manifestFiles['manifest.json'] = jsonEntry('Detailed Comfy control export manifest');
  manifestFiles['README.md'] = {
    available: true,
    type: 'text/markdown',
    description: 'Human-readable export notes',
  };

  for (const path of expectedFiles) {
    if (manifestFiles[path]) continue;
    manifestFiles[path] = unavailableEntry(unavailableReasonFor(path));
  }

  const manifest: ComfyControlManifest = {
    schema_version: '1.0.0',
    exporter_version: exporterVersion,
    created_at: createdAt,
    model: {
      id: objectId,
      slug: modelSlug,
      source_path: importedModel.sourceFileName,
      source_hash: '',
      format: importedModel.format,
      mesh_count: modelStats.meshCount,
      material_count: modelStats.materialSlots.length,
      triangle_count: modelStats.triangleCount,
      has_uv: modelStats.hasUv,
      has_normals: modelStats.hasNormals,
      has_tangents: modelStats.hasTangents,
      has_skin: modelStats.hasSkin,
      has_animation: false,
    },
    view: {
      view_id: viewId,
      width,
      height,
      output_root: options?.outputRoot ?? './exports/comfy_control',
      camera_metadata: 'camera/camera_metadata.json',
      matrices: 'camera/matrices.json',
    },
    files: manifestFiles,
    depth: {
      near: getCameraNear(viewport.camera),
      far: getCameraFar(viewport.camera),
      min_visible_depth: null,
      max_visible_depth: null,
      control_depth_encoding: 'uint16_normalized_png_plus_8bit_preview',
      control_depth_white: 'near',
      normalization_formula: 'shader: encoded = 1.0 - clamp((view_z - near) / (far - near), 0, 1)',
    },
    coordinate_system: {
      handedness: 'right-handed',
      world_up: [0, 1, 0],
      camera_forward_axis: '-Z',
      clip_space: 'WebGL',
      matrix_order: 'column-major',
      mvp_formula: 'clip = projection * view * model * position',
    },
    warnings,
    errors,
  };
  await addFile('manifest.json', JSON.stringify(manifest, null, 2), jsonEntry('Detailed Comfy control export manifest'));
  await addFile('README.md', createReadme(manifest, comfyuiInputs), {
    available: true,
    type: 'text/markdown',
    description: 'Human-readable export notes',
  });

  const validation = validateComfyControlExportPackage({
    width,
    height,
    files: manifestFiles,
    maskWhitePixels: maskStats.whitePixels,
    depthNonZeroPixels: depthStats,
    manifest,
    comfyuiInputs,
  });
  if (!validation.ok) throw new Error(validation.errors.join('\n'));

  const zipBlob = await createZipBlob(files);
  return {
    zipBlob,
    filename: `${modelSlug}_${viewId}_comfy_control_inputs.zip`,
    rootPrefix,
    manifest,
    comfyuiInputs,
    validation,
  };
}

function pngEntry(width: number, height: number, description: string, generatedFrom?: string): FileManifestEntry {
  return {
    available: true,
    type: 'image/png',
    bit_depth: 8,
    color_space: 'sRGB',
    width,
    height,
    description,
    generated_from: generatedFrom,
  };
}

function jsonEntry(description: string): FileManifestEntry {
  return {
    available: true,
    type: 'application/json',
    description,
  };
}

async function addJson(
  path: string,
  value: unknown,
  addFile: (path: string, data: BlobPart | Blob, entry: FileManifestEntry) => Promise<void>,
) {
  await addFile(path, JSON.stringify(value, null, 2), jsonEntry(path));
}

function unavailableEntry(reason: string): FileManifestEntry {
  return { available: false, reason };
}

function unavailableReasonFor(path: string) {
  if (path.endsWith('.exr')) return 'EXR encoding is not available in the browser exporter yet.';
  if (path.includes('face_id')) return 'Triangle/face id render target is not implemented yet.';
  if (path.includes('ao')) return 'Ambient occlusion pass is not implemented in the browser exporter yet.';
  if (path.includes('tangent')) return 'Tangent-space export requires mesh tangents and a dedicated shader pass.';
  if (path.includes('texture_slots') || path.includes('material_slots')) return 'Metadata file was not generated.';
  if (path.includes('existing_')) return 'Raw PBR texture extraction is not implemented yet; albedo render is available.';
  if (path.includes('triangle_visibility')) return 'Per-triangle visibility requires an integer id buffer that is not implemented yet.';
  if (path.includes('texel_visibility')) return 'Texel visibility estimation is not implemented yet.';
  if (path.includes('occlusion_mask')) return 'Occlusion mask is not implemented yet.';
  if (path.includes('uv/01_uv_map')) return 'Float UV EXR export is not available in the browser exporter yet; uv preview is available when UVs exist.';
  return 'This optional output is not available in the browser MVP exporter yet.';
}

function clampExportSize(value: number) {
  return Math.max(256, Math.min(4096, Math.round(value || 1024)));
}

function findTargetRoot(importedModel: ModelLoadResult, objectId: string) {
  if (importedModel.objectId === objectId) return importedModel.group;
  let target: THREE.Object3D | undefined;
  importedModel.group.traverse((object) => {
    if (!target && object.userData.liclickObjectId === objectId) target = object;
  });
  return target ?? importedModel.group;
}

function collectTargetMeshes(scene: THREE.Scene, objectId: string) {
  const meshes: THREE.Mesh[] = [];
  scene.traverse((object) => {
    if (object instanceof THREE.Mesh && object.userData.liclickObjectId === objectId) meshes.push(object);
  });
  return meshes;
}

function isolateTarget(
  scene: THREE.Scene,
  objectId: string,
  materialForMesh?: (mesh: THREE.Mesh, index: number) => THREE.Material | THREE.Material[],
) {
  const snapshots: TargetMeshSnapshot[] = [];
  const temporaryMaterials: THREE.Material[] = [];
  const targetMeshes = new Set<THREE.Mesh>();
  const targetAncestors = new Set<THREE.Object3D>([scene]);
  scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || object.userData.liclickObjectId !== objectId) return;
    targetMeshes.add(object);
    let parent = object.parent;
    while (parent) {
      targetAncestors.add(parent);
      parent = parent.parent;
    }
  });

  let targetIndex = 0;
  scene.traverse((object) => {
    if (object === scene || object instanceof THREE.Camera || object instanceof THREE.Light) return;
    const isTarget = object instanceof THREE.Mesh && targetMeshes.has(object);
    snapshots.push({
      object,
      visible: object.visible,
      material: object instanceof THREE.Mesh ? object.material : undefined,
    });
    object.visible = isTarget || targetAncestors.has(object);
    if (isTarget && materialForMesh) {
      const material = materialForMesh(object, targetIndex);
      object.material = material;
      temporaryMaterials.push(...(Array.isArray(material) ? material : [material]));
      targetIndex += 1;
    }
  });

  return () => {
    snapshots.forEach((snapshot) => {
      snapshot.object.visible = snapshot.visible;
      if (snapshot.object instanceof THREE.Mesh && snapshot.material) snapshot.object.material = snapshot.material;
    });
    temporaryMaterials.forEach((material) => material.dispose());
  };
}

async function renderObjectPass(input: {
  viewport: ViewportRuntime;
  objectId: string;
  width: number;
  height: number;
  clearColor: THREE.ColorRepresentation;
  clearAlpha: number;
  materialForMesh?: (mesh: THREE.Mesh, index: number) => THREE.Material | THREE.Material[];
}): Promise<RenderedImage> {
  const target = new THREE.WebGLRenderTarget(input.width, input.height, {
    samples: input.width > 1024 || input.height > 1024 ? 0 : 2,
    colorSpace: THREE.SRGBColorSpace,
  });
  const previousTarget = input.viewport.gl.getRenderTarget();
  const previousClearColor = new THREE.Color();
  input.viewport.gl.getClearColor(previousClearColor);
  const previousClearAlpha = input.viewport.gl.getClearAlpha();
  const restoreScene = isolateTarget(input.viewport.scene, input.objectId, input.materialForMesh);

  try {
    input.viewport.gl.setRenderTarget(target);
    input.viewport.gl.setClearColor(input.clearColor, input.clearAlpha);
    input.viewport.gl.clear();
    input.viewport.gl.render(input.viewport.scene, input.viewport.camera);
    const pixels = new Uint8Array(input.width * input.height * 4);
    input.viewport.gl.readRenderTargetPixels(target, 0, 0, input.width, input.height, pixels);
    const imageData = pixelsToImageData(pixels, input.width, input.height);
    return {
      imageData,
      blob: await imageDataToPngBlob(imageData),
    };
  } finally {
    restoreScene();
    input.viewport.gl.setRenderTarget(previousTarget);
    input.viewport.gl.setClearColor(previousClearColor, previousClearAlpha);
    target.dispose();
  }
}

function pixelsToImageData(pixels: Uint8Array, width: number, height: number) {
  const output = new ImageData(width, height);
  const rowStride = width * 4;
  for (let y = 0; y < height; y += 1) {
    const sourceStart = (height - y - 1) * rowStride;
    const targetStart = y * rowStride;
    output.data.set(pixels.subarray(sourceStart, sourceStart + rowStride), targetStart);
  }
  return output;
}

function imageDataToPngBlob(imageData: ImageData) {
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create export canvas.');
  context.putImageData(imageData, 0, 0);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not encode PNG.'))), 'image/png');
  });
}

function manifestBlobFromImage(mask: Uint8ClampedArray, width: number, height: number) {
  return imageDataToPngBlob(grayscaleImageData(width, height, mask));
}

function createAlbedoMaterial(mesh: THREE.Mesh) {
  const source = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const materials = source.map((material) => {
    const standard = material as THREE.MeshStandardMaterial;
    return new THREE.MeshBasicMaterial({
      color: standard.color?.clone?.() ?? new THREE.Color('#ffffff'),
      map: standard.map ?? null,
      transparent: standard.transparent,
      opacity: standard.opacity,
      alphaMap: standard.alphaMap ?? null,
    });
  });
  return Array.isArray(mesh.material) ? materials : materials[0];
}

function createDepthMaterial(camera: THREE.Camera) {
  return new THREE.ShaderMaterial({
    uniforms: {
      near: { value: getCameraNear(camera) },
      far: { value: getCameraFar(camera) },
    },
    vertexShader: `
      varying float vViewZ;
      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vViewZ = -mvPosition.z;
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform float near;
      uniform float far;
      varying float vViewZ;
      void main() {
        float depth = clamp((vViewZ - near) / max(0.0001, far - near), 0.0, 1.0);
        float encoded = 1.0 - depth;
        gl_FragColor = vec4(vec3(encoded), 1.0);
      }
    `,
  });
}

function createNormalMaterial(space: 'world' | 'view' | 'object') {
  return new THREE.ShaderMaterial({
    vertexShader: `
      varying vec3 vNormalWorld;
      varying vec3 vNormalView;
      varying vec3 vNormalObject;
      void main() {
        vNormalObject = normalize(normal);
        vNormalWorld = normalize(mat3(modelMatrix) * normal);
        vNormalView = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vNormalWorld;
      varying vec3 vNormalView;
      varying vec3 vNormalObject;
      void main() {
        vec3 n = normalize(${space === 'world' ? 'vNormalWorld' : space === 'view' ? 'vNormalView' : 'vNormalObject'});
        gl_FragColor = vec4(n * 0.5 + 0.5, 1.0);
      }
    `,
  });
}

function createViewDirectionMaterial(camera: THREE.Camera) {
  return new THREE.ShaderMaterial({
    uniforms: {
      cameraWorldPosition: { value: camera.position.clone() },
    },
    vertexShader: `
      varying vec3 vWorldPosition;
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: `
      uniform vec3 cameraWorldPosition;
      varying vec3 vWorldPosition;
      void main() {
        vec3 direction = normalize(cameraWorldPosition - vWorldPosition);
        gl_FragColor = vec4(direction * 0.5 + 0.5, 1.0);
      }
    `,
  });
}

function createFacingRatioMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: `
      varying vec3 vNormalView;
      void main() {
        vNormalView = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vNormalView;
      void main() {
        float ratio = clamp(normalize(vNormalView).z, 0.0, 1.0);
        gl_FragColor = vec4(vec3(ratio), 1.0);
      }
    `,
  });
}

function createUvMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec2 vUv;
      void main() {
        gl_FragColor = vec4(fract(vUv), 1.0, 1.0);
      }
    `,
  });
}

function createMaterialIdMaterial(mesh: THREE.Mesh) {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const output = materials.map((material, index) => {
    const key = material.name || `${mesh.name}-material-${index}`;
    return new THREE.MeshBasicMaterial({ color: stableColor(key) });
  });
  return Array.isArray(mesh.material) ? output : output[0];
}

function stableColor(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const hue = (hash >>> 0) % 360;
  const color = new THREE.Color();
  color.setHSL(hue / 360, 0.72, 0.58);
  return color;
}

function getCameraNear(camera: THREE.Camera) {
  return camera instanceof THREE.PerspectiveCamera || camera instanceof THREE.OrthographicCamera ? camera.near : 0.01;
}

function getCameraFar(camera: THREE.Camera) {
  return camera instanceof THREE.PerspectiveCamera || camera instanceof THREE.OrthographicCamera ? camera.far : 1000;
}

function maskFromWhiteRender(imageData: ImageData) {
  const mask = new Uint8ClampedArray(imageData.width * imageData.height);
  for (let index = 0; index < mask.length; index += 1) {
    const offset = index * 4;
    const luma = imageData.data[offset] * 0.2126 + imageData.data[offset + 1] * 0.7152 + imageData.data[offset + 2] * 0.0722;
    mask[index] = luma > 12 ? 255 : 0;
  }
  return mask;
}

function grayscaleImageData(width: number, height: number, gray: Uint8ClampedArray) {
  const output = new ImageData(width, height);
  for (let index = 0; index < gray.length; index += 1) {
    const offset = index * 4;
    const value = gray[index] ?? 0;
    output.data[offset] = value;
    output.data[offset + 1] = value;
    output.data[offset + 2] = value;
    output.data[offset + 3] = 255;
  }
  return output;
}

function copyMaskedChannel(imageData: ImageData, mask: Uint8ClampedArray, channel: 0 | 1 | 2) {
  const output = new Uint8ClampedArray(mask.length);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = mask[index] > 0 ? imageData.data[index * 4 + channel] : 0;
  }
  return output;
}

function invertMask(mask: Uint8ClampedArray) {
  const output = new Uint8ClampedArray(mask.length);
  for (let index = 0; index < mask.length; index += 1) output[index] = 255 - (mask[index] ?? 0);
  return output;
}

function featherMask(mask: Uint8ClampedArray, width: number, height: number) {
  return blurMask(mask, width, height);
}

function blurMask(mask: Uint8ClampedArray, width: number, height: number) {
  const output = new Uint8ClampedArray(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let total = 0;
      let count = 0;
      for (let oy = -1; oy <= 1; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          const nx = x + ox;
          const ny = y + oy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          total += mask[ny * width + nx] ?? 0;
          count += 1;
        }
      }
      output[y * width + x] = Math.round(total / count);
    }
  }
  return output;
}

function maskBoundary(mask: Uint8ClampedArray, width: number, height: number, radius: number) {
  const output = new Uint8ClampedArray(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (mask[index] === 0) continue;
      let edge = false;
      for (let oy = -radius; oy <= radius && !edge; oy += 1) {
        for (let ox = -radius; ox <= radius; ox += 1) {
          const nx = x + ox;
          const ny = y + oy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height || mask[ny * width + nx] === 0) {
            edge = true;
            break;
          }
        }
      }
      output[index] = edge ? 255 : 0;
    }
  }
  return output;
}

function imageGradientEdge(imageData: ImageData, mask: Uint8ClampedArray, threshold: number) {
  const { width, height } = imageData;
  const output = new Uint8ClampedArray(width * height);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      if (mask[index] === 0) continue;
      const offset = index * 4;
      const right = offset + 4;
      const down = offset + width * 4;
      const diff =
        Math.abs(imageData.data[offset] - imageData.data[right]) +
        Math.abs(imageData.data[offset + 1] - imageData.data[right + 1]) +
        Math.abs(imageData.data[offset + 2] - imageData.data[right + 2]) +
        Math.abs(imageData.data[offset] - imageData.data[down]) +
        Math.abs(imageData.data[offset + 1] - imageData.data[down + 1]) +
        Math.abs(imageData.data[offset + 2] - imageData.data[down + 2]);
      output[index] = diff > threshold ? 255 : 0;
    }
  }
  return output;
}

function combineMasks(masks: Uint8ClampedArray[]) {
  const output = new Uint8ClampedArray(masks[0]?.length ?? 0);
  masks.forEach((mask) => {
    for (let index = 0; index < output.length; index += 1) output[index] = Math.max(output[index], mask[index] ?? 0);
  });
  return output;
}

function simplifyEdge(mask: Uint8ClampedArray, width: number, height: number) {
  const blurred = blurMask(mask, width, height);
  const output = new Uint8ClampedArray(mask.length);
  for (let index = 0; index < mask.length; index += 1) output[index] = blurred[index] > 90 ? 255 : 0;
  return output;
}

function colorHintImage(width: number, height: number, mask: Uint8ClampedArray, color: [number, number, number]) {
  const output = new ImageData(width, height);
  for (let index = 0; index < mask.length; index += 1) {
    const offset = index * 4;
    if (mask[index] > 0) {
      output.data[offset] = color[0];
      output.data[offset + 1] = color[1];
      output.data[offset + 2] = color[2];
      output.data[offset + 3] = 255;
    } else {
      output.data[offset + 3] = 255;
    }
  }
  return output;
}

function grayFromColorHint(imageData: ImageData) {
  const output = new ImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height);
  for (let index = 0; index < output.data.length; index += 4) {
    const gray = Math.round(output.data[index] * 0.2126 + output.data[index + 1] * 0.7152 + output.data[index + 2] * 0.0722);
    output.data[index] = gray;
    output.data[index + 1] = gray;
    output.data[index + 2] = gray;
  }
  return output;
}

function thresholdFacing(imageData: ImageData, mask: Uint8ClampedArray, threshold: number, invert: boolean) {
  const output = new Uint8ClampedArray(mask.length);
  for (let index = 0; index < mask.length; index += 1) {
    const value = imageData.data[index * 4];
    const pass = invert ? value < threshold : value >= threshold;
    output[index] = mask[index] > 0 && pass ? 255 : 0;
  }
  return grayscaleImageData(imageData.width, imageData.height, output);
}

function overlayMask(imageData: ImageData, mask: Uint8ClampedArray) {
  const output = new ImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height);
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] > 0) output.data[index * 4 + 3] = 255;
  }
  return output;
}

function debugOverlay(imageData: ImageData, mask: Uint8ClampedArray, color: [number, number, number]) {
  const output = new ImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height);
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] === 0) continue;
    const offset = index * 4;
    output.data[offset] = Math.round(output.data[offset] * 0.45 + color[0] * 0.55);
    output.data[offset + 1] = Math.round(output.data[offset + 1] * 0.45 + color[1] * 0.55);
    output.data[offset + 2] = Math.round(output.data[offset + 2] * 0.45 + color[2] * 0.55);
    output.data[offset + 3] = 255;
  }
  return output;
}

function emptyImageData(width: number, height: number) {
  return new ImageData(width, height);
}

function countMaskPixels(mask: Uint8ClampedArray) {
  let whitePixels = 0;
  for (const value of mask) if (value > 0) whitePixels += 1;
  return { whitePixels };
}

function countNonZeroPixels(mask: Uint8ClampedArray) {
  let count = 0;
  for (const value of mask) if (value > 0) count += 1;
  return count;
}

function inspectModel(importedModel: ModelLoadResult, meshes: THREE.Mesh[]) {
  let triangleCount = 0;
  let hasUv = false;
  let hasNormals = false;
  let hasTangents = false;
  let hasSkin = false;
  const materialMap = new Map<string, Record<string, unknown>>();
  const textureSlots: Array<Record<string, unknown> & { slot: string }> = [];

  meshes.forEach((mesh) => {
    const geometry = mesh.geometry;
    triangleCount += geometry.index ? geometry.index.count / 3 : (geometry.getAttribute('position')?.count ?? 0) / 3;
    hasUv ||= Boolean(geometry.getAttribute('uv'));
    hasNormals ||= Boolean(geometry.getAttribute('normal'));
    hasTangents ||= Boolean(geometry.getAttribute('tangent'));
    hasSkin ||= mesh instanceof THREE.SkinnedMesh;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    materials.forEach((material, materialIndex) => {
      const standard = material as THREE.MeshStandardMaterial;
      const key = material.uuid;
      if (!materialMap.has(key)) {
        materialMap.set(key, {
          material_index: materialMap.size,
          name: material.name || `Material ${materialMap.size + 1}`,
          mesh_names: [mesh.name || `Mesh ${materialIndex + 1}`],
          baseColorFactor: standard.color ? [standard.color.r, standard.color.g, standard.color.b, standard.opacity ?? 1] : [1, 1, 1, 1],
          metallicFactor: standard.metalness ?? 0,
          roughnessFactor: standard.roughness ?? 1,
          hasBaseColorTexture: Boolean(standard.map),
          hasNormalTexture: Boolean(standard.normalMap),
          hasRoughnessTexture: Boolean(standard.roughnessMap),
          visibleInCurrentView: true,
          visiblePixelCount: null,
        });
      } else {
        const entry = materialMap.get(key);
        const names = entry?.mesh_names as string[] | undefined;
        names?.push(mesh.name || `Mesh ${names.length + 1}`);
      }
      if (standard.map) textureSlots.push(textureSlot('baseColor', standard.map));
      if (standard.roughnessMap) textureSlots.push(textureSlot('roughness', standard.roughnessMap));
      if (standard.metalnessMap) textureSlots.push(textureSlot('metallic', standard.metalnessMap));
      if (standard.normalMap) textureSlots.push(textureSlot('normal', standard.normalMap));
    });
  });

  return {
    meshCount: meshes.length,
    triangleCount: Math.round(triangleCount),
    hasUv: hasUv || importedModel.uvSets.length > 0,
    hasNormals,
    hasTangents,
    hasSkin,
    materialSlots: [...materialMap.values()],
    textureSlots,
  };
}

function textureSlot(slot: string, texture: THREE.Texture) {
  const image = texture.image as HTMLImageElement | HTMLCanvasElement | ImageBitmap | undefined;
  return {
    slot,
    uri: texture.name || '',
    width: 'width' in (image ?? {}) ? Number((image as { width?: number }).width ?? 0) : 0,
    height: 'height' in (image ?? {}) ? Number((image as { height?: number }).height ?? 0) : 0,
    colorSpace: texture.colorSpace,
    hash: '',
  };
}

function chooseMaterialReference(references: ReferenceImage[], objectId: string) {
  return (
    references.find((reference) => reference.isPrimary && (!reference.objectId || reference.objectId === objectId)) ??
    references.find((reference) => !reference.objectId || reference.objectId === objectId)
  );
}

async function tryLoadImageData(url: string) {
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.crossOrigin = 'anonymous';
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('Could not load material reference image.'));
      element.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth || image.width;
    canvas.height = image.naturalHeight || image.height;
    const context = canvas.getContext('2d');
    if (!context) return undefined;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return context.getImageData(0, 0, canvas.width, canvas.height);
  } catch {
    return undefined;
  }
}

function averageImageColor(imageData: ImageData): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let index = 0; index < imageData.data.length; index += 4) {
    if (imageData.data[index + 3] <= 8) continue;
    r += imageData.data[index];
    g += imageData.data[index + 1];
    b += imageData.data[index + 2];
    count += 1;
  }
  if (count === 0) return [180, 180, 180];
  return [Math.round(r / count), Math.round(g / count), Math.round(b / count)];
}

function averageObjectColor(imageData: ImageData, mask: Uint8ClampedArray): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] === 0) continue;
    const offset = index * 4;
    r += imageData.data[offset];
    g += imageData.data[offset + 1];
    b += imageData.data[offset + 2];
    count += 1;
  }
  if (count === 0) return [180, 180, 180];
  return [Math.round(r / count), Math.round(g / count), Math.round(b / count)];
}

function cropCenterSquare(imageData: ImageData, width: number, height: number) {
  const sourceCanvas = document.createElement('canvas');
  sourceCanvas.width = imageData.width;
  sourceCanvas.height = imageData.height;
  sourceCanvas.getContext('2d')?.putImageData(imageData, 0, 0);
  const targetCanvas = document.createElement('canvas');
  targetCanvas.width = width;
  targetCanvas.height = height;
  const context = targetCanvas.getContext('2d');
  if (!context) throw new Error('Could not create material reference crop canvas.');
  context.fillStyle = '#000000';
  context.fillRect(0, 0, width, height);
  const scale = Math.max(width / imageData.width, height / imageData.height);
  const drawWidth = imageData.width * scale;
  const drawHeight = imageData.height * scale;
  context.drawImage(sourceCanvas, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
  return context.getImageData(0, 0, width, height);
}

function rgbToHex(color: [number, number, number]) {
  return `#${color.map((value) => value.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

function createCameraMetadata(
  viewId: string,
  modelSlug: string,
  width: number,
  height: number,
  camera: THREE.Camera,
  target?: THREE.Vector3,
) {
  return {
    view_id: viewId,
    model_slug: modelSlug,
    resolution: [width, height],
    coordinate_system: {
      handedness: 'right-handed',
      world_up: [0, 1, 0],
      camera_forward_axis: '-Z',
      clip_space: 'WebGL',
    },
    camera: createCameraPose(camera, target),
  };
}

function createCameraPose(camera: THREE.Camera, target?: THREE.Vector3) {
  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize();
  const up = camera.up.clone().normalize();
  return {
    camera_type: camera instanceof THREE.OrthographicCamera ? 'orthographic' : 'perspective',
    position: vectorToArray(camera.position),
    target: vectorToArray(target ?? new THREE.Vector3()),
    forward: vectorToArray(forward),
    up: vectorToArray(up),
    right: vectorToArray(right),
    fov_degrees: camera instanceof THREE.PerspectiveCamera ? camera.fov : undefined,
    aspect: camera instanceof THREE.PerspectiveCamera ? camera.aspect : 1,
    near: getCameraNear(camera),
    far: getCameraFar(camera),
  };
}

function createMatrices(object: THREE.Object3D, camera: THREE.Camera) {
  object.updateMatrixWorld(true);
  camera.updateMatrixWorld(true);
  const model = object.matrixWorld.clone();
  const view = camera.matrixWorldInverse.clone();
  const projection = camera.projectionMatrix.clone();
  const modelView = view.clone().multiply(model);
  const viewProjection = projection.clone().multiply(view);
  const mvp = projection.clone().multiply(modelView);
  return {
    matrix_order: 'column-major',
    multiplication: 'clip = projection * view * model * position',
    model_matrix: model.toArray(),
    view_matrix: view.toArray(),
    projection_matrix: projection.toArray(),
    model_view_matrix: modelView.toArray(),
    view_projection_matrix: viewProjection.toArray(),
    model_view_projection_matrix: mvp.toArray(),
    normal_matrix: new THREE.Matrix3().getNormalMatrix(modelView).toArray(),
    inverse_model_matrix: model.clone().invert().toArray(),
    inverse_view_matrix: view.clone().invert().toArray(),
    inverse_projection_matrix: projection.clone().invert().toArray(),
    inverse_mvp_matrix: mvp.clone().invert().toArray(),
  };
}

function createViewAxes(object: THREE.Object3D, camera: THREE.Camera) {
  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize();
  const objectQuaternion = object.getWorldQuaternion(new THREE.Quaternion());
  return {
    camera_forward_world: vectorToArray(forward),
    camera_up_world: vectorToArray(camera.up.clone().normalize()),
    camera_right_world: vectorToArray(right),
    object_forward_world: vectorToArray(new THREE.Vector3(0, 0, 1).applyQuaternion(objectQuaternion).normalize()),
    object_up_world: vectorToArray(new THREE.Vector3(0, 1, 0).applyQuaternion(objectQuaternion).normalize()),
    object_right_world: vectorToArray(new THREE.Vector3(1, 0, 0).applyQuaternion(objectQuaternion).normalize()),
  };
}

function createObjectPose(object: THREE.Object3D, box: THREE.Box3) {
  const position = object.getWorldPosition(new THREE.Vector3());
  const quaternion = object.getWorldQuaternion(new THREE.Quaternion());
  const scale = object.getWorldScale(new THREE.Vector3());
  const euler = new THREE.Euler().setFromQuaternion(quaternion);
  const center = new THREE.Vector3();
  const size = new THREE.Vector3();
  box.getCenter(center);
  box.getSize(size);
  return {
    model_matrix: object.matrixWorld.toArray(),
    position: vectorToArray(position),
    rotation_quaternion: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
    rotation_euler_degrees: [THREE.MathUtils.radToDeg(euler.x), THREE.MathUtils.radToDeg(euler.y), THREE.MathUtils.radToDeg(euler.z)],
    scale: vectorToArray(scale),
    bbox_world: {
      min: vectorToArray(box.min),
      max: vectorToArray(box.max),
      center: vectorToArray(center),
      size: vectorToArray(size),
    },
  };
}

function createRelativePose(box: THREE.Box3, camera: THREE.Camera) {
  const center = new THREE.Vector3();
  box.getCenter(center);
  const cameraToObject = center.clone().sub(camera.position);
  const distance = cameraToObject.length();
  const azimuth = THREE.MathUtils.radToDeg(Math.atan2(cameraToObject.x, cameraToObject.z));
  const elevation = THREE.MathUtils.radToDeg(Math.asin(cameraToObject.y / Math.max(distance, 0.0001)));
  return {
    camera_to_object_center: vectorToArray(cameraToObject),
    distance_to_object_center: distance,
    azimuth_degrees: azimuth,
    elevation_degrees: elevation,
    roll_degrees: 0,
    view_name_guess: guessViewName(azimuth, elevation),
    is_front_view: Math.abs(azimuth) < 70,
    is_back_view: Math.abs(azimuth) > 110,
    is_left_view: azimuth < -25,
    is_right_view: azimuth > 25,
    is_top_view: elevation > 55,
    is_bottom_view: elevation < -55,
  };
}

function guessViewName(azimuth: number, elevation: number) {
  if (elevation > 55) return 'top';
  if (elevation < -55) return 'bottom';
  if (Math.abs(azimuth) < 25) return 'front';
  if (Math.abs(azimuth) > 155) return 'back';
  return azimuth < 0 ? 'front_left' : 'front_right';
}

function createBbox3d(box: THREE.Box3, camera: THREE.Camera) {
  const corners = [
    new THREE.Vector3(box.min.x, box.min.y, box.min.z),
    new THREE.Vector3(box.min.x, box.min.y, box.max.z),
    new THREE.Vector3(box.min.x, box.max.y, box.min.z),
    new THREE.Vector3(box.min.x, box.max.y, box.max.z),
    new THREE.Vector3(box.max.x, box.min.y, box.min.z),
    new THREE.Vector3(box.max.x, box.min.y, box.max.z),
    new THREE.Vector3(box.max.x, box.max.y, box.min.z),
    new THREE.Vector3(box.max.x, box.max.y, box.max.z),
  ];
  return {
    world: corners.map(vectorToArray),
    camera: corners.map((corner) => vectorToArray(corner.clone().applyMatrix4(camera.matrixWorldInverse))),
  };
}

function computeBbox2d(mask: Uint8ClampedArray, width: number, height: number) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let visiblePixelCount = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (mask[y * width + x] === 0) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      visiblePixelCount += 1;
    }
  }
  if (maxX < minX || maxY < minY) {
    return {
      bbox_xywh: [0, 0, 0, 0],
      bbox_xyxy: [0, 0, 0, 0],
      normalized_xywh: [0, 0, 0, 0],
      visible_pixel_count: 0,
    };
  }
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  return {
    bbox_xywh: [minX, minY, w, h],
    bbox_xyxy: [minX, minY, maxX, maxY],
    normalized_xywh: [minX / width, minY / height, w / width, h / height],
    visible_pixel_count: visiblePixelCount,
  };
}

function createPoseControlMap(width: number, height: number, bbox2d: { bbox_xyxy: number[] }) {
  const output = new ImageData(width, height);
  const [x1, y1, x2, y2] = bbox2d.bbox_xyxy.map(Math.round);
  drawLine(output, x1, y1, x2, y1, [255, 255, 255]);
  drawLine(output, x2, y1, x2, y2, [255, 255, 255]);
  drawLine(output, x2, y2, x1, y2, [255, 255, 255]);
  drawLine(output, x1, y2, x1, y1, [255, 255, 255]);
  drawLine(output, Math.round((x1 + x2) / 2), y1, Math.round((x1 + x2) / 2), y2, [174, 103, 255]);
  drawLine(output, x1, Math.round((y1 + y2) / 2), x2, Math.round((y1 + y2) / 2), [236, 76, 214]);
  for (let index = 3; index < output.data.length; index += 4) output.data[index] = 255;
  return output;
}

function drawLine(imageData: ImageData, x1: number, y1: number, x2: number, y2: number, color: [number, number, number]) {
  const dx = Math.abs(x2 - x1);
  const dy = -Math.abs(y2 - y1);
  const sx = x1 < x2 ? 1 : -1;
  const sy = y1 < y2 ? 1 : -1;
  let error = dx + dy;
  let x = x1;
  let y = y1;
  while (true) {
    if (x >= 0 && y >= 0 && x < imageData.width && y < imageData.height) {
      const offset = (y * imageData.width + x) * 4;
      imageData.data[offset] = color[0];
      imageData.data[offset + 1] = color[1];
      imageData.data[offset + 2] = color[2];
      imageData.data[offset + 3] = 255;
    }
    if (x === x2 && y === y2) break;
    const e2 = 2 * error;
    if (e2 >= dy) {
      error += dy;
      x += sx;
    }
    if (e2 <= dx) {
      error += dx;
      y += sy;
    }
  }
}

function createContactSheet(items: Array<[string, ImageData]>) {
  const tileWidth = 256;
  const tileHeight = 286;
  const columns = 5;
  const rows = Math.ceil(items.length / columns);
  const canvas = document.createElement('canvas');
  canvas.width = tileWidth * columns;
  canvas.height = tileHeight * rows;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create contact sheet canvas.');
  context.fillStyle = '#070813';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.font = '13px sans-serif';
  context.textBaseline = 'top';
  items.forEach(([label, imageData], index) => {
    const x = (index % columns) * tileWidth;
    const y = Math.floor(index / columns) * tileHeight;
    const source = document.createElement('canvas');
    source.width = imageData.width;
    source.height = imageData.height;
    source.getContext('2d')?.putImageData(imageData, 0, 0);
    context.drawImage(source, x, y, tileWidth, tileWidth);
    context.fillStyle = '#ffffff';
    context.fillText(label, x + 10, y + tileWidth + 10);
  });
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

function encodeGrayscalePng16(width: number, height: number, gray8: Uint8ClampedArray) {
  const raw = new Uint8Array((width * 2 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 2 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const value16 = (gray8[y * width + x] ?? 0) * 257;
      const offset = rowStart + 1 + x * 2;
      raw[offset] = (value16 >>> 8) & 0xff;
      raw[offset + 1] = value16 & 0xff;
    }
  }
  const chunks = [
    pngChunk('IHDR', new Uint8Array([
      (width >>> 24) & 0xff,
      (width >>> 16) & 0xff,
      (width >>> 8) & 0xff,
      width & 0xff,
      (height >>> 24) & 0xff,
      (height >>> 16) & 0xff,
      (height >>> 8) & 0xff,
      height & 0xff,
      16,
      0,
      0,
      0,
      0,
    ])),
    pngChunk('IDAT', zlibSync(raw, { level: 6 })),
    pngChunk('IEND', new Uint8Array()),
  ];
  return new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks], { type: 'image/png' });
}

function pngChunk(type: string, data: Uint8Array) {
  const typeBytes = textEncoder.encode(type);
  const output = new Uint8Array(12 + data.byteLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, data.byteLength);
  output.set(typeBytes, 4);
  output.set(data, 8);
  view.setUint32(8 + data.byteLength, crc32Bytes(output.subarray(4, 8 + data.byteLength)));
  return output;
}

function crc32Bytes(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function hashBlob(blob: Blob) {
  if (!crypto.subtle) return '';
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function createComfyuiInputs(
  modelSlug: string,
  viewId: string,
  width: number,
  height: number,
  options: ComfyControlExportOptions | undefined,
  hasMaterialReference: boolean,
) {
  return {
    workflow_target: 'zimage_web3d_single_view_v1',
    model_slug: modelSlug,
    view_id: viewId,
    resolution: [width, height],
    recommended_inputs: {
      white_render: 'render/01_white_render.png',
      object_mask: 'masks/01_object_mask.png',
      depth: 'controlnet_ready/control_depth.png',
      edge: 'controlnet_ready/control_edge.png',
      canny: 'controlnet_ready/control_canny.png',
      hed: 'controlnet_ready/control_hed.png',
      scribble: 'controlnet_ready/control_scribble.png',
      gray: 'controlnet_ready/control_gray.png',
      color_hint: 'controlnet_ready/control_color_hint.png',
      inpaint_mask: 'controlnet_ready/control_inpaint_mask.png',
      material_reference: hasMaterialReference ? 'material/01_material_reference.png' : null,
      current_texture_render: 'render/03_current_texture_render.png',
    },
    controlnet_recommendation: {
      primary: [
        { type: 'depth', path: 'controlnet_ready/control_depth.png', strength: 0.75, start: 0, end: 1, note: 'Main geometry control' },
        { type: 'edge_or_hed', path: 'controlnet_ready/control_edge.png', strength: 0.35, start: 0, end: 1, note: 'Silhouette, seams, major structural edges' },
        { type: 'gray', path: 'controlnet_ready/control_gray.png', strength: 0.45, start: 0, end: 1, note: 'Color/basecolor stability' },
      ],
      optional: [
        { type: 'canny', path: 'controlnet_ready/control_canny.png', strength: 0.3 },
        { type: 'scribble', path: 'controlnet_ready/control_scribble.png', strength: 0.3 },
        { type: 'mlsd', path: 'controlnet_ready/control_mlsd.png', strength: 0.25 },
        { type: 'pose', path: 'controlnet_ready/control_pose.png', strength: 0.25 },
      ],
    },
    prompt: {
      positive_template:
        'Generate a clean albedo base color texture for the visible surface of this 3D object. Use the provided depth and edge controls to preserve the exact object shape, silhouette, proportions, and camera view. Apply the material appearance from the reference description. Flat lighting, base color only, no baked shadows, no strong highlights, no reflections. Consistent realistic PBR material color, clean surface texture, physically plausible material detail. No background, no extra objects, no scene elements. Material: {{material_prompt}}',
      material_prompt: options?.materialPrompt ?? '',
      negative_prompt:
        options?.negativePrompt ??
        'avoid baked lighting, cast shadow, glossy reflection, specular highlight, environmental reflection, dramatic lighting, black artifacts, dirty seams, extra objects, background, text, watermark',
    },
    sampling: {
      seed: options?.seed ?? Math.floor(Math.random() * 1_000_000_000),
      steps: 8,
      cfg: 1,
      sampler: 'res_multistep',
      scheduler: 'simple',
      denoise: 1,
    },
    camera_metadata: 'camera/camera_metadata.json',
    matrices: 'camera/matrices.json',
    object_mask: 'masks/01_object_mask.png',
    metadata: 'manifest.json',
  };
}

function createReadme(manifest: ComfyControlManifest, comfyuiInputs: unknown) {
  const unavailable = Object.entries(manifest.files)
    .filter(([, entry]) => !entry.available)
    .slice(0, 24)
    .map(([path, entry]) => `- ${path}: ${entry.reason}`)
    .join('\n');
  return `# ComfyUI Control Input Export

导出时间：${manifest.created_at}

模型：${manifest.model.slug}
view_id：${manifest.view.view_id}
分辨率：${manifest.view.width} x ${manifest.view.height}

## 推荐第一版输入

- Depth: controlnet_ready/control_depth.png, strength 0.75
- Edge / HED / Canny: controlnet_ready/control_edge.png, strength 0.35
- Gray / Color Hint: controlnet_ready/control_gray.png, strength 0.45
- Mask: masks/01_object_mask.png
- Material Reference: material/01_material_reference.png
- Prompt: comfyui_inputs.json.prompt

## 编码说明

- object_mask：白色是当前视角可见模型，黑色是背景。
- depth：来自 Web3D 当前相机离屏 pass，control depth 中白色近、黑色远。
- edge：黑底白线，由 silhouette、depth、normal、material/UV 边界组合。
- normal：normal * 0.5 + 0.5 编码，坐标系记录在 manifest 与 camera metadata。

## 不可用 / fallback

${unavailable || '- 无'}

## ComfyUI 入口

\`\`\`json
${JSON.stringify(comfyuiInputs, null, 2)}
\`\`\`
`;
}

function vectorToArray(vector: THREE.Vector3): [number, number, number] {
  return [Number(vector.x.toFixed(6)), Number(vector.y.toFixed(6)), Number(vector.z.toFixed(6))];
}
