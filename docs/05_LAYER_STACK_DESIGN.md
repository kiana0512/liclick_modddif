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

Layer metadata lives in `project.json`. Image assets should be stored as files or object storage blobs referenced by URL.

## Blend, Opacity, Visibility

Composition order is determined by `order`. Invisible layers are skipped. Opacity is a 0-1 value. Blend modes start with normal and expand later.

## Go To Camera

Projected layers should restore the camera snapshot that created them so users can reproject or edit from the same view.
