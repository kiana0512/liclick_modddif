# Windows Release Audit — Build 2026.07.17.1452

Date: 2026-07-17

## Release Scope

This build closes the unsafe projected-layer overflow path and fixes single-model workspace camera initialization.

- Deleted the UV-space fast projected-preview compositor. It could not guarantee the same result as direct projection on multi-mesh or overlapping-UV assets and is no longer shipped.
- Projected-layer eyes are now guarded before state commit using the active device's WebGL texture-sampler budget. An over-budget eye stays closed and the user is asked to close another projected layer or merge visible projections into a UV layer.
- Existing over-budget stacks are reduced back to a valid stack instead of being rendered with missing, black, striped, or partially substituted projections.
- Texture, normal, and segment workspaces now frame the selected model directly. Scene/export mode continues to frame the whole scene.
- A fresh fit or serialized-camera restore rebuilds controls from a deterministic world-up basis, preventing a previous pole-crossing rotation or scene placement from contaminating the selected-model view.

The camera centering and normal-direction behavior were also checked in the live editor during this release pass.

## Code Audit

The projected-layer visibility path was reviewed from layer-store mutation through sampler-budget calculation and material application. Visibility is rejected before the layer store accepts an invalid stack, and the renderer keeps the last valid material if a legacy/HMR state is already over budget. The deleted compositor has no remaining source reference.

The camera path was reviewed across workspace switching, selected-object changes, full-scene framing, serialized capture restore, perspective/orthographic cameras, and OrbitControls target initialization. Single-object workspaces now calculate both camera target and distance from the selected model bounds instead of inheriting the whole-scene distance and translating only the target.

No blocking correctness or security finding remained after this review.

## Verification

Passed checks:

- full workspace TypeScript typecheck;
- full workspace ESLint;
- desktop shell, preload, renderer, Windows launcher, and static web-server JavaScript syntax checks;
- full Server/Web production build;
- local workspace-server smoke: auth, project creation, upload, CORS, HEAD, and workspace isolation;
- OAuth smoke through the mock IDaaS boundary;
- Photoshop bridge smoke, including stable PSD reuse and per-layer isolation;
- Windows packaging production rebuild;
- source-free installer staging guard;
- required Server/Web runtime, Electron shell, portable Node, Node MSI, CEP extension, and UXP package presence.

Known non-blocking release notes:

- Vite still reports the existing editor chunk-size and mixed static/dynamic import warnings.
- `corepack enable` cannot write to the machine-wide Node installation without elevation; packaging falls back to `corepack pnpm`.
- The dependency refresh could not query the public pnpm metadata endpoint in the restricted environment, but the locked local dependency tree remained complete and the subsequent Prisma generation, Server/Web rebuild, smoke tests, staging checks, and installer compilation all passed.
- Node emits the upstream `DEP0169` warning from package-manager internals.
- The installer is not Authenticode-signed.
- The installer artifact was compiled and structurally audited; it was not launched or installed over the user's current installation during this pass.

## Installer Artifact

- File: `dist-installer/Liclick 3D Texture Setup 2026.07.17.1452.exe`
- Package version: `0.1.3`
- Shell Build: `2026.07.17.1452`
- Size: `140,683,037` bytes (`134.17 MiB`)
- SHA-256: `2BECB8F708680F4638F4852379E13A46E4A2B8D35AC73903E71F3A6F2A434CDD`
- Inno Setup: `6.7.2`
- Authenticode: not signed.

Installer staging contains zero forbidden source roots and zero forbidden source/debug/credential/PSD files outside the bundled third-party Node/Electron runtimes. All required packaged runtime entries were present.
