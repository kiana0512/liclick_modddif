import * as THREE from 'three';

type AttributeMap = Record<string, THREE.BufferAttribute | THREE.InterleavedBufferAttribute>;

function attributesMatch(attributes: AttributeMap, left: number, right: number) {
  for (const attribute of Object.values(attributes)) {
    if (attribute instanceof THREE.InterleavedBufferAttribute) return false;
    for (let component = 0; component < attribute.itemSize; component += 1) {
      if (attribute.array[left * attribute.itemSize + component] !== attribute.array[right * attribute.itemSize + component]) {
        return false;
      }
    }
  }
  return true;
}

function polygonNormal(position: THREE.BufferAttribute, corners: number[]) {
  const normal = new THREE.Vector3();
  for (let index = 0; index < corners.length; index += 1) {
    const currentIndex = corners[index];
    const nextIndex = corners[(index + 1) % corners.length];
    const currentX = position.getX(currentIndex);
    const currentY = position.getY(currentIndex);
    const currentZ = position.getZ(currentIndex);
    const nextX = position.getX(nextIndex);
    const nextY = position.getY(nextIndex);
    const nextZ = position.getZ(nextIndex);
    normal.x += (currentY - nextY) * (currentZ + nextZ);
    normal.y += (currentZ - nextZ) * (currentX + nextX);
    normal.z += (currentX - nextX) * (currentY + nextY);
  }
  return normal;
}

function projectPolygon(
  position: THREE.BufferAttribute,
  corners: number[],
  normal: THREE.Vector3,
) {
  const axis = new THREE.Vector3(Math.abs(normal.x), Math.abs(normal.y), Math.abs(normal.z));
  if (axis.x >= axis.y && axis.x >= axis.z) {
    return corners.map((index) => new THREE.Vector2(position.getY(index), position.getZ(index)));
  }
  if (axis.y >= axis.z) {
    return corners.map((index) => new THREE.Vector2(position.getX(index), position.getZ(index)));
  }
  return corners.map((index) => new THREE.Vector2(position.getX(index), position.getY(index)));
}

function isConcave(points: THREE.Vector2[]) {
  let positive = false;
  let negative = false;
  let maxCoordinate = 1;
  points.forEach((point) => {
    maxCoordinate = Math.max(maxCoordinate, Math.abs(point.x), Math.abs(point.y));
  });
  const epsilon = maxCoordinate * maxCoordinate * 1e-10;

  for (let index = 0; index < points.length; index += 1) {
    const previous = points[(index + points.length - 1) % points.length];
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const cross =
      (current.x - previous.x) * (next.y - current.y) -
      (current.y - previous.y) * (next.x - current.x);
    if (cross > epsilon) positive = true;
    if (cross < -epsilon) negative = true;
    if (positive && negative) return true;
  }
  return false;
}

function isPlanar(
  position: THREE.BufferAttribute,
  corners: number[],
  normal: THREE.Vector3,
) {
  const unitNormal = normal.clone().normalize();
  const origin = new THREE.Vector3().fromBufferAttribute(position, corners[0]);
  const point = new THREE.Vector3();
  const bounds = new THREE.Box3();
  corners.forEach((index) => bounds.expandByPoint(point.fromBufferAttribute(position, index)));
  const tolerance = Math.max(bounds.getSize(point).length() * 1e-5, 1e-7);
  return corners.every((index) => {
    point.fromBufferAttribute(position, index);
    return Math.abs(unitNormal.dot(point.sub(origin))) <= tolerance;
  });
}

function copyAttributeInOrder(attribute: THREE.BufferAttribute, order: number[]) {
  const copy = attribute.clone();
  order.forEach((sourceIndex, targetIndex) => copy.copyAt(targetIndex, attribute, sourceIndex));
  copy.needsUpdate = true;
  return copy;
}

/**
 * FBXLoader expands every FBX polygon into a non-indexed triangle fan. That is
 * correct for convex polygons, but a fan cuts straight across concave faces and
 * creates the large false panels visible in the workflow preview. Reconstruct
 * only coplanar, concave fan runs and triangulate their original outline with
 * Earcut (via ShapeUtils), retaining every imported vertex attribute.
 */
export function repairConcaveFbxGeometry(geometry: THREE.BufferGeometry) {
  const position = geometry.getAttribute('position');
  if (
    geometry.getIndex() ||
    !(position instanceof THREE.BufferAttribute) ||
    position.count < 6 ||
    position.count % 3 !== 0
  ) {
    return geometry;
  }

  const attributes = geometry.attributes as AttributeMap;
  if (Object.values(attributes).some((attribute) => attribute instanceof THREE.InterleavedBufferAttribute)) {
    return geometry;
  }
  if (
    Object.values(geometry.morphAttributes).some((morphAttributes) =>
      morphAttributes.some((attribute) => attribute instanceof THREE.InterleavedBufferAttribute),
    )
  ) {
    return geometry;
  }

  const breakpoints = new Set([0, position.count]);
  geometry.groups.forEach((group) => {
    breakpoints.add(Math.max(0, Math.min(position.count, group.start)));
    breakpoints.add(Math.max(0, Math.min(position.count, group.start + group.count)));
  });
  const spans = [...breakpoints]
    .sort((left, right) => left - right)
    .filter((value, index, values) => index === 0 || value !== values[index - 1]);

  const order = Array.from({ length: position.count }, (_, index) => index);
  let repairedPolygonCount = 0;
  const edgeA = new THREE.Vector3();
  const edgeB = new THREE.Vector3();
  const triangleNormal = new THREE.Vector3();

  for (let spanIndex = 0; spanIndex < spans.length - 1; spanIndex += 1) {
    const spanStart = spans[spanIndex];
    const spanEnd = spans[spanIndex + 1];
    if (spanStart % 3 !== 0 || spanEnd % 3 !== 0) continue;

    for (let cursor = spanStart; cursor < spanEnd; ) {
      const corners = [cursor, cursor + 1, cursor + 2];
      let nextTriangle = cursor + 3;
      while (
        nextTriangle + 2 < spanEnd &&
        attributesMatch(attributes, cursor, nextTriangle) &&
        attributesMatch(attributes, corners[corners.length - 1], nextTriangle + 1)
      ) {
        corners.push(nextTriangle + 2);
        nextTriangle += 3;
      }

      if (corners.length < 4) {
        cursor += 3;
        continue;
      }

      const normal = polygonNormal(position, corners);
      const projected = projectPolygon(position, corners, normal);
      if (
        normal.lengthSq() <= Number.EPSILON ||
        !isPlanar(position, corners, normal) ||
        !isConcave(projected)
      ) {
        cursor = nextTriangle;
        continue;
      }

      const triangles = THREE.ShapeUtils.triangulateShape(projected, []);
      if (triangles.length !== corners.length - 2) {
        cursor = nextTriangle;
        continue;
      }

      let target = cursor;
      triangles.forEach((triangle) => {
        const first = triangle[0];
        let [, second, third] = triangle;
        edgeA
          .fromBufferAttribute(position, corners[second])
          .sub(new THREE.Vector3().fromBufferAttribute(position, corners[first]));
        edgeB
          .fromBufferAttribute(position, corners[third])
          .sub(new THREE.Vector3().fromBufferAttribute(position, corners[first]));
        triangleNormal.crossVectors(edgeA, edgeB);
        if (triangleNormal.dot(normal) < 0) [second, third] = [third, second];
        order[target] = corners[first];
        order[target + 1] = corners[second];
        order[target + 2] = corners[third];
        target += 3;
      });
      repairedPolygonCount += 1;
      cursor = nextTriangle;
    }
  }

  if (repairedPolygonCount === 0) return geometry;

  const repaired = geometry.clone();
  Object.entries(attributes).forEach(([name, attribute]) => {
    repaired.setAttribute(name, copyAttributeInOrder(attribute as THREE.BufferAttribute, order));
  });
  Object.entries(geometry.morphAttributes).forEach(([name, morphAttributes]) => {
    repaired.morphAttributes[name] = morphAttributes.map((attribute) =>
      copyAttributeInOrder(attribute as THREE.BufferAttribute, order),
    );
  });
  repaired.computeBoundingBox();
  repaired.computeBoundingSphere();
  repaired.userData = {
    ...repaired.userData,
    previewConcavePolygonsRepaired: repairedPolygonCount,
  };
  return repaired;
}

export function repairConcaveFbxPreview(root: THREE.Object3D) {
  const replacements = new Map<THREE.BufferGeometry, THREE.BufferGeometry>();
  root.traverseVisible((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    let repaired = replacements.get(child.geometry);
    if (!repaired) {
      repaired = repairConcaveFbxGeometry(child.geometry);
      replacements.set(child.geometry, repaired);
    }
    child.geometry = repaired;
  });

  replacements.forEach((repaired, original) => {
    if (repaired !== original) original.dispose();
  });
}

export function getVisiblePreviewBounds(root: THREE.Object3D) {
  root.updateMatrixWorld(true);
  const bounds = new THREE.Box3();
  const meshBounds = new THREE.Box3();
  root.traverseVisible((child) => {
    if (!(child instanceof THREE.Mesh) || !child.geometry) return;
    if (!child.geometry.boundingBox) child.geometry.computeBoundingBox();
    if (!child.geometry.boundingBox || child.geometry.boundingBox.isEmpty()) return;
    meshBounds.copy(child.geometry.boundingBox).applyMatrix4(child.matrixWorld);
    bounds.union(meshBounds);
  });
  return bounds;
}

export function frameVisiblePreviewObject(root: THREE.Group, targetMaxDimension = 3) {
  const bounds = getVisiblePreviewBounds(root);
  if (bounds.isEmpty()) return undefined;

  const size = bounds.getSize(new THREE.Vector3());
  const maxDimension = Math.max(size.x, size.y, size.z);
  if (!Number.isFinite(maxDimension) || maxDimension <= 0) return undefined;

  root.scale.multiplyScalar(targetMaxDimension / maxDimension);
  root.updateMatrixWorld(true);

  const scaledBounds = getVisiblePreviewBounds(root);
  const center = scaledBounds.getCenter(new THREE.Vector3());
  root.position.x -= center.x;
  root.position.y -= scaledBounds.min.y;
  root.position.z -= center.z;
  root.updateMatrixWorld(true);
  return getVisiblePreviewBounds(root);
}
