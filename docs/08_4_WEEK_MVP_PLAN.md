# Four-Week MVP Plan

## Week 1

- WebUI shell.
- Projects page.
- Editor page.
- Web3D viewport with default model, OrbitControls, grid, selection.
- GLB import interface and loader stubs.
- Reference image panel.

Status: completed in Phase 1.

## Week 2

- Real capture color, mask, depth, and normal render targets.
- Camera snapshot persistence.
- Liclick API mock integration.
- Generation request history.

Status: completed in Phase 2. It implements real local model import, capture passes, mock generation linked to captures, shader projected preview, and project save/load v1.

## Week 3

- Projected Layer preview material.
- Layer Panel workflows.
- Go-to-camera for projected layers.
- Projection depth-check prototype.

Status: Phase 3 implements UV Bake MVP: active projected layer to basecolor PNG, material application, download, coverage report, and baked layer state.

Phase 4 adds the first usability cleanup pass: import normalization settings, object Move / Rotate / Scale controls, local workspace Save / Save As / Load, Normal preview hints, and command availability cleanup for disabled MVP buttons.

Phase 5 refactors the editor workspace UI into viewport-first floating dock panels. It does not add new Web3D engine behavior; it makes the existing import, capture, generation, projection, bake, and save flows easier to use.

Phase 6 introduces the local workspace server, real project/folder creation, autosave, project-relative assets, export matrix UI, `.liclick3d` package stub, and draggable left/right dock panels.

Next focus: export GLB/GLTF with baked baseColorTexture or real Liclick API integration.

## Week 4

- UV bake MVP for basecolor.
- Export baked basecolor.
- Demo project polish.
- Documentation and regression checklist.

Phase 4 moved local project persistence and transform usability into the MVP baseline. Week 4 export work should build on `project.liclick.json`, the asset manifest, and the existing baked texture records instead of adding a second save format.

Phase 5 adds the panel system foundation for later drag/drop layout and mode-specific tools.
