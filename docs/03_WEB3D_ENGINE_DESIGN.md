# Web3D Engine Design

The engine lives under `apps/web/src/engine` and should remain separate from UI panels.

## ViewportCanvas

Owns the R3F `Canvas`, background, camera defaults, and viewport overlay.

Phase 5 keeps the viewport as the primary workspace surface. Left and right UI modules now float over the viewport as dock panels, so engine code should not assume the canvas has been narrowed by fixed sidebars.

## SceneRoot

Owns lights, grid, default primitive model, material mode switching, projected/UV overlay preview, and selection behavior. Real imported GLB scene roots should be inserted here or through a dedicated scene registry.

Phase 2 mounts imported models as `THREE.Group` instances stored in `sceneStore.importedModel`. The primitive demo appears only when no real model has been imported. Imported models are assigned `liclickObjectId` metadata and rendered through the same display-mode pipeline.

Phase 4 normalization is handled by `engine/scene/normalizeImportedModel.ts`. It computes the original bounding box, scales the model to a practical editor size, centers XZ, grounds the bottom to Y=0 when enabled, and records the applied parent transform. It must not mutate mesh geometry, vertex buffers, or source scene children. User edits live in the imported group transform and are mirrored to `SceneObject.userTransform`.

## CameraController

Provides Perspective and Orthographic camera states plus OrbitControls. Real camera snapshots must include position, target, fov/zoom, near/far, view matrix, and projection matrix.

Imported models trigger an automatic fit-camera pass based on their computed bounding box when Auto Fit is enabled. Projected layers can restore the saved capture camera through `requestCameraRestore`.

## Grid

Uses Liclick purple/orange tones for editor orientation. The grid is visual only and should not become geometry used by capture or projection math.

## ViewCube

The ViewCube is a viewport overlay anchored at the right-top corner above dock panels and toolbars. It reads the active camera and OrbitControls target from `sceneStore.viewport`, rotates a CSS 3D cube to match the camera direction, and labels the dominant view face: Front, Back, Left, Right, Top, or Bottom.

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

- PBR: MeshStandardMaterial preview with sRGB textures, ACES tone mapping, studio lighting, and fallback material repair for dark or missing materials.
- Flat: unlit preview using baked/base color texture when available. If the layer stack is not baked but a UV texture exists, the viewport uses the UV overlay preview material rather than pretending the UV layer is the baked base material.
- Normal: MeshNormalMaterial.
- Wire: wireframe material.
- Segmentation: later material override based on object/segment ids.

Normal mode is a debug preview. The UI should tell users that the colors visualize surface normals and are not the final texture result.

The top workspace modes are UI modes, not new render engines:

- Texture mode uses the existing PBR / Flat / Normal / Wire display controls.
- Normal mode switches the viewport to normal display and shows normal-related panels.
- Segments and Export modes show placeholder panel groups until their real engine paths are implemented.

## Capture Passes

The required passes are color, mask, depth, and normal. Real capture must use offscreen render targets and stable object id masks.

Phase 2 implements real WebGL render-target capture:

- Color renders the current scene and camera into PNG.
- Mask temporarily renders only the selected object with a white material on black background.
- Normal temporarily renders only the selected object with `MeshNormalMaterial`.
- Depth temporarily renders only the selected object with `MeshDepthMaterial` and grayscale depth packing.

All capture passes restore object visibility and materials after rendering.

## Projected Layer Material

`ProjectedLayerMaterial.ts` is the shader projection preview path. It projects world-space fragments into the saved capture camera clip space, rejects pixels outside the projector frustum, applies edge feathering, backface rejection, optional mask sampling, and an MVP grayscale depth comparison before blending generated images by layer opacity.

The current material path supports both single-layer and stacked projected previews. The stack shader separates loose coverage from strict quality, blends order-independent projected candidates, applies overlay layers in stack order, and falls back to the model/base material for uncovered fragments. `uvOverlayTexture` is a separate sampler from `baseTexture`, so an unbaked UV result can be previewed without overwriting the baked/base material.

Projected layer shader materials store per-layer object-matrix snapshot metadata in `material.userData`. Exported turntable WebM uses that metadata to update object matrix delta uniforms during rotation, so projected textures stay attached to the model instead of behaving like a stale screen-space overlay.

`three-projected-material` is installed but not directly coupled to business logic. The current implementation uses the Liclick shader adapter so the projection path remains under local control.

## UV Bake MVP

The current bake renders visible projected layers into a UV-space render target for one selected imported object and one UV channel. BaseColor is the implemented output. The GPU path is preferred, with CPU rasterization as a same-resolution fallback when coverage validation or GPU allocation fails.

## Math Notes

- Store matrices in column-major order matching Three.js.
- Be explicit about handedness and coordinate conversion when exporting.
- Depth checks must compare projected fragment depth against captured depth with a tolerance.
- Masks should distinguish object visibility from transparent image alpha.
