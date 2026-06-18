# Bake MVP Stub

This directory reserves the UV bake pipeline. Phase 1 does not implement real baking.

Planned flow:

1. Collect projected, UV, and patch layers for a selected object.
2. Render or compute projection into the target UV set.
3. Composite visible layers by order, blend mode, and opacity.
4. Export basecolor first, then normal and masks.

MVP limits are single object, single material, one UV set, and 1024 or 2048 output.
