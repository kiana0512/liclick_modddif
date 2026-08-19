import { Quaternion, Vector3 } from 'three';

export type ViewCubeRotation = {
  pitch: number;
  yaw: number;
};

/**
 * Converts a world-space camera direction into the selected model's local axes.
 * This keeps Front/Back/Left/Right attached to the model when the model rotates.
 */
export function worldViewDirectionToModelLocal(
  worldDirection: Vector3,
  modelWorldQuaternion: Quaternion,
  target = new Vector3(),
  inverseModelWorldQuaternion = new Quaternion(),
) {
  return target
    .copy(worldDirection)
    .applyQuaternion(inverseModelWorldQuaternion.copy(modelWorldQuaternion).invert())
    .normalize();
}

/** Converts a model-relative cube direction into the world-space camera direction. */
export function modelViewDirectionToWorld(
  modelDirection: Vector3,
  modelWorldQuaternion: Quaternion,
  target = new Vector3(),
) {
  return target.copy(modelDirection).applyQuaternion(modelWorldQuaternion).normalize();
}

/**
 * The cube is the inverse view indicator: when the camera is on the model's
 * right (+X), the Right face must turn toward the user. CSS therefore uses the
 * inverse horizontal angle rather than the camera yaw itself.
 */
export function getViewCubeRotation(modelDirection: Vector3): ViewCubeRotation {
  const yaw = Math.atan2(modelDirection.x, modelDirection.z) * (180 / Math.PI);
  const pitch =
    Math.atan2(modelDirection.y, Math.hypot(modelDirection.x, modelDirection.z)) *
    (180 / Math.PI);

  return { pitch: -pitch, yaw: -yaw };
}
