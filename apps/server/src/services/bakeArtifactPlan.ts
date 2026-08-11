export type BakeArtifactChannel =
  | 'baseColor'
  | 'normal'
  | 'ambientOcclusion'
  | 'curvature'
  | 'worldNormal'
  | 'thickness'
  | 'position'
  | 'roughness'
  | 'metallic';

const artifactChannelMap: Record<string, BakeArtifactChannel | undefined> = {
  'asset_base_color.png': 'baseColor',
  'asset_roughness.png': 'roughness',
  'asset_metallic.png': 'metallic',
  'asset_ao.png': 'ambientOcclusion',
  'asset_world_normal.png': 'worldNormal',
  'asset_curvature.png': 'curvature',
  'asset_thickness.png': 'thickness',
  'asset_position.png': 'position',
};

export function bakeArtifactChannel(
  fileName: string,
  normalOrientation: 'directx' | 'opengl',
) {
  if (
    fileName === (normalOrientation === 'opengl' ? 'asset_normal_gl.png' : 'asset_normal_dx.png')
  ) {
    return 'normal' as const;
  }
  return artifactChannelMap[fileName];
}

export function selectBakeArtifactFileNames(input: {
  availableFileNames: readonly string[];
  channels: readonly BakeArtifactChannel[];
  normalOrientation: 'directx' | 'opengl';
  generateRoughnessFromBakedBaseColor?: boolean;
}) {
  const selectedChannels = new Set(input.channels);
  return input.availableFileNames.filter((fileName) => {
    const channel = bakeArtifactChannel(fileName, input.normalOrientation);
    // Preserve diagnostic reports and logs exactly as before. Only unselected
    // full-resolution asset maps are omitted from the transfer.
    if (!fileName.startsWith('asset_')) return true;
    if (!channel || !selectedChannels.has(channel)) return false;
    // A follow-up ComfyUI result replaces this map, so downloading the remote
    // roughness first only adds a redundant 4K transfer.
    return !(
      channel === 'roughness' && input.generateRoughnessFromBakedBaseColor === true
    );
  });
}
