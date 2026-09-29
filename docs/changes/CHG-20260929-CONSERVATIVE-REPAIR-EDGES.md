# Local trial: conservative repair edges

UI content-aware fill → M09 → ALG-CA-001 1.2.0 / ALG-CA-004 1.1.0.
Status: local trial, user authorized 2026-09-29; no remote push/deployment.

Evidence: the supplied FBX has 99,996 UV triangles at 2048²; 2,919 have no pixel-centre coverage. This is a risk measurement, not proof that every such triangle is visibly defective. The exported RGB is fully opaque and cannot reconstruct missing source alpha.

Input: final-composite straight RGBA, same-resolution UV core/conservative masks, region IDs and conflicts. UV units and image orientation unchanged. Production mask selection now includes conservative-only texels only when region is nonzero and conflict is zero. Existing alpha thresholds (live hatch hard threshold / weak 64) and one-step same-region weak growth are unchanged. Generic mask callers retain strict-core defaults. Reliable colours are not selected; no whole-atlas dilation and no black-colour heuristic.

Residuals use existing bounded local / physical-seam / reported global-colour fallback. Before publication an independent cancellable O(N) check requires every selected output texel to have alpha 255; failures remain unresolved and block the existing UI success path. One extra byte per texel is retained across Worker transfer. No additional repeated full repair pass.

Six-path audit: CPU mask construction is shared. Worker and CPU fallback use the same propagation kernel and returned RGBA; no new Worker protocol. GPU/shader sampling and blending unchanged, receive the expanded sparse UV underlay. Persistence remains straight-RGBA PNG with existing atomic asset publication and Project Command/CAS. Export consumes the same underlay; UV merge version and project schema unchanged. No geometry/UV edits, generation, or resolution changes.

Tests: mask regressions cover centre-free edges, ambiguous overlaps, outside footprint, valid authored texels, cancellation and incomplete output. Existing repair/topology tests and Web typecheck are required. Actual browser/Blender visual acceptance remains user testing, not claimed by these unit tests. This trial does not guarantee all mip levels or repair already opaque RGB seams.

Migration: none; existing layers unchanged, rerun content fill to create a new result. Rollback: restore prior web image or disable includeConservativeEdges; preserve project data and generated assets. Owner: local maintenance task.
