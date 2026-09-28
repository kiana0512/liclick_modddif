import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { glbTriangles, completion } from './li3d-workflow.mjs';

function fixture(json) {
  const raw = JSON.stringify(json), data = Buffer.from(raw.padEnd(Math.ceil(raw.length / 4) * 4));
  const b = Buffer.alloc(20 + data.length);
  b.writeUInt32LE(0x46546c67); b.writeUInt32LE(2, 4); b.writeUInt32LE(b.length, 8);
  b.writeUInt32LE(data.length, 12); b.writeUInt32LE(0x4e4f534a, 16); data.copy(b, 20); return b;
}
const model = { scenes: [{ nodes: [0, 1] }], nodes: [{ mesh: 0 }, { mesh: 0 }, { mesh: 1 }], meshes: [{ primitives: [{ indices: 0 }] }, { primitives: [{ indices: 1 }] }], accessors: [{ count: 6 }, { count: 300 }] };
assert.equal(glbTriangles(fixture(model)), 4, 'count scene instances; exclude unused meshes');
assert.throws(() => glbTriangles(fixture(model).subarray(0, 25)), /Invalid|Truncated/);
assert.throws(() => glbTriangles(fixture({ ...model, nodes: [{ children: [0] }] })), /Cyclic/);
assert.throws(() => glbTriangles(fixture({ ...model, accessors: [{ count: 7 }] })), /triangle count/);

const g = (id, view) => ({ id, status: 'succeeded', resultUrl: '/result.png', metadata: { workflow: 'texture-map', cameraViewId: view, projectedLayerId: `layer-${id}`, objectId: 'object-a' } });
const generations = [g('a', 'front'), g('b', 'back')];
const layers = generations.map(g => ({ id: g.metadata.projectedLayerId, generationId: g.id, objectId: 'object-a', imageUrl: '/layer.png' }));
assert.equal(completion({ generations, layers }, 2).complete, true);
assert.equal(completion({ generations, layers: layers.slice(0, 1) }, 2).complete, false, 'server generation success alone is not completion');
assert.equal(completion({ generations: [g('a', 'front'), g('b', 'front')], layers }, 2).complete, false, 'duplicate views must not pass');
assert.equal(completion({ generations, layers: layers.map(l => ({ ...l, objectId: 'wrong-object' })) }, 2).complete, false, 'ownership mismatch must not pass');
assert.equal(completion({ generations: [{ ...g('a', 'front'), status: 'failed' }], layers }, 1).complete, false);
assert.equal(completion({ generations: [{ ...g('a', 'front'), metadata: { ...g('a', 'front').metadata, projectionError: 'QA rejected' } }], layers }, 1).failures[0].error, 'QA rejected');
assert.equal(completion({ generations: [{ ...g('old-a', 'front'), status: 'failed' }, ...generations], layers }, 2).complete, true, 'a successful persisted retry supersedes the failed attempt for the same view');
console.log('li3d-workflow: GLB scene counts and durable generation/layer acceptance passed');
