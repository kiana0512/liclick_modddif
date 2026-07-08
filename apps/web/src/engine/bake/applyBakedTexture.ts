import * as THREE from 'three';

export async function applyBakedTextureToObject(group: THREE.Group, imageUrl: string) {
  const texture = await new THREE.TextureLoader().loadAsync(imageUrl);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = true;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.anisotropy = 8;
  texture.needsUpdate = true;

  console.table({
    appliedTextureImage: `${texture.image?.width ?? 'unknown'}x${texture.image?.height ?? 'unknown'}`,
    flipY: texture.flipY,
    generateMipmaps: texture.generateMipmaps,
    minFilter: texture.minFilter,
    magFilter: texture.magFilter,
  });

  const warnings: string[] = [];
  group.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.userData.bakedTexture = texture;
  });

  return { texture, warnings };
}
