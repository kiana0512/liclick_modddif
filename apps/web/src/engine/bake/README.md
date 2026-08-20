# Projection-to-UV Engine

This directory provides the GPU-first/CPU-parity engine used when a caller needs
to project camera layers into UV space. It is not a global automatic-bake mode.

Current callers include:

- explicit Layer-panel merge to a new or blank UV layer;
- local-repaint UV repair commit;
- content-aware coverage repair;
- on-demand BaseColor/GLB/FBX/OBJ export preparation.

Adding a Texture Map result creates a live Projected Layer. It does not, by itself,
flatten the whole visible stack in the background.

## Core Flow

1. Collect the exact projected sources requested by the caller.
2. Render target geometry in UV space and reconstruct world position/normal.
3. Apply frustum, source-alpha, mask, linear-view depth, normal, backface,
   opacity, strength, adjustment, Blend, and Overlay rules.
4. Prefer GPU projection sampling; use CPU/parity/fallback paths where the caller
   and resource limits allow it.
5. Resolve candidate quality in a Worker/WebGPU path when available, with CPU
   calibration/fallback preserving output semantics.
6. Return straight RGBA, coverage/report data, and optional encoded PNG. The
   caller decides whether to create a UV layer, cache a baked texture, apply it,
   or persist it.

## Production Constraints

- One active object, one `uv` attribute, BaseColor RGBA, no UDIM.
- Requested resolution is not silently reduced by this engine.
- Merge/repair callers may add topology-constrained gutter, hole, and seam
  processing after projection; generic dilation is not the complete seam policy.
- Current Three.js/glTF orientation uses `texture.flipY = false`; projected source
  textures use the GPU sampling transform required to match CPU image data.
- GPU allocation, texture arrays/samplers, readback, PNG encoding, browser memory,
  and preview upload remain hard limits at 4K/8K.

GPU/CPU debug calibration and performance switches are implementation diagnostics,
not user-facing bake modes. Validate changes with the projection, export-orientation,
UV-composite, and performance protocol tests.
