# Compliance and License

This repository must remain a clean-room functional implementation.

## Prohibited

- Do not copy competitor code, icons, logo, CSS, bundles, private APIs, images, or proprietary text.
- Do not call competitor APIs.
- Do not scrape private app bundles.
- Do not commit API keys.
- Do not use GPL or AGPL dependencies as core dependencies.

## Allowed

- Public screenshots and public descriptions may inform high-level feature planning.
- MIT, Apache-2.0, BSD, ISC, and Zlib style dependencies are acceptable by default.
- Mock data can be used for project cards, references, layers, and generated images.

## Dependency Review

Before adding a new dependency:

1. Check its license.
2. Check transitive risk if it becomes core runtime infrastructure.
3. Prefer permissive licenses.
4. Document unusual license decisions.

## Current Projection Dependency

The projected-layer implementation is an LI3D-owned Three.js shader path.
`three-projected-material` is not a current dependency. If a replacement or
supplemental projection package is proposed later, review its license, maintenance,
peer dependency compatibility, shader limits, and clean-room implications first.
