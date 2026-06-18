# Import, Transform, And Workspace Save

Phase 4 makes the editor safer to use before larger AI and export work lands.

## Import Normalization

Imported models are normalized by transforming the imported parent group:

- Compute the original source bounding box.
- Scale the largest dimension toward a practical editor size.
- Center the model on XZ.
- Ground the bottom of the current bounds to Y=0 when Ground is enabled.
- Auto-fit the camera when Auto Fit is enabled.

The source mesh geometry, vertex buffers, UVs, and child node hierarchy must not be rewritten. The app records `originalBoundingBox`, `boundingBox`, `importNormalizationTransform`, and `userTransform` on the `SceneObject`.

FBX and OBJ remain experimental. Large or tiny original bounds should produce import warnings rather than silently hiding the model off camera.

## Transform Controls

The bottom toolbar controls object transform mode:

- Select: no gizmo.
- Move: translate the selected imported model.
- Rotate: rotate the selected imported model.
- Scale: scale the selected imported model.

OrbitControls are disabled while the gizmo is dragged. Object transforms are mirrored into `sceneStore` and `projectStore` so Save Project can persist the current placement.

The Object Transform panel provides:

- Reset Transform: restore the import normalization transform.
- Center: recenter the current object on XZ.
- Ground: move the current object so the current bottom is Y=0.
- Fit Camera: frame the object without changing its transform.

## Workspace Save / Load

Save Project reuses the current workspace directory handle when available. Save As asks for a new directory. Load Project reads a `.liclick.json` file.

Preferred File System Access layout:

```text
project.liclick.json
assets/
  models/
  references/
  captures/
  generations/
  layers/
  baked/
  thumbnails/
```

The save service writes data URLs and blob URLs into the closest matching asset folder, replaces saved URLs with relative paths, and updates `assetManifest`.

Fallback behavior:

- Browsers without File System Access download `project.liclick.json`.
- Load falls back to the hidden file input.
- Missing relative assets should warn the user and keep metadata loaded.

## Command Availability

Implemented MVP commands:

- Model import.
- Capture current view.
- Mock texture generation.
- Add projected layer.
- UV bake active layer.
- Download basecolor.
- Apply baked texture.
- Local Save / Save As / Load.
- Object transform controls.

Visible coming-soon commands must use `features/commandRegistry.ts`. Prefer disabled controls with `title` tooltips. Use lightweight deduped toast only when a placeholder must remain clickable:

- Paint.
- Eraser.
- Quick Mask.
- Segments.
- Multiview.
- Normal generation.
- GLB export.
- Layer rename.
- Undo / Redo.
- Manual Add Layer.
- New Project / New Folder / folder management.
- Reference upload.
- DCC connectors.

## Normal Preview

Normal display mode uses `MeshNormalMaterial`. It is a viewport diagnostic mode only. The UI must show that its colors visualize surface normals and are not the final texture.

Phase 5 also adds a top-level Normal workspace mode. It switches the viewport to normal display and shows Normal Visualizer / Normal Generation panels. Normal generation remains a placeholder.
