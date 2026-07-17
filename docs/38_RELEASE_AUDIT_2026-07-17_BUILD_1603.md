# Windows Release Audit — Build 2026.07.17.1603

Date: 2026-07-17

## Release Scope

This build completes the local-repaint export and UV-edge hardening pass on top of Build 1452.

- Visible local-repaint merge layers now participate in Scene/Object model export and BaseColor download. Runtime canvas URLs are encoded directly as PNG instead of being passed to `fetch`, eliminating the `Failed to fetch` export failure.
- GPU UV padding rejects weak low-alpha color samples before unpremultiplication, preventing 8-bit quantization from becoming opaque pastel/rainbow fragments.
- Newly dilated local-repaint texels use premultiplied feathered alpha, blending into the underlying texture instead of creating a fully opaque sticker outline.
- The local-repaint bake remains a 512 px, one-pass GPU operation. Full-canvas CPU seam reconciliation and multi-pixel dilation remain disabled to preserve interaction responsiveness.
- Ordinary projected-layer and UV-bake padding retains its historical opaque-padding behavior. The feather parameter is opt-in and is set only by the local-repaint commit path.
- The button-1 selection remains the hard permission boundary for button 3, including restored masks and dirty-rectangle updates.
- Build 1452 WebGL sampler guards, unsafe fast-compositor removal, selected-model camera framing, and deterministic world-up restoration remain included.

## Code Audit

The review covered the local-repaint projection-to-UV handoff, GPU transparent render target, dilation shader, premultiplied/straight-alpha readback boundary, persistent merge-canvas update, visible UV-layer export composition, project asset persistence, deleted fast-compositor references, sampler-budget visibility guard, and selected-model camera fit path.

One compatibility issue was found during the release audit: the first feather implementation derived default dilation alpha from neighbouring coverage, which could subtly change ordinary UV-bake padding. The shader was corrected before packaging so the default value exactly preserves opaque padding; only local repaint opts into reduced edge alpha.

No remaining blocking correctness or security finding was found in the reviewed paths. The removed `ProjectedLayerPreviewCompositor` has no remaining runtime reference.

## Verification

Passed checks:

- full workspace ESLint;
- full workspace TypeScript typecheck;
- desktop main, preload, renderer, Windows launcher, and static web-server JavaScript syntax checks;
- full Server/Web production build;
- local workspace-server smoke: auth, project creation, upload, CORS, HEAD, and workspace isolation;
- OAuth smoke through the mock IDaaS boundary;
- Photoshop bridge smoke, including stable PSD reuse and per-layer isolation;
- Windows packaging production rebuild and Prisma generation;
- source-free installer staging guard;
- required Server/Web runtime, Electron shell, portable Node, Node MSI, CEP extension, and UXP package presence;
- packaged shell-build verification.

User runtime feedback confirmed that the rainbow fringe was removed before the final alpha-feather adjustment. The final reduced-alpha edge is included in this build but still requires visual confirmation on the user's target model because the automated browser controller was unavailable during this editor pass.

Known non-blocking release notes:

- Vite still reports the existing editor chunk-size and mixed static/dynamic import warnings.
- `corepack enable` cannot write to the machine-wide Node installation without elevation; packaging continued through `corepack pnpm`.
- The restricted environment could not query the public pnpm metadata endpoint. The locked local dependency tree remained complete, and Prisma generation, production builds, smoke tests, staging checks, and installer compilation all passed afterward.
- Node emits the upstream `DEP0169` warning from package-manager internals.
- The installer is not Authenticode-signed.
- The installer artifact was compiled and structurally audited; it was not installed over the user's current installation during this pass.

## Installer Artifact

- File: `dist-installer/Liclick 3D Texture Setup 2026.07.17.1603.exe`
- Package version: `0.1.3`
- Shell Build: `2026.07.17.1603`
- Size: `140,676,478` bytes (`134.16 MiB`)
- SHA-256: `6561C1DC750FEF8201A9A03C520C60229DDEBB6DB272C23A4EFD64A56338CFFE`
- Inno Setup: `6.7.2`
- Authenticode: not signed.

Installer staging contains zero forbidden source roots and zero forbidden source/debug/credential/PSD files outside the bundled third-party Node/Electron runtimes. All required packaged runtime entries were present.
