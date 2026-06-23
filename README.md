# Liclick 3D Texture

Liclick 3D Texture is the foundation for a Web AI 3D Texture Studio. The current MVP creates a long-lived React + Three.js workspace with Projects, Editor, Web3D viewport, floating dock panels, real local model import, viewport capture, mock generation, projected layers, UV bake, transform controls, and local workspace persistence.

## Install

```bash
pnpm install
```

## Run

```bash
pnpm dev
```

The root dev script starts both the local workspace server and the web app. If another Liclick workspace server is already running on `4517`, the server dev process now reuses it instead of failing the whole dev script.

```bash
pnpm dev:web
pnpm dev:server
pnpm workspace:up
```

The local workspace server runs on `127.0.0.1:4517` by default and stores projects in `workspace/`.
`pnpm workspace:up` starts the workspace server as a background Windows process for longer local sessions. The web app keeps the mock project gallery visible when the server is offline.

For Linux, Docker, or long-running A100 deployment, build first and run the compiled server through a process manager. See `docs/26_PROJECT_STRUCTURE_AND_DEPLOYMENT_AUDIT.md`.

## Auth And Liclick Login

The Projects homepage and local editor can be viewed without login. Workspace operations and AI features that call authenticated APIs require the Liclick session. The visible `飞书登录` entry calls the server, the server starts the local `@lilith/atlas-skillhub` gateway login, and then stores only its own httpOnly Liclick session cookie.

`dev-mock` is only a deliberate development fallback. The current real login path does not require Liclick to register a localhost Service URL in IDaaS. It relies on the local Atlas gateway runtime used by Liclick services. If Atlas needs authorization, it opens the company IDaaS / Feishu flow itself and writes the local Atlas token cache.

```bash
AUTH_MODE=feishu-oauth
LICLICK_ENABLE_ATLAS_LOCAL_LOGIN=true
IDAAS_JWT_SSO_ENABLED=false
```

The frontend never receives Atlas tokens, Feishu tokens, API keys, or session token values. User name and email are decoded server-side from the Atlas gateway token claims and copied into the local user session. Avatar currently falls back to a deterministic local avatar when the token does not include a profile image URL.

`GET /api/liclick/status` verifies whether the logged-in user can reach the Liclick API through Atlas and lists the discovered Liclick tools.

Database setup:

```bash
corepack pnpm db:generate
corepack pnpm db:push
```

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
- Project home sidebar now opens Projects, Folders, Assets, and Settings instead of firing placeholder toasts.
- Settings includes a Chinese / English language switch; Chinese is the default UX language.
- Editor workspace shell with a full-height viewport, floating dock panels, overlay icon toolbars, synchronized 3D view cube, and normal / compact dock density.
- Texture workspace now follows the Modddif-style spatial model more closely: project/function controls on the left, ViewCube reserved on the right, left/right docks lowered below the top controls, and fully collapsed docks tucked to the bottom.
- Editor panels default to a quieter contextual layout: Objects and Viewport stay available, while Generate, References, Layers, and Transform panels expand when their workflow needs them.
- Local workspace server for project listing, creation, folders, autosave, project files, and asset files.
- `pnpm dev` starts the web app and local workspace server together. `pnpm dev:web` and `pnpm dev:server` remain available for isolated debugging.
- Web3D viewport renders a default primitive model until a real model is imported.
- Import Model supports local `.glb` and `.gltf`, with experimental `.fbx` and `.obj`.
- Imported models are mounted as real Three.js groups, centered on XZ, grounded to Y=0, scaled to a practical editor size, measured, and shown in Objects.
- Imported model metadata records original bounding box, normalization transform, user transform, mesh count, UV status, and import warnings.
- Move / Rotate / Scale controls work for the selected imported model, with Reset, Center, Ground, and Fit Camera actions.
- Viewport capture now renders real color, mask, normal, and grayscale depth PNG data URLs.
- Generate still uses the mock service, but generation records are linked to a real capture id.
- Add as Projected Layer applies a real shader-based projection preview to the imported model.
- Projected preview now rejects out-of-frustum, backface, masked, and approximate depth-failed fragments instead of spreading the image over the full model.
- Layer visibility, opacity, delete, and go-to-camera work for projected layer preview.
- Save Project / Save As / Load Project now target a local workspace folder through the File System Access API when available, writing `project.liclick.json` and asset folders. Unsupported browsers fall back to JSON download/import.
- Local-server projects autosave to `workspace/projects/<projectSlug>/project.liclick.json`; browser-only save remains as fallback.
- Saved local-server projects resolve model asset paths back into viewport-loadable URLs, so imported FBX / GLB models restore after browser refresh.
- Project thumbnails are captured from the WebGL viewport and shown on the Projects page when saved.
- Export now supports Scene GLB / OBJ / STL, selected Object GLB / OBJ / STL, baked BaseColor PNG, normal-map PNG when the model provides one, viewport PNG snapshot, and 5 second WebM turntable recording.
- Paint, Eraser, Quick Mask, Segments, Multiview, Normal generation, FBX export, and DCC connectors are either disabled with a tooltip or shown as mode-specific coming-soon panels. Repeated coming-soon toast noise is deduped.

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

## Workspace UI Refactor

Phase 5 changes the editor from a fixed three-column layout to floating dock panels over a large Web3D viewport.

- Texture mode defaults to Objects, Generate, References, Viewport, Layers, Layer Adjustments, and Object Transform.
- References, Layer Adjustments, and Object Transform can start collapsed and expand when their state becomes relevant.
- Normal, Segments, and Export switch to their own lightweight dock panels instead of firing disruptive toasts.
- Panel collapse, visibility, dock side, order, and current mode persist to localStorage.
- Panel headers can be dragged only from the handle to reorder panels or move them between left and right docks. Dragged panels glow, valid docks highlight, and `Reset Layout` restores defaults.
- Internal panel drags are tracked separately from file drags so dragging a panel over the viewport does not trigger the model import overlay.

## Project Workspace MVP

Phase 6 adds project-system behavior:

- `apps/server` provides local workspace APIs without external runtime dependencies.
- `New Project` writes a real project directory and opens it.
- `New Folder` uses an in-app modal, writes `folders.json`, and avoids native browser prompts.
- Workspace health checks use short timeouts so a stopped server does not make the UI feel stuck.
- Folder writes are queued and JSON writes are atomic to reduce local-server race conditions under concurrent use.
- Dirty local-server projects autosave after 1.5 seconds.
- Imported model files and data URL assets are saved into project-relative `assets/` paths where possible.
- `.liclick3d` is documented as the future portable zip package; current export package is a stub.

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
- UV bake uses the same frustum/mask/depth/backface visibility gates as projected preview, with grayscale depth as an MVP approximation.
- 4K bake is available as experimental and may be slow in the browser.
- FBX export, Segments ColorID, MP4, and portable project package zip are still coming soon.

## Development Rules

Read `docs/10_DEVELOPMENT_RULES.md` before adding features. New functionality should update the relevant docs, keep core data typed, keep engine logic outside UI components, and avoid hard-coded API keys.
