import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  getVisiblePreviewBounds,
  repairConcaveFbxGeometry,
} from '../repairFbxPreviewGeometry.ts';

function fanGeometry(points) {
  const positions = [];
  const normals = [];
  for (let index = 2; index < points.length; index += 1) {
    [points[0], points[index - 1], points[index]].forEach(([x, y]) => {
      positions.push(x, y, 0);
      normals.push(0, 0, 1);
    });
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  return geometry;
}

function renderedArea(geometry) {
  const position = geometry.getAttribute('position');
  const first = new THREE.Vector3();
  const second = new THREE.Vector3();
  const third = new THREE.Vector3();
  const edgeA = new THREE.Vector3();
  const edgeB = new THREE.Vector3();
  let area = 0;
  for (let index = 0; index < position.count; index += 3) {
    first.fromBufferAttribute(position, index);
    second.fromBufferAttribute(position, index + 1);
    third.fromBufferAttribute(position, index + 2);
    area += edgeA.subVectors(second, first).cross(edgeB.subVectors(third, first)).length() * 0.5;
  }
  return area;
}

test('re-triangulates a concave FBX fan without filling its opening', () => {
  const outline = [
    [0, 3],
    [0, 0],
    [3, 0],
    [3, 3],
    [2, 3],
    [2, 1],
    [1, 1],
    [1, 3],
  ];
  const source = fanGeometry(outline);
  assert.equal(renderedArea(source), 13);

  const repaired = repairConcaveFbxGeometry(source);

  assert.notEqual(repaired, source);
  assert.equal(repaired.userData.previewConcavePolygonsRepaired, 1);
  assert.equal(renderedArea(repaired), 7);
  assert.equal(repaired.getAttribute('position').count, source.getAttribute('position').count);
  assert.equal(repaired.getAttribute('normal').count, source.getAttribute('normal').count);
});

test('leaves a convex FBX fan untouched', () => {
  const source = fanGeometry([
    [0, 0],
    [2, 0],
    [2, 2],
    [0, 2],
  ]);

  assert.equal(repairConcaveFbxGeometry(source), source);
});

test('preview bounds ignore hidden FBX helper meshes', () => {
  const root = new THREE.Group();
  const visible = new THREE.Mesh(new THREE.BoxGeometry(2, 4, 6));
  const hidden = new THREE.Mesh(new THREE.BoxGeometry(200, 200, 200));
  hidden.visible = false;
  root.add(visible, hidden);

  const size = getVisiblePreviewBounds(root).getSize(new THREE.Vector3());

  assert.deepEqual(size.toArray(), [2, 4, 6]);
});
