export type ComfyControlValidationFile = {
  available: boolean;
  width?: number;
  height?: number;
};

export type ComfyControlValidationInput = {
  width: number;
  height: number;
  files: Record<string, ComfyControlValidationFile>;
  maskWhitePixels: number;
  depthNonZeroPixels: number;
  manifest: unknown;
  comfyuiInputs: unknown;
};

const requiredFirstPassFiles = [
  'render/01_white_render.png',
  'masks/01_object_mask.png',
  'geometry/01_depth_preview_8.png',
  'geometry/01_depth_linear_16.png',
  'geometry/07_normal_world.png',
  'geometry/08_normal_view.png',
  'edges/04_combined_edge.png',
  'material/03_color_hint.png',
  'controlnet_ready/control_depth.png',
  'controlnet_ready/control_edge.png',
  'controlnet_ready/control_gray.png',
  'camera/camera_metadata.json',
  'camera/matrices.json',
  'pose/03_relative_pose.json',
  'manifest.json',
  'comfyui_inputs.json',
  'README.md',
  'debug/debug_contact_sheet.png',
];

export function validateComfyControlExportPackage(input: ComfyControlValidationInput) {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const path of requiredFirstPassFiles) {
    const file = input.files[path];
    if (!file?.available) {
      errors.push(`Missing required Comfy control export file: ${path}`);
      continue;
    }
    const requiresAlignedResolution = path.endsWith('.png') && path !== 'debug/debug_contact_sheet.png';
    if (requiresAlignedResolution && (file.width !== input.width || file.height !== input.height)) {
      errors.push(`Resolution mismatch for ${path}: expected ${input.width}x${input.height}.`);
    }
  }

  if (input.maskWhitePixels <= 0) errors.push('Object mask is empty.');
  if (input.depthNonZeroPixels <= 0) errors.push('Depth pass is empty.');
  if (!input.manifest || typeof input.manifest !== 'object') errors.push('manifest.json is not an object.');
  if (!input.comfyuiInputs || typeof input.comfyuiInputs !== 'object') errors.push('comfyui_inputs.json is not an object.');

  return {
    ok: errors.length === 0,
    errors,
    warnings,
  };
}
