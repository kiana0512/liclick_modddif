# Viewport Lighting And Display Modes

Phase 8 improves model readability in the Web3D viewport.

## Renderer

The viewport renderer uses:

- `SRGBColorSpace`
- `ACESFilmicToneMapping`
- adjustable `toneMappingExposure`, default `1.35`

`ViewportPanel` exposes exposure, environment preset, and reset lighting controls.

## Lighting

`SceneRoot` combines ambient, hemisphere, key, fill, and rim-style directional lights. The default environment is `studio`, with `color`, `soft`, and `dark` available as MVP presets.

## Display Modes

- PBR: keeps usable source materials, fixes dark fallback colors, sets base textures to sRGB, and uses neutral roughness/metalness.
- Flat: unlit material for clear albedo/baked texture inspection.
- Normal: debug normal colors only.
- Wire: wireframe material for mesh structure inspection.

Imported models with missing or unusably dark materials receive a neutral fallback color so FBX/OBJ imports do not appear as black blocks.
