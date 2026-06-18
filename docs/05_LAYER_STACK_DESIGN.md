# Layer Stack Design

The layer stack is the core editing model for Liclick texture work.

## Layer Types

- `projected`: image generated from a camera view and projected back onto the mesh.
- `uv`: texture authored directly in UV space.
- `patch`: localized inpaint or repair image with mask.
- `normal`: normal-map layer or generated normal result.

## Projected Layer Workflow

1. Select object and camera view.
2. Capture color/mask/depth/normal.
3. Generate image.
4. Add image as projected layer with camera snapshot.
5. Preview in viewport.
6. Bake into UV output when needed.

## UV Layer Workflow

UV layers are already in texture space and do not need projection. They participate in blend, opacity, and export.

## Patch Layer Workflow

Patch layers include a mask and target region. They are used by inpaint and localized corrections.

## UI

The right panel lists layers with thumbnail, visibility toggle, opacity slider, rename placeholder, delete, and go-to-camera placeholder.

## Persistence

Layer metadata lives in `project.liclick.json`. Image assets should be stored in the workspace asset folders or object storage blobs referenced by URL.

## Blend, Opacity, Visibility

Composition order is determined by `order`. Invisible layers are skipped. Opacity is a 0-1 value. Blend modes start with normal and expand later.

## Go To Camera

Projected layers should restore the camera snapshot that created them so users can reproject or edit from the same view.

Phase 2 implements go-to-camera for projected layers using the serialized capture camera. The Layers panel calls `sceneStore.requestCameraRestore`, and `CameraController` applies position, quaternion, near/far, zoom/fov, and OrbitControls target.

## Projected Preview State

Projected layers now store `generationId`, `captureId`, `objectId`, `imageUrl`, `camera`, `visible`, and `opacity`. The active visible projected layer is applied to the imported model through the projection shader. Visibility and opacity update the preview. Deleting the active layer removes the projected preview and restores the model display material.

## Current Multi-Layer Limit

The data model supports multiple projected layers, but the viewport preview only guarantees one active visible projected layer at a time. Full stacked projection compositing belongs to the UV bake and multi-layer rendering phases.

## Baked Layer State

Phase 3 adds baked state to layers:

- `isBaked`: the layer has produced a basecolor texture.
- `bakedTextureId`: links to `project.bakedTextures`.
- `bakedAt`: timestamp of the bake.
- `needsRebake`: opacity changed after baking, so the baked texture should be regenerated.

The Layers panel highlights the active projected layer and shows a BAKED or Re-bake badge. Clicking a projected layer makes it the active layer for preview and bake.

## Re-Bake Rule

Changing projected layer opacity after baking does not mutate the previous baked PNG. The UI marks the layer as needing re-bake. Users should click `Bake Active Layer` again to produce a new basecolor.
