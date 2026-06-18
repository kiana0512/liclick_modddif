# Development Rules

Future Codex sessions must read these docs before modifying core behavior.

## Code

- Keep code modular.
- Do not put 3D engine logic inside UI panel components.
- Keep API keys out of source code.
- All core data must have TypeScript types.
- Placeholder features must include TODO comments or explicit stub naming.
- Visible but unfinished commands must be routed through `features/commandRegistry.ts` and show a clear "Coming soon" toast. Do not leave clickable UI with no response.
- New features must update relevant docs.
- Prefer existing repo patterns over new abstractions.

## UI

- Keep the visual identity Liclick-owned.
- Use lucide-react icons or locally authored SVGs.
- Do not use competitor logos, icons, images, CSS, or wording.
- Keep the editor dense, legible, and work-focused.
- Keep transform, save, import, and bake controls in the current dense editor style. Do not replace the workspace with a marketing page.

## 3D

- GLB/glTF is the normalized model path.
- Capture, projection, and bake logic belongs under `apps/web/src/engine`.
- Import normalization and transform actions belong under `apps/web/src/engine/scene`.
- Import normalization must transform the parent object, not mesh geometry.
- Store camera matrices for projected layers.
- Avoid one-off scripts for core workflows.

## API

- Use `services/liclickApiClient.ts` for real calls.
- Use mock services for local development.
- Keep request/response contracts typed.

## Persistence

- The local project file is `project.liclick.json`.
- Prefer File System Access workspace save when available.
- Keep JSON download/import fallback working for browsers without directory access.
- Persist relative asset paths and update `assetManifest` when writing workspace assets.
