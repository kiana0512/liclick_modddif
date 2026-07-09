# Export MVP Implementation

Phase 7 implements the first usable export workflow and the matching editor interaction polish.

## Dock Drag / Drop

Panel drag uses native HTML drag/drop:

- `WorkspacePanelHeader` starts drag only from the handle.
- `dragInteractionStore` records `activeDragType='panel'`.
- `WorkspacePanel` renders a lifted glow while dragged.
- `WorkspaceDock` is the only valid drop zone and highlights while hovered.
- `workspaceLayoutStore.reorderPanel()` snaps the panel into the left or right dock and persists order to localStorage.

The editor does not support arbitrary floating panels. Keeping panels docked prevents lost controls and keeps the Web3D viewport as the main work surface.

## Preventing Import Overlay Conflicts

Viewport file import checks `dragInteractionStore` before showing the drop overlay.

- Panel drag: overlay stays hidden.
- Model file drag: overlay appears for `.glb`, `.gltf`, `.fbx`, `.obj`, and `.stl`.
- Future asset drags can use `activeDragType='asset-file'` without triggering model import.

## Bottom Toolbar

`BottomToolDock` renders square icon buttons with hover tooltips:

- Select, Move, Rotate, Scale are active transform modes.
- Add Projected Layer is enabled only when a generation result exists.
- Undo and Redo are disabled and labelled as coming soon.

Paint and Eraser stay out of the main toolbar until the brush workflow is implemented.

## Export Modules

Export logic lives under `apps/web/src/engine/export/`:

- `exportGltf.ts`: Scene / Object GLB via `GLTFExporter`.
- `exportFbx.ts`: Scene / Object binary FBX via the local writer.
- `exportObj.ts`: Scene / Object OBJ via `OBJExporter`.
- `exportStl.ts`: Scene / Object STL via `STLExporter`.
- `exportTexture.ts`: baked BaseColor PNG and material normal map PNG.
- `exportSnapshot.ts`: viewport PNG from the preserved WebGL canvas.
- `exportTurntable.ts`: 5 second WebM turntable via `MediaRecorder` and `canvas.captureStream(30)`, with projected-layer shader uniforms resynced every frame so projected textures rotate with the model.
- `texturedExportUtils.ts`: shared export preparation for GLB/FBX/OBJ. It finds or bakes the current visible stack, creates a transparent BaseColor PNG for exported assets, and applies a `Liclick_BaseColor` material to cloned geometry.

`three-stdlib` is already part of the project and follows the Three.js ecosystem licensing expectations used by the app.

The local FBX writer now targets the Blender-stable FBX IO shape that 3ds Max accepts: large deterministic object ids, full model/material property templates, `Normal -> UV -> Material` layer order, indexed normal/UV tables, uncompressed tiny arrays such as `Materials [0]`, and a `100 / 3` model scale correction. This preserves the editor's normalized max dimension of 3 while exporting back to a DCC max dimension of 100.

## Supported Now

- Scene GLB / OBJ / STL.
- Scene FBX.
- Selected object GLB / FBX / OBJ / STL.
- Baked BaseColor PNG.
- Normal texture PNG when the imported material provides `normalMap`.
- Viewport PNG snapshot.
- Turntable WebM when the browser supports `MediaRecorder`.

## Still Unsupported

- Segments ColorID: disabled until real segmentation data exists.
- MP4 export: deferred; WebM is the browser-native MVP.
- Project package zip: server endpoint remains a stub.
- FBX compatibility should continue to be regression-tested in Blender and 3ds Max because the writer is local.

## Test Checklist

1. Drag Objects / Generate / References within the left dock and refresh; order should persist.
2. Drag Generate to the right dock, then Reset Layout; it should return to default.
3. Drag a panel over the viewport; the model import overlay should not appear.
4. Drag a `.glb` / `.fbx` file over the viewport; the model import overlay should appear.
5. Export Scene GLB, FBX, OBJ, and STL with a model loaded.
6. Select the imported object and export Object GLB, FBX, OBJ, and STL.
7. Bake a projected layer and export BaseColor PNG.
8. Export GLB/FBX/OBJ after baking and confirm the BaseColor material/texture is present.
9. Use Viewport PNG and Turntable WebM from the header Export menu.
10. Import an exported FBX into Blender and 3ds Max; confirm the mesh opens, the white-model fallback opens without media, UV/normal data is present, and the model max dimension matches the original Modddif-style scale.
