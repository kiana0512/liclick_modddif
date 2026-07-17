# Windows Release Audit — Build 2026.07.17.1158

Date: 2026-07-17

## Release Scope

This build contains the persistent one-PSD-per-LI3D-layer Photoshop workflow, complete layer-menu icons, duplicate Photoshop session retirement, and the Windows development-startup repair.

The Photoshop bridge now uses `(projectId, layerId)` as its stable identity. Reopening a projected or UV layer reuses the selected recovery PSD; a new layer ID creates a new PSD. Older duplicate sessions are marked closed so they are not automatically reopened, while their folders and PSD files remain available for recovery.

## Development Startup Repair

The root development launcher and server watcher no longer use `shell: true`, removing Node's `DEP0190` warning and avoiding shell-concatenated child-process arguments. Windows starts Corepack through an explicit `cmd.exe` command with fixed arguments, while TypeScript watchers run through `process.execPath` and the resolved TypeScript CLI.

Before stopping an existing development server, `scripts/dev-fixed.mjs` now validates the configured ports and verifies that TypeScript and Vite are installed. An incomplete dependency tree produces one actionable install command instead of the misleading `vite` or `tsc is not recognized` errors.

Verified development endpoints after the repair:

- Web: `http://127.0.0.1:5173/` — HTTP 200.
- Workspace API: `http://127.0.0.1:4517/api/health` — healthy.
- Server TypeScript watcher — zero errors.
- Node `DEP0190` warning — absent.

## Cleanup And Data Boundary

Removed before release:

- stale Web and Server build outputs;
- TypeScript build-info files;
- the previous installer and installer staging directory;
- launcher, CEP, renderer, server-runtime, and WebSocket-copy smoke directories;
- the generated Photoshop plugin package, root contact sheet, old workspace-server logs, and empty temporary directory.

The cached Node ZIP and MSI were retained for offline packaging. Dependency directories were restored after the packaging prepare step. The local `workspace/` tree (approximately 6.9 GB), Photoshop sessions, projects, generated textures, `secrets/`, and `.codex/` state were not deleted.

Git boundary checks found no tracked files under `workspace/` and no tracked PSD/PSB files. Installer staging contained zero forbidden source roots and zero forbidden source, map, environment, credential, PSD, or PSB files.

## Verification

Passed checks:

- full workspace TypeScript typecheck;
- full workspace ESLint;
- desktop, development-launcher, server-watcher, CEP panel, and installer helper JavaScript syntax checks;
- production Server and Web builds;
- OAuth smoke;
- local workspace-server smoke;
- Photoshop bridge smoke, including PSD reuse, different-layer isolation, and concurrent request deduplication;
- source-free installer staging guard;
- required packaged runtime files, Electron shell, portable Node, CEP extension, and UXP package presence;
- live development Web and API health checks after packaging.

Vite still reports the existing non-blocking editor chunk-size warning. Physical Photoshop layer-history behavior and installer UI interaction remain manual release checks.

## Installer Artifact

- File: `dist-installer/Liclick 3D Texture Setup 2026.07.17.1158.exe`
- Package version: `0.1.3`
- Shell Build: `2026.07.17.1158`
- Size: `140,693,202` bytes (`134.18 MiB`)
- SHA-256: `7E063573B37EF531B67018F87F44EAAEF1866FBD002BFA40716B873CE174A772`
- Inno Setup: `6.7.2`
- Authenticode: not signed.
