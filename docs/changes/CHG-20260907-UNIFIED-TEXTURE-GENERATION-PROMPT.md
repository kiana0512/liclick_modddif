# CHG-20260907 Unified Texture Generation Prompt

## Scope

- UI/module: UI-05 → M04
- Algorithm: `ALG-GEN-001/002` v1.1.0
- Release: `2.18.3`

## Change

Remove the retired whole-surface material-transfer prompt. Initial white-model single-view generation, existing-texture completion and multiview generation now call one shared prompt that edits only white/light-grey unfinished model regions, preserves existing textured pixels and geometry registration, suppresses low-poly shading artifacts, and requests projection-ready Base Color/Albedo with subdued lighting. User material requirements remain appended after the shared template.

## Unchanged boundaries

Capture images, remote providers, authored and submitted masks, task identity, polling, projection/UV composition, output resolution, Project/Layer/Capture/Generation schema, Revision CAS, ownership and verified assets are unchanged. No data migration is required.

## Verification and rollback

Regression tests assert that both builders use the shared template and that the retired prompt cannot reappear. Web production build and bundle budget must pass. Rollback restores the previous prompt split only; it must not delete projects, generations, layers or assets.
