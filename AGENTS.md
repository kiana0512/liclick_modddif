# LI3D Codex Repository Rules

## Reading path (start with task-relevant guidance)

1. Read this file in full. It is the only file required for every task.
2. For any change to this repository, read sections 1.1, 1.2, 2, 14 and 16 of `docs/00_SYSTEM_MODULES_AND_CHANGE_STANDARD.md` — hard boundaries, module IDs, change level and audit-card format. Read section 1.3 for release/CI changes or before pushing.
3. Start with the task table in section 0, the sections your change touches, and the acceptance row for your module in section 15. Expand the reading scope when cross-module dependencies, contract changes or insufficient evidence require it. Begin implementation once the current contract, affected paths and acceptance requirements are understood; passing tests is a completion condition, not a reading condition.
4. When the change touches projection, UV composition or local repaint, additionally audit the GPU, CPU, Worker, shader, persistence and export counterparts; record "not applicable" with a reason for any path that genuinely does not apply. A persistence-only change triggers this audit only when it also affects image assets or cross-path semantics.
5. Read history only to trace a past decision or debug a compatibility/regression issue: `docs/00_SYSTEM_REVISION_LOG.md` and `docs/changes/`.
6. To decide whether a feature is actually delivered, use `docs/modernization/FEATURE_ACCEPTANCE_MATRIX.md`. A page that opens or a button that exists is not delivery.

Text, styling, comment and documentation changes do not normally require algorithm sections; expand the reading scope if dependencies, contract changes or insufficient evidence make them relevant.

## Hard constraints

1. The only production runtime is browser zero-install + LI3D Cloud control plane + object storage/production compute services.
2. Never restore the retired Windows local component, localhost/4618, installer, endpoint switching, or local credential custody.
3. Identify the primary module ID before editing. Identify the algorithm ID only when the change affects algorithm behavior; for text, styling or documentation changes, record "no algorithm change" and skip it.
4. Preserve existing work and keep one focused problem per change.
5. Algorithms do not belong in React panels/pages or Zustand stores.
6. Projection/UV/repaint changes must audit GPU, CPU, Worker, shader, persistence and export counterparts.
7. Do not silently lower output resolution, disable QA, or substitute browser experimental UV/PBR kernels for production services.
8. Persistence changes must preserve Project Command idempotency, Revision CAS, ownership and verified object assets.
9. Update the maintenance Markdown, algorithm/schema version and migration/rollback notes when semantics change.
