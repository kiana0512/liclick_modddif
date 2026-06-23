import * as THREE from 'three';

function materialWithBakedMap(material: THREE.Material, texture: THREE.Texture) {
  if (material instanceof THREE.MeshStandardMaterial || material instanceof THREE.MeshBasicMaterial) {
    material.map = texture;
    material.color.set('#ffffff');
    material.transparent = false;
    material.alphaTest = 0;
    material.needsUpdate = true;
    return material;
  }

  return new THREE.MeshStandardMaterial({
    name: material.name || 'Liclick baked material',
    map: texture,
    transparent: false,
    alphaTest: 0,
    roughness: 0.55,
    metalness: 0.08,
  });
}

export async function applyBakedTextureToObject(group: THREE.Group, imageUrl: string) {
  const texture = await new THREE.TextureLoader().loadAsync(imageUrl);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false;
  texture.needsUpdate = true;

  const warnings: string[] = [];
  group.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    const bakedMaterials = materials.map((material) => {
      if (!(material instanceof THREE.MeshStandardMaterial || material instanceof THREE.MeshBasicMaterial)) {
        warnings.push(`Material ${material.name || material.uuid} was replaced with MeshStandardMaterial.`);
      }
      return materialWithBakedMap(material, texture);
    });

    child.material = Array.isArray(child.material) ? bakedMaterials : bakedMaterials[0];
    child.userData.originalMaterial = child.material;
    child.userData.bakedTexture = texture;
  });

  return { texture, warnings };
}
