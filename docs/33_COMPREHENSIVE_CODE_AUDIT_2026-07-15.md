# Comprehensive Code, Security, Test, And Release Audit

Date: 2026-07-15  
Application version: `0.1.3`  
Desktop shell build: `2026.07.15.1104`

## Scope

This pass audited the Electron launcher, React/Vite web workspace, local Node workspace server, authentication/session boundary, project and asset persistence, packaging scripts, repository hygiene, performance audit tooling, and current release documentation. It preserves user workspace data and does not remove tracked validation assets automatically.

## Resolved In This Pass

- Reworked the desktop launcher's home layout into a continuous responsive grid. Compact, short-wide, tall-narrow, default, and 1080p windows no longer switch through a discontinuous height breakpoint or leave the previous large unused bottom region.
- Kept the accepted launcher visual structure, removed duplicated in-content branding, and aligned Chinese/English typography with the bundled Noto Sans SC web font.
- Restricted `/workspace/*` serving to project-owned `assets`, `thumbnails`, and `exports` directories. Internal files such as `auth.json`, settings, job state, and unrelated workspace files are no longer web-readable.
- Replaced string-prefix path validation with `path.relative` containment checks and real-path checks. The public-directory containment is checked separately so traversal cannot escape an asset directory while remaining inside the overall workspace.
- Replaced wildcard workspace CORS with the configured origin allowlist, credential-aware headers, `Vary: Origin`, and `X-Content-Type-Options: nosniff`.
- Rejects API and workspace requests that present a non-allowlisted `Origin`.
- Supports safe `HEAD` requests for project assets and rejects unsupported workspace-file methods.
- Refuses to start on a non-loopback host when the default development `SESSION_SECRET` is still in use.
- Added a restrictive Content Security Policy to the static launcher and denies renderer-created windows or navigation away from the bundled launcher document.
- Added `pnpm smoke:local`, an isolated, repeatable server smoke test that creates a temporary workspace and cleans it after execution.
- Updated the performance audit to ignore `dist-installer`, which is expected release output rather than source/runtime payload.
- Updated README desktop behavior and removed outdated references to a user-facing Auto UV bake switch.

## Automated Validation Matrix

| Area | Command or method | Expected result |
| --- | --- | --- |
| Type safety | `corepack pnpm typecheck` | All workspace packages pass |
| Lint | `corepack pnpm lint` | All workspace packages pass |
| Production build | `corepack pnpm build` | Server and web production builds pass |
| Desktop syntax | `node --check` on main, preload, and renderer | All files parse |
| Local server boundary | `corepack pnpm smoke:local` | Auth, project creation, upload, CORS, HEAD, traversal/private-file isolation pass |
| Static payload audit | `corepack pnpm perf:audit` | Reports source/workspace size without counting installer output |
| Launcher interaction | Headless Chromium CDP smoke | Home/Services navigation passes; no console errors |
| Responsive launcher | Chromium screenshots at 1024x680, 1100x1000, 1280x760, 1360x860, 1440x900, 1600x700, 1920x1080 | No overlap, breakpoint jump, or unintended bottom gap |
| Installer | `corepack pnpm package:windows` | Inno Setup produces the complete Windows installer |

The final command results, installer size, and SHA-256 are recorded at the end of the pass after packaging.

## Repository And Data Findings

- The local `workspace/` tree is about 5.3 GB and includes large model/validation data. This is user/runtime data and was intentionally not deleted.
- `workspace/generation-jobs.json` and several workspace validation assets are already tracked in Git even though current `.gitignore` rules exclude runtime workspace data. Removing them from the Git index changes repository history/staging and should be done as an explicit repository-maintenance action, not as an automatic cleanup during a product audit.
- The tracked `.codex-inpaint-validation/auth.json` currently contains no users, sessions, or token hashes, but auth/runtime files should remain excluded from future commits.
- No committed `.env` file, private key, or obvious plaintext API/session secret was found by the local name/pattern scan. Example secret names in documentation and configuration are expected.

## Residual Risks And Manual Validation

- The Electron window currently uses `contextIsolation: true` and `nodeIntegration: false`, but `sandbox: false`. Enabling Chromium sandboxing should be a dedicated Electron compatibility pass because the launcher manages local child processes through the main process.
- JSON request bodies do not yet have one global byte limit. Binary asset uploads are capped, but large project save/data-URL flows need an endpoint-specific limit that does not break 4K/8K projects.
- `GeneratePanel` and `EditorPage` remain large orchestration components. Splitting generation, restore, bake, and persistence workflows would reduce regression risk.
- The web editor's large Vite chunk warning remains. It is non-blocking but should be addressed with route/feature code splitting after workflow stabilization.
- The Windows installer is not Authenticode-signed. External distribution will show publisher/reputation warnings until the release pipeline signs the setup executable with the product certificate.
- Shortcut overrides are keyed by authenticated user but stored in browser local storage. They persist per user on the current machine/profile; cross-device synchronization would require a server-side user preference API.
- Real Feishu/IDaaS login, Liclick/Atlas generation, ComfyUI workflows, physical Wacom/tablet latency, GPU-specific 4K/8K bake behavior, DCC interchange, and installer upgrade-over-existing-data require their real external services or hardware and are not represented as automated passes.
- The production dependency vulnerability query was not sent to the public npm audit service because it would disclose the private package graph/metadata to a third party. Run it only with informed authorization: `corepack pnpm audit --prod --audit-level moderate`.

## Release Checklist

1. Run `corepack pnpm smoke:local`.
2. Run `corepack pnpm typecheck`, `corepack pnpm lint`, and `corepack pnpm build`.
3. Run the desktop `node --check` commands and `corepack pnpm perf:audit`.
4. Perform launcher navigation and representative responsive viewport checks.
5. Run `corepack pnpm package:windows`.
6. Confirm staged desktop build `2026.07.15.1104`, confirm the staged server contains the workspace isolation fix, and record installer SHA-256.
7. Upgrade-test over a copy of an existing `%LocalAppData%\Liclick 3D Texture\workspace` before external distribution.

## Final Results

All local automated checks in the matrix passed on 2026-07-15:

```text
corepack pnpm typecheck       PASS
corepack pnpm lint            PASS
corepack pnpm build           PASS
corepack pnpm smoke:local     PASS
corepack pnpm perf:audit      PASS (report-only; workspace 5338.45 MB)
desktop node --check matrix   PASS
git diff --check              PASS (line-ending notices only)
launcher Chromium QA          PASS
corepack pnpm package:windows PASS
```

Final installer:

```text
Path: E:\Liclick 3D Texture\dist-installer\Liclick 3D Texture Setup.exe
Product version: 0.1.3
Desktop build: 2026.07.15.1104
Size: 140,633,145 bytes (134.12 MiB)
SHA-256: 5405D279FB8E4351CB51799829357B424F88CDC411DB6BBE5338CA0AD4410676
Authenticode: NotSigned
```

Staging verification confirmed that the installer contains the desktop build marker, launcher CSP/navigation protection, workspace-file isolation, CORS credentials policy, and non-loopback session-secret guard.

Packaging emitted two non-blocking environment/tooling warnings: Corepack could not overwrite the system-wide pnpm shim and correctly continued with `corepack pnpm`; Inno Setup translated the deprecated `x64` architecture identifier to `x64os`. Neither warning prevented a successful compile.
