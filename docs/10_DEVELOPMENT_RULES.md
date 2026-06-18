# Development Rules

Future Codex sessions must read these docs before modifying core behavior.

## Code

- Keep code modular.
- Do not put 3D engine logic inside UI panel components.
- Keep API keys out of source code.
- All core data must have TypeScript types.
- Placeholder features must include TODO comments or explicit stub naming.
- New features must update relevant docs.
- Prefer existing repo patterns over new abstractions.

## UI

- Keep the visual identity Liclick-owned.
- Use lucide-react icons or locally authored SVGs.
- Do not use competitor logos, icons, images, CSS, or wording.
- Keep the editor dense, legible, and work-focused.

## 3D

- GLB/glTF is the normalized model path.
- Capture, projection, and bake logic belongs under `apps/web/src/engine`.
- Store camera matrices for projected layers.
- Avoid one-off scripts for core workflows.

## API

- Use `services/liclickApiClient.ts` for real calls.
- Use mock services for local development.
- Keep request/response contracts typed.
