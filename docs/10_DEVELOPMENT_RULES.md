# Development Rules

Future Codex sessions must read these docs before modifying core behavior.

## Code

- Keep code modular.
- Do not put 3D engine logic inside UI panel components.
- Keep API keys out of source code.
- All core data must have TypeScript types.
- Placeholder features must include TODO comments or explicit stub naming.
- Visible but unfinished commands should be disabled with clear `title` tooltips or isolated in mode-specific placeholder panels. If a placeholder must stay clickable, keep the handler local to the owning component and dedupe any "Coming soon" toast.
- Do not keep disabled placeholder menu items in production panels if they do not help the current workflow.
- New features must update relevant docs.
- Prefer existing repo patterns over new abstractions.
- User-visible frontend strings must go through `stores/i18nStore.ts` unless they are model/API prompts, file-format labels, or debug-only console messages.

## UI

- Keep the visual identity Liclick-owned.
- Use lucide-react icons or locally authored SVGs.
- Do not use competitor logos, icons, images, CSS, or wording.
- Keep the editor dense, legible, and work-focused.
- Keep transform, save, import, and bake controls in the current dense editor style. Do not replace the workspace with a marketing page.
- Keep the editor viewport-first. Feature modules should live in `components/workspace` dock panels rather than fixed full-height sidebars.
- Panel content should stay compact; use collapsed panels for secondary workflows.

## 3D

- GLB/glTF is the normalized model path.
- Capture, projection, and bake logic belongs under `apps/web/src/engine`.
- Import normalization and transform actions belong under `apps/web/src/engine/scene`.
- Import normalization must transform the parent object, not mesh geometry.
- Store camera matrices for projected layers.
- Keep selected bake quality explicit. Performance fixes should preserve requested resolution unless the user chooses otherwise.
- Avoid one-off scripts for core workflows.

## API

- Use `services/liclickApiClient.ts` for real calls.
- Use explicit development fallbacks only when they are still wired into the app. Remove mock services and seed data once they no longer have product callers.
- Keep request/response contracts typed.

## Persistence

- The local project file is `project.liclick.json`.
- The primary project flow is the local workspace server in `apps/server`.
- Do not write absolute user-machine paths into project documents; store project-relative asset paths.
- Prefer File System Access workspace save when available.
- Keep JSON download/import fallback working for browsers without directory access.
- Persist relative asset paths and update `assetManifest` when writing workspace assets.

## Workspace Layout

- Use `components/workspace/workspaceLayoutStore.ts` for panel collapse, visibility, dock side, order, mode, and localStorage persistence.
- Do not hand-roll per-panel collapse state unless it is purely internal to that panel body.
- Do not implement drag/drop by mutating panel order ad hoc; use `movePanel(panelId, dock, order)`.
- For drag/drop dock sorting, use `reorderPanel(panelId, dock, beforePanelId)` so order is normalized and persisted.
- Texture mode should remain the default working mode. Normal, Segments, and Export can show placeholder panels until their engine features ship.
