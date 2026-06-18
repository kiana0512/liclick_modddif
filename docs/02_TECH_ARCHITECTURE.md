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
6. Preview via projected material shader.
7. Bake to UV texture when exporting or flattening.

## Capture Route

The current phase provides typed stubs. The real implementation should render offscreen passes with deterministic resolution and store URLs or blobs in the project asset store.

## Bake Route

The MVP bake should support one object, one material, one UV set, and 1024/2048 output. Later versions can support material slot routing, UDIMs, multiple objects, and normal/roughness outputs.

## API Adapter

`services/liclickApiClient.ts` defines the adapter shape. Keys must come from environment variables or secure auth, never from committed code.

## Connector Plan

`packages/connector-protocol` defines message contracts for Blender and 3ds Max. The `connectors` directory currently contains placeholders only.
