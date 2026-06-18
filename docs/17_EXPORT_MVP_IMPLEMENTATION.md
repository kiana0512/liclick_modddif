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
- `exportObj.ts`: Scene / Object OBJ via `OBJExporter`.
- `exportStl.ts`: Scene / Object STL via `STLExporter`.
- `exportTexture.ts`: baked BaseColor PNG and material normal map PNG.
- `exportSnapshot.ts`: viewport PNG from the preserved WebGL canvas.
- `exportTurntable.ts`: 5 second WebM turntable via `MediaRecorder` and `canvas.captureStream(30)`.

`three-stdlib` is already part of the project and follows the Three.js ecosystem licensing expectations used by the app.

## Supported Now

- Scene GLB / OBJ / STL.
- Selected object GLB / OBJ / STL.
- Baked BaseColor PNG.
- Normal texture PNG when the imported material provides `normalMap`.
- Viewport PNG snapshot.
- Turntable WebM when the browser supports `MediaRecorder`.

## Still Unsupported

- FBX export: disabled as PRO / coming soon because Three.js does not provide a stable official FBX exporter.
- Segments ColorID: disabled until real segmentation data exists.
- MP4 export: deferred; WebM is the browser-native MVP.
- Project package zip: server endpoint remains a stub.

## Test Checklist

1. Drag Objects / Generate / References within the left dock and refresh; order should persist.
2. Drag Generate to the right dock, then Reset Layout; it should return to default.
3. Drag a panel over the viewport; the model import overlay should not appear.
4. Drag a `.glb` / `.fbx` file over the viewport; the model import overlay should appear.
5. Export Scene GLB, OBJ, and STL with a model loaded.
6. Select the imported object and export Object GLB, OBJ, and STL.
7. Bake a projected layer and export BaseColor PNG.
8. Use Viewport PNG and Turntable WebM from the header Export menu.
