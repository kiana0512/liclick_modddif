# Filtered repair boundary / export colour parity — local trial

## Scope and approval
User requested continuing local verification/fix of projection-fill cracks and
FBX lamp speckles. M09 with M11/M07; experimental, local only, not master/A100.
ALG-CA-003 1.5.0; EXPORT-FINAL-COLOR 1.1.0. Owner: Li3D maintainer.

## Evidence and change
Two adjacent disjoint alpha masks filtered independently can produce projection
alpha=0.5 and repair alpha=0.5 at their shared edge. Source-over coverage is 0.75,
not 1. Previous repair verification of selected alpha=255 does not detect this.
Retain the one-texel eight-neighbour skirt but permit it underneath projection
within the same topology region. Reliable input colour (alpha>=224) is retained
in that underlay texel; otherwise propagate repaired colour. Never alter input
projection RGB/alpha, cross regions, expand the write selection or change UVs.
Skirt alpha cap=255; generic callers retain their explicit cap and radius.

Final export previously ran UV-seam colour averaging over fully opaque authored
pixels (16-pixel band at 2K). Remove this final-only operation. Existing bake
missing-coverage repair and local-repaint export preparation are unchanged.
This is a targeted comparison build, not proof that all photographed lamp
speckles originated in that final averaging pass.

## Six-path audit
- CPU/Worker: shared surfaceAwareRepair kernel, same policy passed to both;
  no new full-atlas allocations or iterative passes.
- GPU/shader: projection sampling and source-over unchanged; overlapping sparse
  underlay is supplied through existing layer pipeline.
- Persistence: same content-aware-underlay role and PNG. No schema changes,
  no automatic rewriting of old layers or project assets.
- Export: same underlay order; final opaque RGB is no longer averaged again.
  FBX temporary bake and flattening use unchanged resolution/colour space.

## Tests and limitations
37 repair tests, topology/sliver tests, web typecheck, automatic merge/export
and export-orientation checks pass. New regression reproduces old filtered
coverage <1 and verifies overlap coverage=1, source preservation, bounded skirt
and no island crossing. Full mip-chain/anisotropic filtering and real project
visual acceptance remain unverified. Old exported opaque dark pixels cannot be
reclassified as holes. No universal no-seam claim.

## Testing / rollback
Save, refresh, hide previous repair layer, rerun fill, export a new FBX to compare.
Keep original project/model and old export. Roll back local web image to
li3d-local-web:seam-20260929. New layers can be hidden/deleted independently;
do not restore/delete database or object volumes.
