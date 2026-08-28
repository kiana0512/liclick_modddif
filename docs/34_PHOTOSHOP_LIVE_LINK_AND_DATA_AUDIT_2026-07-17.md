# Photoshop Live Link And Local Data Audit

> Historical record only. The legacy Electron launcher and unsigned Photoshop
> CEP deployment flow described below were retired in August 2026. Current local
> integration uses the standalone texture component and the Photoshop UXP bridge.

Date: 2026-07-17

## Outcome

LIclick now treats Photoshop as an offline local editing companion rather than an embedded image editor. Each projected or UV layer has one persistent Photoshop session and PSD, keyed by the LI3D project ID and layer ID. The web editor sends a source texture only when that PSD does not exist; later edits reopen the same layered document, and exported composite PNG revisions are applied back to the live 3D material. The 3D viewport remains interactive while Photoshop is open.

The Windows launcher is the control surface for this integration:

- the home page reports bundled/installed/connected state, plugin version, selected Photoshop version, active sessions, and sync mode;
- the home page can start Photoshop, install or repair the extension, and open the detailed settings;
- advanced settings select a detected or custom `Photoshop.exe`, configure live versus save-time synchronization, tune the debounce delay, control automatic launch, retain recovery sessions, open recovery files, and repair the plugin;
- status polling is automatic. Users do not need to open the CEP panel or click a manual connect button.

## Offline Transport

The integration does not use Creative Cloud services or an internet-facing MCP server.

- Control channel: local WebSocket on `127.0.0.1:4617`.
- Pixel channel: local PNG/PSD files under the current user's LIclick workspace.
- CEP startup: `applicationActivate` starts the panel and connection automatically.
- Session authentication: every session uses a random token; session IDs and revision filenames are validated before file access.
- Revision strategy: Photoshop exports immutable PNG revisions, preventing partial reads while the 3D material updates.

## Installer Behavior

The installer includes `plugins/photoshop-cep` and offers a default-selected `Photoshop 实时纹理插件` task. After the elevated program-file phase, it runs the bundled offline deployment helper as the original signed-in user. This avoids installing into a different administrator profile when UAC credentials come from another account. When selected it:

1. copies the extension to `%APPDATA%\Adobe\CEP\extensions\com.liclick.live-texture`;
2. enables `PlayerDebugMode=1` for the current user's `CSXS.10`, `CSXS.11`, and `CSXS.12` registry branches because this local CEP build is unsigned;
3. keeps a packaged copy under the application directory so the launcher can perform an atomic repair or upgrade later.

Photoshop should be restarted after a repair when it was already running. The launcher reports this instead of requiring users to navigate Photoshop's legacy Extension menu.

## Local Data Boundary

The repository now uses one clear rule: `workspace/` is user/runtime state, not source code.

Examples that must remain local:

- projects, uploads, exports, thumbnails, autosaves, and generation jobs;
- authentication/session state, local profiles, shortcuts, and settings;
- Photoshop PSD documents, source PNGs, revision PNGs, session manifests, and tokens;
- DCC import reports, test FBX files, temporary logs, and Codex recovery patches.

`.gitignore` excludes the complete `workspace/` tree as well as PSD/PSB files and common database/temp sidecars. Existing reusable Blender and 3ds Max validation scripts were moved to `scripts/validation/dcc/`; generated outputs stay in an ignored workspace or another temporary output directory.

The Photoshop artifacts introduced by the local, unpushed integration commit were removed from that commit before publication. Local recovery files were not deleted. Older tracked runtime artifacts are removed from the current index so future commits and clones do not carry machine-specific data.

## Recovery And Cleanup

`keepSessionFiles` defaults to `true`. Closing an edit session therefore preserves its PSD, source image, session manifest, and revision history for recovery. The launcher exposes `打开恢复文件` to open the directory directly.

Creating an edit session is idempotent for a `(projectId, layerId)` pair. When older builds have already created duplicate sessions for one layer, the bridge selects the most recently updated session that still has a PSD, marks the other duplicates closed so Photoshop will not automatically reopen them, keeps every recovery folder untouched, and reuses the selected path from then on. Renaming a layer updates its display name without renaming or replacing its PSD. Deleting a layer does not notify the Photoshop bridge or remove its files, so restoring the same layer ID through project history reconnects to the same PSD; a genuinely new layer ID receives a new PSD.

If the user disables retention, the server closes the Photoshop session and retries background removal of that session directory when Photoshop releases file handles. A failed cleanup is conservative: files remain local rather than risking data loss elsewhere.

## Git Audit Rules

Before committing a release:

```powershell
git ls-files "workspace/**"
git ls-files "*.psd" "*.psb"
git status --ignored --short
git diff --check
```

The first two commands must produce no tracked files. Do not use `git add -f` for runtime artifacts. If large user files are found only in an unpushed commit, amend that local commit so the blobs never reach the remote; a later deletion commit is not sufficient because it still uploads the earlier blobs.

## Validation Checklist

1. Install over an existing LIclick installation and confirm the existing `%LocalAppData%\Liclick 3D Texture\workspace` remains intact.
2. Confirm the CEP manifest exists in the current user's Adobe extension directory.
3. Start LIclick, then Photoshop 2024, without enabling Photoshop network access.
4. Confirm the launcher changes from `插件已就绪` to `实时链路已连接` automatically.
5. Start Photoshop editing from a projected layer and a merged UV layer; verify left-to-right source transfer.
6. Close and reopen Photoshop editing for the same LI3D layer; verify the session ID and PSD path are unchanged and the existing Photoshop layers remain present.
7. Paint and save in Photoshop; verify immutable revisions update the live 3D material without freezing orbit controls.
8. Close the session with retention enabled and reopen the PSD from the launcher recovery directory.
9. Run typecheck, lint, production build, Photoshop bridge smoke, installer packaging, and launcher browser QA.

## Release Verification

The 2026-07-17 local release candidate passed the following automated checks:

- TypeScript typecheck, ESLint, desktop JavaScript syntax checks, and the production web/server build.
- Photoshop bridge smoke: session open, revision ingest, synchronized state, and revision image retrieval.
- CEP deployment helper smoke with an isolated test `%APPDATA%` directory.
- Windows staging audit: the CEP manifest and original-user deployment helper are present.
- Inno Setup compilation with no compiler warnings.
- Git boundary audit: zero tracked files under `workspace/` and zero tracked PSD/PSB files; nine existing local PSD recovery documents remain on disk.

Generated setup artifact:

- File: `dist-installer/Liclick 3D Texture Setup 2026.07.17.1158.exe`
- Build: `2026.07.17.1158`
- Size: `140,693,202` bytes (`134.18 MiB`)
- SHA-256: `7E063573B37EF531B67018F87F44EAAEF1866FBD002BFA40716B873CE174A772`
- Authenticode: not signed in this local test build.

## Known Release Constraints

- The CEP bridge is intentionally unsigned for local testing, so the installer must explicitly enable Adobe's per-user debug mode.
- Photoshop may need one restart after plugin installation or repair.
- The setup executable is not Authenticode-signed until the release pipeline applies the product certificate.
- Physical Photoshop/CEP behavior still requires a real Photoshop installation and cannot be fully represented by headless CI alone.
