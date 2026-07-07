import * as THREE from 'three';

export async function applyBakedTextureToObject(group: THREE.Group, imageUrl: string) {
  const texture = await new THREE.TextureLoader().loadAsync(imageUrl);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  texture.needsUpdate = true;

  const warnings: string[] = [];
  group.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.userData.bakedTexture = texture;
  });

  return { texture, warnings };
}
