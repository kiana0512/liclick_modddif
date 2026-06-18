# Liclick 3D Texture

Liclick 3D Texture is the foundation for a Web AI 3D Texture Studio. The first milestone creates a long-lived React + Three.js workspace with Projects, Editor, Web3D viewport, layer stack UI, generation mock flow, and technical documentation.

## Install

```bash
pnpm install
```

## Run

```bash
pnpm dev
```

The web app runs from `apps/web` through the root workspace script.

## Tech Stack

- React, Vite, TypeScript
- Three.js, React Three Fiber, Drei
- Zustand and TanStack Query
- Tailwind CSS with Radix-style local UI primitives
- lucide-react icons
- zod, uuid
- pnpm workspace

## Current Status

- Projects home page with mock project cards.
- Editor workspace shell with toolbar, left panels, viewport, right panels, and bottom tools.
- Web3D viewport renders a default primitive model, OrbitControls, grid, display mode toggles, and capture stub buttons.
- Generate panel uses a mock generation service and can add a generated result as a projected layer.
- Layer stack displays mock and generated layers with visibility, opacity, and delete actions.
- Engine, capture, projection, bake, loader, API adapter, connector protocol, and project schema stubs are in place.

## Development Rules

Read `docs/10_DEVELOPMENT_RULES.md` before adding features. New functionality should update the relevant docs, keep core data typed, keep engine logic outside UI components, and avoid hard-coded API keys.
