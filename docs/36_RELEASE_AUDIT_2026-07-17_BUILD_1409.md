# Windows Release Audit — Build 2026.07.17.1409

Date: 2026-07-17

## Release Scope

This build contains the local-repaint responsiveness, seam-padding, selection-boundary, and persistent-lighting fixes added after build `2026.07.17.1158`.

- Button 3 loads the selection mask associated with the local-repaint generation and treats it as a hard permission boundary.
- The mask is converted to a small alpha canvas once when apply mode opens. Pointer starts use constant-time alpha lookups; live brush updates clip only the current dirty rectangle.
- Restored live repaint masks are clipped again before reuse, preventing legacy or stale mask content from escaping the current allowed region.
- Local repaint UV commits remain at 512 px and use one GPU padding pass. Full-canvas CPU seam reconciliation and multi-pixel dilation are disabled on this interactive path.
- The one-pixel padding remains available outside UV-island borders so bilinear texture sampling does not reveal transparent triangle/UV seams.
- The projected live preview keeps captured display color; the persistent UV merge layer participates in ordinary material lighting to avoid a flat pale veil.

## Code Audit

The changed viewport/rendering path was reviewed for state identity, asynchronous cancellation, mask restoration, pointer-time work, UV bake settings, persistence behavior, and source-free packaging boundaries.

No blocking correctness or security finding remained after the review. The apply source identity now includes `allowedMaskUrl`, so a new generation mask cannot accidentally reuse an older composite. Failed source/mask loading fails closed and leaves the apply composite unavailable.

Performance-sensitive work remains bounded:

- one low-resolution mask conversion when apply mode opens;
- constant-time allowed-mask lookup at pointer start/stamps;
- dirty-rectangle canvas compositing during a stroke;
- one 512 px GPU UV padding pass after the stroke;
- no pointer-time full-canvas readback and no CPU UV seam reconciliation.

## Verification

Passed checks:

- full workspace TypeScript typecheck;
- full workspace ESLint;
- desktop launcher, development launcher, server watcher, static web server, CEP panel, UXP panel, and installer helper JavaScript syntax checks;
- full Server/Web production build;
- local workspace-server smoke (auth, project creation, upload, CORS, HEAD, and workspace isolation);
- OAuth smoke through the mock IDaaS boundary;
- Photoshop bridge smoke, including stable PSD reuse and per-layer isolation;
- Windows packaging production rebuild;
- source-free installer staging guard;
- required Server/Web runtime, Electron shell, portable Node, Node MSI, CEP extension, and UXP package presence.

Known non-blocking release notes:

- Vite still reports the existing editor chunk-size and mixed static/dynamic import warnings.
- `corepack enable` cannot write to the machine-wide Node installation without elevation; the packaging script successfully falls back to `corepack pnpm`.
- The dependency installer emits Node's upstream `DEP0169` warning from package-manager internals.
- The installer is not Authenticode-signed.
- Physical UI validation of the newest local-repaint seam and mask behavior remains a manual model/Photoshop check; old baked merge layers must be removed before comparing the new UV output.

## Installer Artifact

- File: `dist-installer/Liclick 3D Texture Setup 2026.07.17.1409.exe`
- Package version: `0.1.3`
- Shell Build: `2026.07.17.1409`
- Size: `140,701,771` bytes (`134.18 MiB`)
- SHA-256: `F96046EA1CD91E80F72A3B12D492AAF2D49DDF40A3D7562B13D04E769BD2DFB1`
- Inno Setup: `6.7.2`
- Authenticode: not signed.

Installer staging contains zero forbidden source roots, zero forbidden source/debug/credential/PSD files outside the bundled third-party Node/Electron runtimes, and no missing required runtime files.
