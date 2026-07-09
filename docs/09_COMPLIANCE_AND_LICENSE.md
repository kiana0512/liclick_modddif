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

## Current Risk

The initial stack uses common permissive open-source packages. `three-projected-material` is not included in the first commit because the projected material is stubbed; if added later, verify package maintenance, peer dependency compatibility, and license first.
