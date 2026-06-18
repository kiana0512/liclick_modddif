# Feature Breakdown

This document describes the functional areas Liclick should eventually support based on public screenshots and public product descriptions of the AI 3D texture workflow category. It is not a copy list of private implementation details.

| Area | Description | Phase |
| --- | --- | --- |
| Projects home | Project cards, folders, recent updates, new project flow. | MVP required |
| Editor main interface | Toolbar, left panels, central viewport, right panels, bottom tools. | MVP required |
| Objects | Mesh list, selection, visibility, material slots, UV sets. | MVP required |
| Reference Images | Upload, select primary references, attach references to generation. | MVP required |
| Generate Single | Prompt + selected references + current capture to image. | MVP required |
| Generate Multiview | Multi-camera generation and consistency workflow. | Later phase |
| Viewport modes | PBR, Flat, Normal, Wire, Segmentation. | PBR/Normal/Wire MVP, others later |
| Projected Layer | Camera-based generated image projection onto model. | MVP preview, full depth later |
| UV Layer | Direct UV-space texture layer. | Later phase |
| Layer Stack | Order, visibility, opacity, blend mode, delete, camera recall. | MVP required |
| Inpaint / Patch | Masked region editing. | Placeholder |
| Quick Mask | Fast visible area or segment mask creation. | Placeholder |
| Segments | Semantic or mesh-region segmentation. | Placeholder |
| Normal Map | Generate or preview normal maps. | Placeholder |
| Simplify | Mesh simplification and optimization. | Later phase |
| Export | Export basecolor/normal and GLB/DCC handoff. | MVP basecolor later, full export later |

## MVP Must Do

- Projects page.
- Editor page.
- Web3D viewport with default model, OrbitControls, grid, object selection.
- Generate mock flow.
- Layer stack UI with mock data and generated projected layer insertion.
- Capture and projection stub interfaces.

## Later Phases

- Real GLB persistence.
- True projected material shader.
- Depth-aware projection.
- UV bake.
- Multiview generation.
- DCC connectors.
