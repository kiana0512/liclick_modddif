# Web3D Engine Design

The engine lives under `apps/web/src/engine` and should remain separate from UI panels.

## ViewportCanvas

Owns the R3F `Canvas`, background, camera defaults, and viewport overlay.

## SceneRoot

Owns lights, grid, default primitive model, material mode switching, and selection behavior. Real imported GLB scene roots should be inserted here or through a dedicated scene registry.

Phase 2 mounts imported models as `THREE.Group` instances stored in `sceneStore.importedModel`. The primitive demo appears only when no real model has been imported. Imported models are assigned `liclickObjectId` metadata and rendered through the same display-mode pipeline.

Phase 4 normalization is handled by `engine/scene/normalizeImportedModel.ts`. It computes the original bounding box, scales the model to a practical editor size, centers XZ, grounds the bottom to Y=0 when enabled, and records the applied parent transform. It must not mutate mesh geometry, vertex buffers, or source scene children. User edits live in the imported group transform and are mirrored to `SceneObject.userTransform`.

## CameraController

Provides Perspective and Orthographic camera states plus OrbitControls. Real camera snapshots must include position, target, fov/zoom, near/far, view matrix, and projection matrix.

Imported models trigger an automatic fit-camera pass based on their computed bounding box when Auto Fit is enabled. Projected layers can restore the saved capture camera through `requestCameraRestore`.

## Grid

Uses Liclick purple/orange tones for editor orientation. The grid is visual only and should not become geometry used by capture or projection math.

## ViewCube

Currently a UI placeholder. Later it should control camera orientation and expose front/back/left/right/top/bottom snaps.

## Selection

Phase 1 uses a simple edge outline stub. Later versions should use a post-processing outline or selection material override that works with imported meshes.

## Transform Controls

`ObjectTransformControls` mounts Drei `TransformControls` for the selected imported model. The bottom toolbar selects `select`, `translate`, `rotate`, or `scale`. OrbitControls must be disabled while the transform gizmo is dragging and re-enabled afterward.

Transform actions are kept under `engine/scene/transformActions.ts`:

- Reset Transform restores the import normalization transform.
- Center recenters the object on XZ.
- Ground moves the object so its current bounding box bottom is Y=0.
- Fit Camera frames the current object without changing object transforms.

## Display Modes

- PBR: MeshStandardMaterial preview.
- Flat: unlit MeshBasicMaterial.
- Normal: MeshNormalMaterial.
- Wire: wireframe material.
- Segmentation: later material override based on object/segment ids.

Normal mode is a debug preview. The UI should tell users that the colors visualize surface normals and are not the final texture result.

## Capture Passes

The required passes are color, mask, depth, and normal. Real capture must use offscreen render targets and stable object id masks.

Phase 2 implements real WebGL render-target capture:

- Color renders the current scene and camera into PNG.
- Mask temporarily renders only the selected object with a white material on black background.
- Normal temporarily renders only the selected object with `MeshNormalMaterial`.
- Depth temporarily renders only the selected object with `MeshDepthMaterial` and grayscale depth packing.

All capture passes restore object visibility and materials after rendering.

## Projected Layer Material

`ProjectedLayerMaterial.ts` is the current shader projection preview path. Future versions should add stricter depth checks and multi-layer compositing.

Phase 2 replaces the stub with a basic custom `ShaderMaterial`. It projects world-space fragments into the saved capture camera clip space, samples the generated texture, and blends it with a simple shaded base color using layer opacity. The current preview guarantees the active visible projected layer; multi-layer compositing and depth checks are future work.

`three-projected-material` is installed but not directly coupled to business logic. The current implementation uses the Liclick shader adapter so the projection path remains under local control.

## UV Bake MVP

The first bake can render visible layers into a UV-space render target for one selected mesh and one UV set. It should support basecolor first.

## Math Notes

- Store matrices in column-major order matching Three.js.
- Be explicit about handedness and coordinate conversion when exporting.
- Depth checks must compare projected fragment depth against captured depth with a tolerance.
- Masks should distinguish object visibility from transparent image alpha.
