import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({
  root,
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true },
});

function assertVectorClose(actual, expected, message) {
  assert(
    actual.distanceTo(expected) < 1e-6,
    `${message}: received ${actual.toArray().join(', ')}`,
  );
}

try {
  const {
    getViewCubeRotation,
    modelViewDirectionToWorld,
    worldViewDirectionToModelLocal,
  } = await server.ssrLoadModule('/src/engine/viewport/viewCubeOrientation.ts');
  const { BlenderOrbitControls } = await server.ssrLoadModule(
    '/src/engine/viewport/BlenderOrbitControls.ts',
  );

  const identity = new THREE.Quaternion();
  assertVectorClose(
    worldViewDirectionToModelLocal(new THREE.Vector3(1, 0, 0), identity),
    new THREE.Vector3(1, 0, 0),
    'Identity model orientation must preserve the camera direction',
  );

  assert.deepEqual(getViewCubeRotation(new THREE.Vector3(0, 0, 1)), {
    pitch: -0,
    yaw: -0,
  });
  assert.equal(
    getViewCubeRotation(new THREE.Vector3(1, 0, 0)).yaw,
    -90,
    'A camera on the user-right side must rotate the Right cube face toward the user',
  );
  assert.equal(
    getViewCubeRotation(new THREE.Vector3(-1, 0, 0)).yaw,
    90,
    'A camera on the user-left side must rotate the Left cube face toward the user',
  );

  const modelRotation = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0),
    Math.PI / 2,
  );
  const rotatedFront = modelViewDirectionToWorld(
    new THREE.Vector3(0, 0, 1),
    modelRotation,
  );
  assertVectorClose(
    worldViewDirectionToModelLocal(rotatedFront, modelRotation),
    new THREE.Vector3(0, 0, 1),
    'The cube must stay aligned with a rotated model',
  );

  const rightFaceNormal = new THREE.Vector3(1, 0, 0).applyAxisAngle(
    new THREE.Vector3(0, 1, 0),
    THREE.MathUtils.degToRad(getViewCubeRotation(new THREE.Vector3(1, 0, 0)).yaw),
  );
  assertVectorClose(
    rightFaceNormal,
    new THREE.Vector3(0, 0, 1),
    'The Right label must be the visible face from the user-right view',
  );

  const viewCubeSource = await fs.readFile(
    path.join(root, 'src/engine/viewport/ViewCube.tsx'),
    'utf8',
  );
  assert.doesNotMatch(
    viewCubeSource,
    /setRotation|setActiveLabel/,
    'Camera changes must not schedule React state updates for transient cube presentation',
  );
  assert.match(
    viewCubeSource,
    /cubeRef\.current\.style\.transform/,
    'Camera changes must update the cube transform through its presentation ref',
  );
  assert.match(
    viewCubeSource,
    /activeLabelElementRef\.current\.textContent/,
    'Camera changes must update the active label without a React commit',
  );
  const viewportCanvasSource = await fs.readFile(
    path.join(root, 'src/engine/viewport/ViewportCanvas.tsx'),
    'utf8',
  );
  assert.doesNotMatch(
    viewportCanvasSource,
    /setCaptureFrameVisible/,
    'Wheel activity must not rerender the full viewport to reveal the capture frame',
  );
  assert.match(
    viewportCanvasSource,
    /captureFrameElement\.style\.opacity/,
    'The capture-frame transition must remain a presentation-only DOM update',
  );

  const inputListeners = new Map();
  const listenerTarget = {
    addEventListener(type, listener) {
      inputListeners.set(type, listener);
    },
    removeEventListener(type) {
      inputListeners.delete(type);
    },
    clientHeight: 800,
    ownerDocument: { defaultView: undefined },
  };
  const perspectiveCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  perspectiveCamera.position.set(0, 0, 5);
  let wheelActivitySignals = 0;
  const controls = new BlenderOrbitControls(perspectiveCamera, listenerTarget, () => {
    wheelActivitySignals += 1;
  });
  let orientationNotifications = 0;
  controls.subscribeChange(() => {
    orientationNotifications += 1;
  });
  controls.update();
  assert.equal(orientationNotifications, 1, 'Explicit camera updates must notify the cube');
  controls.zoomByFactor(0.9);
  assert.equal(
    orientationNotifications,
    1,
    'Perspective wheel zoom must not notify orientation-only cube listeners',
  );
  assert.equal(
    perspectiveCamera.position.distanceTo(controls.target),
    4.5,
    'Suppressing the cube notification must preserve the exact perspective dolly distance',
  );

  const wheelListener = inputListeners.get('wheel');
  assert.equal(typeof wheelListener, 'function', 'Wheel input must be registered');
  for (let index = 0; index < 4; index += 1) {
    wheelListener({ deltaMode: 0, deltaY: 100 });
  }
  assert.equal(
    wheelActivitySignals,
    4,
    'Every raw wheel packet must synchronously claim the viewport interaction budget',
  );
  const distanceBeforeWheelFrame = perspectiveCamera.position.distanceTo(controls.target);
  const expectedWheelTarget = distanceBeforeWheelFrame * Math.exp(4 * 100 * controls.zoomSpeed);
  controls.updateWheelTransition(1 / 60);
  const distanceAfterFirstWheelFrame = perspectiveCamera.position.distanceTo(controls.target);
  assert.equal(
    wheelActivitySignals,
    5,
    'The rendered transition must keep interaction priority active after raw input ends',
  );
  const firstFrameProgress =
    Math.log(distanceAfterFirstWheelFrame / distanceBeforeWheelFrame) /
    Math.log(expectedWheelTarget / distanceBeforeWheelFrame);
  assert.ok(
    firstFrameProgress < 0.024,
    `The first 60 Hz frame must consume under 2.4% of the logarithmic zoom target; received ${(firstFrameProgress * 100).toFixed(2)}%`,
  );
  assert.ok(
    distanceAfterFirstWheelFrame > distanceBeforeWheelFrame &&
      distanceAfterFirstWheelFrame < expectedWheelTarget,
    'The first rendered frame must move toward the zoom target without jumping directly to it',
  );
  for (let frame = 0; frame < 90; frame += 1) controls.updateWheelTransition(1 / 60);
  assert.ok(
    wheelActivitySignals > 5,
    'Viewport interaction priority must stay active until the smooth zoom settles',
  );
  assert.ok(
    Math.abs(perspectiveCamera.position.distanceTo(controls.target) - expectedWheelTarget) < 0.005,
    'The damped transition must converge to the complete accumulated wheel target',
  );
  assert.equal(
    orientationNotifications,
    1,
    'Damped perspective zoom must not notify orientation-only cube listeners',
  );
  assert.doesNotMatch(
    viewportCanvasSource,
    /onWheelCapture=/,
    'High-frequency wheel packets must bypass React SyntheticEvent dispatch',
  );
  assert.match(
    viewportCanvasSource,
    /addEventListener\('wheel', handleWheel, \{ passive: true \}\)/,
    'Capture-frame wheel observation must use one native passive listener',
  );
  controls.dispose();

  stdout.write(
    'ViewCube orientation and no-camera-React-commit regression test passed.\n',
  );
} finally {
  await server.close();
}
