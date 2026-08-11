import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { applyFbxModelVisibility, readFbxModelVisibility } from '../fbxVisibility.ts';

function asciiBuffer(text) {
  return new TextEncoder().encode(text).buffer;
}

function binaryProperty(value) {
  if (typeof value === 'bigint') {
    const buffer = Buffer.alloc(9);
    buffer.write('L', 0);
    buffer.writeBigInt64LE(value, 1);
    return buffer;
  }
  if (typeof value === 'number') {
    const buffer = Buffer.alloc(9);
    buffer.write('D', 0);
    buffer.writeDoubleLE(value, 1);
    return buffer;
  }
  const text = Buffer.from(value, 'utf8');
  const buffer = Buffer.alloc(5 + text.length);
  buffer.write('S', 0);
  buffer.writeUInt32LE(text.length, 1);
  text.copy(buffer, 5);
  return buffer;
}

function binaryNodeSize(node) {
  const properties = node.properties.map(binaryProperty);
  return (
    13 +
    Buffer.byteLength(node.name) +
    properties.reduce((total, property) => total + property.length, 0) +
    node.children.reduce((total, child) => total + binaryNodeSize(child), 0) +
    13
  );
}

function buildBinaryNode(node, startOffset) {
  const name = Buffer.from(node.name, 'utf8');
  const properties = node.properties.map(binaryProperty);
  const propertyLength = properties.reduce((total, property) => total + property.length, 0);
  const size = binaryNodeSize(node);
  const header = Buffer.alloc(13);
  header.writeUInt32LE(startOffset + size, 0);
  header.writeUInt32LE(properties.length, 4);
  header.writeUInt32LE(propertyLength, 8);
  header.writeUInt8(name.length, 12);

  let childOffset = startOffset + header.length + name.length + propertyLength;
  const children = node.children.map((child) => {
    const buffer = buildBinaryNode(child, childOffset);
    childOffset += buffer.length;
    return buffer;
  });
  return Buffer.concat([header, name, ...properties, ...children, Buffer.alloc(13)]);
}

function binaryFbx(modelId, visibility) {
  const header = Buffer.alloc(27);
  header.write('Kaydara FBX Binary  ', 0, 'binary');
  header[20] = 0;
  header[21] = 0x1a;
  header[22] = 0;
  header.writeUInt32LE(7400, 23);
  const model = buildBinaryNode(
    {
      name: 'Model',
      properties: [BigInt(modelId), 'Model::Hidden shell', 'Mesh'],
      children: [
        {
          name: 'Properties70',
          properties: [],
          children: [
            {
              name: 'P',
              properties: ['Visibility', 'Visibility', '', 'A', visibility],
              children: [],
            },
          ],
        },
      ],
    },
    header.length,
  );
  const result = Buffer.concat([header, model, Buffer.alloc(13)]);
  return result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength);
}

test('reads object visibility from ASCII FBX model blocks', () => {
  const source = asciiBuffer(`
Objects: {
  Model: 42, "Model::Hidden shell", "Mesh" {
    Properties70: {
      P: "Visibility", "Visibility", "", "A",0
    }
  }
  Model: 43, "Model::Visible result", "Mesh" {
    Properties70: {
      P: "Visibility", "Visibility", "", "A",1
    }
  }
}`);

  assert.deepEqual([...readFbxModelVisibility(source)], [
    [42, 0],
    [43, 1],
  ]);
});

test('reads object visibility from binary FBX nodes', () => {
  assert.deepEqual([...readFbxModelVisibility(binaryFbx(987654, 0))], [[987654, 0]]);
});

test('applies FBX visibility to loader objects by model id', () => {
  const root = new THREE.Group();
  const hidden = new THREE.Mesh();
  const visible = new THREE.Mesh();
  hidden.ID = 42;
  visible.ID = 43;
  root.add(hidden, visible);
  const source = asciiBuffer(`
Model: 42, "Model::Hidden shell", "Mesh" {
  Properties70: { P: "Visibility", "Visibility", "", "A",0 }
}
Model: 43, "Model::Visible result", "Mesh" {
  Properties70: { P: "Visibility", "Visibility", "", "A",1 }
}`);

  assert.equal(applyFbxModelVisibility(root, source), 1);
  assert.equal(hidden.visible, false);
  assert.equal(visible.visible, true);
});
