# UV texel-centre parity — local experiment

M09/M07, ALG-CA-002 1.1.0 experimental. User approved investigating/fixing
projection versus repair coverage locally. Owner: Li3D maintainer.

## Evidence
Live local project logs show current overlap build, 465126 selected texels,
unresolvedPixels=0 and ready/visible repair texture at opacity 1. These prove
publication, not coverage of every screen fragment. No user data was modified
to obtain logs; the live project is unsaved and must not be reloaded automatically.
CPU topology used u*(width-1), while GPU raster maps normalized UV to the full
viewport and sampling uses u*width-.5. Difference=.5-u pixels, varying by atlas
position. This changes narrow triangle and edge ownership even when coverage
and propagation tests pass.

## Change / units
Raster vertices and physical-seam endpoints now both use u*width-.5 and
(1-v)*height-.5 (integer coordinates identify texel centres). UVs, geometry,
projection matrices, resolution, colour space, opacity and rejection thresholds
are unchanged. Bounds and nearest-index clamping are unchanged.

## Edge-gate audit
Both realtime and GPU UV bake apply reliableProjectionSupport with cutoff .90
to angle, depth visibility, facing and image-edge support. Repair asks bake to
preserve aggregate confidence alpha (no dilation/postprocess), then selects
alpha<=30 plus a bounded weak neighbour band. Thus those decisions do affect
selection; identical formulas do not prove identical results at different sample
locations. No weakening of depth/backface protection or hiding hatch is included.

## Paths / migration / rollback
CPU topology shared by repair/UV merge and physical seam links changes; Workers
consume resulting masks/indices. GPU bake and shader sampling already use the
target convention and do not change. No persistent topology, schema or asset
rewrite. Fresh page clears in-memory topology; existing repair PNG needs rerun.
Export consumes the same resulting layers. Rollback the local web image to
li3d-local-web:seam-overlap-20260929, preserving database and original layers.

## Validation
Independent pixel-centre oracle tests at both atlas ends and non-square sizes,
sliver repair, 24 seam-on/off topology parity fixtures, 37 repair tests, typecheck,
auto-merge export and texture orientation tests pass. Updated sliver coordinates
keep the exact intended pixel-space geometry under the corrected convention.
Real screenshot seam disappearance is still pending; this fixes a proven mapping
inconsistency, not a claim that every projection gate mismatch is resolved.
