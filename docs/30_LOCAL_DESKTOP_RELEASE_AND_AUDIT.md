# Local Desktop Release And Code Audit

This note records the current Windows desktop release flow, the editor UX changes, and the code audit status for this build.

## Windows Desktop Build

The Windows installer keeps the browser as the main UI and starts the app through a visible terminal.

- Installer script: `corepack pnpm package:windows`
- Output: `dist-installer/Liclick 3D Texture Setup.exe`
- Installer engine: Inno Setup 6
- Installed app ports: backend `4617`, frontend `5673`
- Development ports remain unchanged: backend `4517`, frontend `5173`

Runtime data is kept under:

```text
%LocalAppData%\Liclick 3D Texture\
  runtime\
  workspace\
  logs\
```

The installed launcher copies runtime files into `%LocalAppData%` before installing dependencies or building. This avoids writing package dependencies into `Program Files` during daily use.

## First Run Behavior

The desktop launcher prints full logs in the visible terminal. On first run it may install dependencies and build the app, then opens:

```text
http://127.0.0.1:5673
```

Users should keep the terminal open while using the app. Closing the terminal stops the local backend and frontend services.

## Current Editor UX

- The MVP capture frame is a transient viewport overlay. It appears while the camera is being moved and fades out after a short delay.
- Files can be dropped on the main viewport:
  - model files import as objects
  - image files import as reference images for the selected object
- Multiple models can be imported into one project. The editor keeps one active model in texture mode, selected from the Objects panel.
- Reference images and layers are scoped to the selected object. Older unscoped project data remains visible for compatibility.
- Liclick image generation and Texture Map generation use separate prompts.
- Liclick image generation has a stop button. Stopping marks the local job as cancelled, unlocks the UI, and tells the local server to stop tracking that job.

## Code Audit Summary

Low-risk cleanup completed in this pass:

- Shared generation upsert/failure handling in `GeneratePanel` to reduce duplicated state writes.
- Consolidated viewport drag payload detection so drag events scan file lists once.
- Kept texture mode rendering focused on the currently selected imported model instead of rendering every imported model.
- Kept generated layers, reference images, and new empty layers object-scoped.

Build checks for this release should run:

```text
corepack pnpm -r typecheck
corepack pnpm -r lint
corepack pnpm -r build
corepack pnpm package:windows
```

## Known Risk Areas

- `GeneratePanel` and `EditorPage` are still large orchestration components. Future cleanup should split generation job state, reference import, project restore, and bake orchestration into smaller hooks or services.
- Projected-layer preview and UV bake remain the most performance-sensitive path. Avoid adding React state updates inside per-frame or per-fragment logic.
- The stop button cancels local tracking immediately. If a Liclick task has already been submitted to Atlas, the remote task may still finish server-side, but the local UI no longer waits for it or applies it.
- Legacy unscoped references/layers remain visible for compatibility. New project data should always write `objectId`.
- Large Vite chunk warnings are currently known and non-blocking, but code splitting should be considered after the texture workflow stabilizes.
