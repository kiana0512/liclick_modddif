# CHG-20260826-CLOUD-ALGORITHM-REAUDIT

- Module: `M12/M15` documentation governance
- Baseline: `2568e4053c56f445c5e9d45518bf351923600c28`
- Repository: `E:\Liclick 3D Texture Modernization`
- Scope: documentation and generation workflow only; no production algorithm semantics changed.

## Reason

The previous v1.2.x manual was authored from a mixed/obsolete checkout and incorrectly retained the retired Windows local-component topology. It also misstated current UV merge and local repaint versions.

## Result

- Re-audited the zero-install Browser/Cloud architecture from the clean Modernization chain.
- Registered current Project Command/Revision/object-storage persistence.
- Registered current projection weights, UV merge composition v4, PBR preview-light flattening, and local repaint seam modes v14/v5.
- Added a repository-local DOCX/PDF regeneration command.
- Preserved the previous documents only as visual references, not as semantic sources.

## Validation

- `pnpm --filter @liclick/web test:multi-model-restore-policy`
- contracts build + Web typecheck
- `pnpm docs:maintenance`
- DOCX/PDF full-page render inspection

## Rollback

Remove this documentation commit. Do not restore the v1.2.x architecture claims.
