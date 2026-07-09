# Feature Breakdown

This document describes the functional areas Liclick should eventually support based on public screenshots and public product descriptions of the AI 3D texture workflow category. It is not a copy list of private implementation details.

| Area | Description | Phase |
| --- | --- | --- |
| Projects home | Project cards, folders, recent updates, new project flow. | MVP required |
| Editor main interface | Toolbar, left panels, central viewport, right panels, bottom tools. | MVP required |
| Objects | Mesh list, selection, visibility, material slots, UV sets. | MVP required |
| Reference Images | Upload, select primary references, attach references to normal Liclick generation and local repaint. Texture Map consumes one material reference but does not add texture-map outputs back as references. | MVP required |
| Liclick Image | Prompt + selected references through the authenticated server-side Atlas/Liclick adapter. | MVP required |
| Texture Map | Current model-view capture plus one material reference produces a view-aligned texture-map preview that can be accepted as a projected layer. Production foreground-alpha refinement and multi-view conditioning remain follow-up work. | MVP implemented |
| Viewport modes | PBR, Flat, Normal, Wire, Segmentation. | PBR/Normal/Wire MVP, others later |
| Projected Layer | Camera-based generated image projection onto model with stacked preview, mask/depth/backface gates, opacity, projection strength, and UV bake. | MVP implemented |
| UV Layer | Direct UV-space texture layer. | Later phase |
| Layer Stack | Order, visibility, opacity, blend mode, delete, camera recall. | MVP required |
| Inpaint / Patch | Current-view mask painting and local repaint submission through the server-side Atlas/Liclick adapter, with a supported fallback path when the custom workflow is rejected. | MVP implemented |
| Quick Mask | Fast visible area or segment mask creation. | Placeholder |
| Segments | Semantic or mesh-region segmentation. | Placeholder |
| Normal Map | Generate or preview normal maps. | Placeholder |
| Simplify | Mesh simplification and optimization. | Later phase |
| Export | Export viewport PNG, scene/object GLB/FBX/OBJ/STL, baked BaseColor PNG, material normal PNG, and WebM turntable. | MVP implemented |

## MVP Must Do

- Projects page.
- Editor page.
- Web3D viewport with default model, OrbitControls, grid, object selection.
- Liclick image generation flow.
- Layer stack UI with generated projected layer insertion, stacked preview, opacity/strength controls, and bake state.
- Capture, projection, local repaint, and Texture Map single-view flow.

## Later Phases

- Foreground-alpha refinement and alignment scoring for Texture Map.
- Multi-view texture generation/compositing.
- Normal/roughness/metallic bake outputs.
- DCC connectors.
