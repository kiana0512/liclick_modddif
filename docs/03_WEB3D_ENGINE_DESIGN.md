# Web3D Engine Design

The engine lives under `apps/web/src/engine` and should remain separate from UI panels.

## ViewportCanvas

Owns the R3F `Canvas`, background, camera defaults, and viewport overlay.

## SceneRoot

Owns lights, grid, default primitive model, material mode switching, and selection behavior. Real imported GLB scene roots should be inserted here or through a dedicated scene registry.

## CameraController

Provides Perspective and Orthographic camera states plus OrbitControls. Real camera snapshots must include position, target, fov/zoom, near/far, view matrix, and projection matrix.

## Grid

Uses Liclick purple/orange tones for editor orientation. The grid is visual only and should not become geometry used by capture or projection math.

## ViewCube

Currently a UI placeholder. Later it should control camera orientation and expose front/back/left/right/top/bottom snaps.

## Selection

Phase 1 uses a simple edge outline stub. Later versions should use a post-processing outline or selection material override that works with imported meshes.

## Display Modes

- PBR: MeshStandardMaterial preview.
- Flat: unlit MeshBasicMaterial.
- Normal: MeshNormalMaterial.
- Wire: wireframe material.
- Segmentation: later material override based on object/segment ids.

## Capture Passes

The required passes are color, mask, depth, and normal. Real capture must use offscreen render targets and stable object id masks.

## Projected Layer Material

`ProjectedLayerMaterial.ts` is a stub. Later implementation should sample a texture using projection camera matrices and depth checks.

## UV Bake MVP

The first bake can render visible layers into a UV-space render target for one selected mesh and one UV set. It should support basecolor first.

## Math Notes

- Store matrices in column-major order matching Three.js.
- Be explicit about handedness and coordinate conversion when exporting.
- Depth checks must compare projected fragment depth against captured depth with a tolerance.
- Masks should distinguish object visibility from transparent image alpha.
