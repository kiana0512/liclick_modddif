# Local trial: merge display-edge parity

## Decision / authorization
User approved the evidenced plan on 2026-09-29: align merge edge mixing and color space with live display; local testing only, no master push or A100 deployment. Primary module M07, collaborators M06/M09/M11; UI-09 merge, resident UV and export. Major semantic change, implementation Codex, visual acceptance by user.

## Evidence
Publication follow-up (2026-09-29): user subsequently requested pushing these fixes to master. Merge latest origin/master and pass the complete `verify:prepush` gate before publication. Personal account overrides, secrets and local deployment configuration remain excluded; no A100 deployment is authorized in this follow-up. FBX overlay regression now expects linear-light RGB (122,0,167) with unchanged alpha 192.
The first full release passed functional tests, lint and deployment simulation but left only 69 bytes of total-JS headroom (256 required). PBR merge now imports the already-identical sRGB lookup and encoder from the canonical color kernel, removing duplicate math without changing outputs or budgets.

The actual CPU Top-3 resolver marked every accepted projection sample alpha=255 in merge mode. At confidence 0.06 the live shader instead uses smoothstep(0,0.12,confidence)=0.5; the opaque merge excludes the repair underlay entirely. Underlay byte-space RGB interpolation also differs from the shader's decoded linear-light interpolation. These are proven code discrepancies, not proof that all model seams have the same cause.

## Contract / alternatives
ALG-UV-003 3.0.0 adds an explicit display-alpha mode, retaining raw-confidence mode for repair classification and the legacy opaque mode for other callers. Aggregate confidence remains 1-product(1-coverage), display alpha uses the existing viewport 0..0.12 smoothstep. Applied before authored overlays, never to their masks. ALG-UV-006 3.0.0 composes straight alpha in linear light and re-encodes sRGB bytes. No matrix, depth, source-selection, UV layout, resolution, topology growth or seam-repair radius change. Expanding repair or thresholding final RGB was rejected: neither fixes the mixing contract.

## Six-path audit
- CPU diagnostic baker and canonical pixel resolver: display alpha before overlay composition.
- Worker CPU and WebGPU quality shader: three independent calibration modes, existing exact-alpha parity/fallback retained.
- Resident WebGL quality shader and sparse correction: display mode and independent calibration/correction cache identity.
- Live shader: unchanged reference; existing smoothstep 0..0.12 and linear RGB mixing.
- Underlay CPU/export and Worker CPU share linear channel implementation; Worker WebGPU implements the same transfer functions and retains parity validation.
- Manual merge, background preparation, resident display and automatic FBX merge consume the common merge option profile.
- Persistence: UV merge version 14, bake protocol 11, projection/final preparation keys bumped, compressed resident cache namespace v2. No Project schema, CAS, ownership or asset mutation.

## Migration / rollback
Existing authored and merged textures are never rewritten. Restore original projected/fill layers and re-merge to obtain the new result. Derived old caches are not reused or deleted; source assets remain. Roll back to local image li3d-local-web:texel-centre-20260929 and matching source semantics; new merged PNGs remain valid independent images. Previous local repair trials are preserved.

## Verification / limits

The diagnostic CPU raster now adapts to the canonical pixel resolver instead of duplicating its formula; 3,000 randomized pixel comparisons against the frozen diagnostic implementation pass in all three alpha modes. Pure shared UV color kernels have one explicit cacheable build chunk, analogous to existing shared modules; total JS and every route budget remain enforced without increased limits. No source module directory was moved.
New executable regression checks low-confidence edges, raw-confidence separation, linear-light composition, CPU/Worker parity and transparent padding. Existing quality parity, overlay identity, native merge, cache/invalidation, export orientation, topology and repair tests retained. Runtime GPU calibration remains mandatory. Passing numerical tests does not establish same-project visual acceptance; user must compare the original stack against a newly merged layer at the same view. Texture filtering/resampling and existing seam postprocessing remain possible residual differences.

Executed locally: Web typecheck and release build; unchanged bundle/cloud-artifact gates; targeted ESLint; new edge/diagnostic parity; native merge; quality resources (240 legacy CPU cases and mocked GPU resource parity); resident UV correction/cache; underlay queue/cache; merge preparation/final/persistence/consumption/preview; backpressure; projection reliability/performance; export orientation/automatic merge; 37 repair tests and topology regression. GPU hardware pixel comparison and the user's project visual acceptance are not claimed by these unit tests.

Deployed only `li3d-local-web:merge-edge-20260929` through the local Compose web service. Container healthy; HTTPS page, `/assets/index-DIKQCzzx.js` and API health returned 200. Server/database/storage and the open editing page were not restarted/refreshed. No push, no A100 changes.
