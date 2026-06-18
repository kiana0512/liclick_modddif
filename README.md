# Liclick 3D Texture

Liclick 3D Texture is the foundation for a Web AI 3D Texture Studio. The current MVP creates a long-lived React + Three.js workspace with Projects, Editor, Web3D viewport, real local model import, viewport capture, mock generation, projected layers, UV bake, transform controls, and local workspace persistence.

## Install

```bash
pnpm install
```

## Run

```bash
pnpm dev
```

The web app runs from `apps/web` through the root workspace script.

## Tech Stack

- React, Vite, TypeScript
- Three.js, React Three Fiber, Drei
- Zustand and TanStack Query
- Tailwind CSS with Radix-style local UI primitives
- lucide-react icons
- zod, uuid
- pnpm workspace

## Current Status

- Projects home page with mock project cards.
- Editor workspace shell with toolbar, left panels, viewport, right panels, and bottom tools.
- Web3D viewport renders a default primitive model until a real model is imported.
- Import Model supports local `.glb` and `.gltf`, with experimental `.fbx` and `.obj`.
- Imported models are mounted as real Three.js groups, centered on XZ, grounded to Y=0, scaled to a practical editor size, measured, and shown in Objects.
- Imported model metadata records original bounding box, normalization transform, user transform, mesh count, UV status, and import warnings.
- Move / Rotate / Scale controls work for the selected imported model, with Reset, Center, Ground, and Fit Camera actions.
- Viewport capture now renders real color, mask, normal, and grayscale depth PNG data URLs.
- Generate still uses the mock service, but generation records are linked to a real capture id.
- Add as Projected Layer applies a real shader-based projection preview to the imported model.
- Layer visibility, opacity, delete, and go-to-camera work for projected layer preview.
- Save Project / Save As / Load Project now target a local workspace folder through the File System Access API when available, writing `project.liclick.json` and asset folders. Unsupported browsers fall back to JSON download/import.
- Paint, Eraser, Quick Mask, Segments, Multiview, Normal generation, GLB export, and DCC connectors are explicitly marked as coming soon instead of silently doing nothing.

## Phase 2 Workflow

1. Open the Editor and click `Import Model`, or drag a model file into the viewport.
2. Use `Capture Current View` to create color, mask, depth, and normal captures from the active camera.
3. Use `Generate Image`; if no capture exists, the app auto-captures first.
4. Click `Add as Projected Layer` to preview the generated image projected onto the model.
5. Use the Layers panel to toggle visibility, adjust opacity, delete, or return to the capture camera.
6. Use `Bake Active Layer` in Layer Adjustments to write the active projected layer into a UV basecolor texture.
7. Use `Download BaseColor` to save `basecolor.png`, or `Apply Baked Texture` to reapply the latest baked texture.
8. Use `Save Project` / `Save As...` / `Load Project` for `project.liclick.json` workspace persistence. In unsupported browsers, Save downloads JSON.

## Import And Workspace MVP

Phase 4 adds model normalization, object transform controls, and local workspace save/load.

- Import settings expose Normalize, Ground, and Auto Fit toggles.
- Normalization does not mutate mesh geometry. It applies a parent group transform and records both original and normalized bounds.
- Transform controls use Move, Rotate, and Scale modes from the bottom toolbar. OrbitControls are disabled while the gizmo is dragged.
- The right panel shows format, mesh count, UV status, bounding size, normalized scale, and live transform values.
- `project.liclick.json` is the current project file name. Relative asset paths are used for saved data URLs when a workspace directory is selected.
- Normal viewport mode is a debug preview: colors visualize surface normals, not the final texture.

## UV Bake MVP

Phase 3 adds a CPU UV rasterizer that bakes the active projected layer into a single basecolor PNG. The bake reads the imported mesh position, UV, normal, and index buffers, rasterizes each UV triangle, projects every covered texel back through the saved capture camera, samples the generated image, applies opacity, dilates seams, and immediately applies the result as a material map.

Test flow:

1. Import a UV-mapped GLB/GLTF, or experimental FBX/OBJ.
2. Capture current view.
3. Generate image.
4. Add as Projected Layer.
5. Keep or select that projected layer in Layers.
6. Click `Bake Active Layer`.
7. Switch to PBR or Flat and toggle the projected layer off; the baked texture should remain visible.
8. Click `Download BaseColor`.

## Current Limits

- GLB / glTF are the primary formats. FBX / OBJ are experimental.
- The MVP is optimized for one imported object and one active projected layer preview.
- Projected preview is shader-based and does not yet do depth-aware multi-layer compositing.
- Depth capture is grayscale viewport depth, not a calibrated linear depth asset.
- File System Access save requires a Chromium-style browser and user-selected directory permission. Other browsers use JSON download fallback.
- UV bake supports one active projected layer, one object, one UV channel, and basecolor only.
- 4K bake is available as experimental and may be slow in the browser.
- Export buttons are present but GLB/GLTF export is still coming soon.

## Development Rules

Read `docs/10_DEVELOPMENT_RULES.md` before adding features. New functionality should update the relevant docs, keep core data typed, keep engine logic outside UI components, and avoid hard-coded API keys.
