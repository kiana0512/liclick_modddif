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

## Inpaint

Inputs: prompt, mask, base image, selected object, and optional references.

## Normal Generation

Inputs: basecolor or prompt/image pair. Output should identify normal coordinate space.

## Multiview

Inputs: multiple camera snapshots and captures. Output should preserve per-view images and consistency metadata.

## Mock Service

`mockGenerationService.ts` returns a data URL image and Generation object. Use it until backend endpoints are available.
