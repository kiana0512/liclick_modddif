# LI3D Codex Repository Rules

Before changing this repository, read `docs/00_SYSTEM_MODULES_AND_CHANGE_STANDARD.md` completely.

1. The only production runtime is browser zero-install + LI3D Cloud control plane + object storage/production compute services.
2. Never restore the retired Windows local component, localhost/4618, installer, endpoint switching, or local credential custody.
3. Identify the primary module ID and algorithm ID before editing.
4. Preserve existing work and keep one focused problem per change.
5. Algorithms do not belong in React panels/pages or Zustand stores.
6. Projection/UV/repaint changes must audit GPU, CPU, Worker, shader, persistence and export counterparts.
7. Do not silently lower output resolution, disable QA, or substitute browser experimental UV/PBR kernels for production services.
8. Persistence changes must preserve Project Command idempotency, Revision CAS, ownership and verified object assets.
9. Update the maintenance Markdown, algorithm/schema version and migration/rollback notes when semantics change.
10. At the end of a completed iteration, add one revision row, run `pnpm docs:maintenance`, visually verify DOCX/PDF, and commit Markdown + DOCX + PDF together.
