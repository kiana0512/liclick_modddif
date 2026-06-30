# Technical Architecture

The repository is a pnpm workspace with `apps/web` and reusable packages under `packages`.

## Web App

- React + Vite + TypeScript provide the application shell.
- Tailwind CSS powers the first Liclick visual system.
- Local Radix/shadcn-style primitives keep components small and replaceable.
- lucide-react supplies open-source icons.

## State and Data

- Zustand stores hold local editor state: project, scene, references, generations, layers, and settings.
- TanStack Query is installed for backend-backed project and generation calls once APIs exist.
- zod is used in packages for schema validation and future project document loading.

## 3D Stack

- Three.js is the rendering base.
- React Three Fiber owns declarative scene composition.
- Drei provides OrbitControls, cameras, grid helpers, environment, and utility components.
- Internal model format is glTF/GLB first. FBX/OBJ are import paths that should be converted or normalized into the same scene metadata model.

## Projected Layer Route

1. Save current camera matrices and selected object id.
2. Capture color, mask, depth, and normal passes.
3. Send prompt, references, and capture metadata to the Liclick API Adapter.
4. Receive generated image.
5. Create a projected layer with camera snapshot and image URL.
6. Preview via the projected-layer stack shader. The shader can combine multiple visible projected layers, sample the baked/base material underneath, and overlay the latest UV texture when the stack has not been flattened.
7. Bake to UV texture when the user accepts a Texture Map result, manually bakes a layer stack, or exports textured model formats with Auto UV bake enabled.

## Capture Route

The current implementation renders deterministic offscreen WebGL passes for color, mask, normal, and grayscale-packed depth. Local-server projects persist generated pass images through the workspace binary asset API instead of embedding large base64 payloads in `project.liclick.json`.

## Bake Route

The current bake path is GPU-first and supports one imported object, one UV channel, and 1K/2K/4K/8K BaseColor output subject to browser and GPU limits. It composites the visible projected-layer stack into UV space, validates coverage, falls back to CPU rasterization when needed, applies seam padding, and persists the baked PNG for local-server projects. Later versions can add material-slot routing, UDIMs, multiple objects, normal/roughness outputs, and worker-side PNG encoding.

## API Adapter

`services/liclickApiClient.ts` defines the browser-to-local-server adapter. The server owns the Atlas/Liclick gateway calls, session checks, polling, asset uploads, and local repaint fallback behavior. Keys and tokens must come from secure server-side auth, never from committed code or browser-visible state.

## Connector Plan

`packages/connector-protocol` defines message contracts for Blender and 3ds Max. The `connectors` directory currently contains placeholders only.
