# Liclick API Adapter

The API adapter isolates UI and engine code from backend details.

## Principles

- Do not hard-code API keys.
- Keep auth in environment variables, secure sessions, or backend-issued tokens.
- Keep request/response contracts typed.
- Keep mock service available for offline UI development.

## Interface

```ts
type LiclickApiClient = {
  generateTextureSingleView(input): Promise<Generation>;
  inpaint(input): Promise<Generation>;
  generateNormal(input): Promise<Generation>;
  generateMultiview(input): Promise<Generation>;
};
```

## generateTextureSingleView

Inputs: prompt, references, selected object id, capture id, resolution, visible-only flag, and upscale flag.

Output: generation id, status, result image URL, and metadata.

Phase 2 input contract:

```ts
type GenerateTextureInput = {
  mode: 'single';
  prompt: string;
  negativePrompt?: string;
  referenceIds: string[];
  referenceImages?: ReferenceImage[];
  capture?: Capture;
  object?: SceneObject;
  resolution?: '1K' | '2K' | '4K';
  textureMode?: 'realistic' | 'albedo';
  visibleOnly: boolean;
  upscale: boolean;
};
```

The mock service now uses the real `capture.id` and object id in generation metadata. The real Liclick API can replace `mockGenerationService.generateTextureMock` by implementing `createLiclickApiClient().generateTextureSingleView` with the same input/output shape.

## Inpaint

Inputs: prompt, mask, base image, selected object, and optional references.

## Normal Generation

Inputs: basecolor or prompt/image pair. Output should identify normal coordinate space.

## Multiview

Inputs: multiple camera snapshots and captures. Output should preserve per-view images and consistency metadata.

## Mock Service

`mockGenerationService.ts` returns a data URL image and Generation object. Use it until backend endpoints are available. API keys and endpoints must come from settings or environment-backed auth, never committed source.
