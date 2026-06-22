# Liclick API Adapter

The API adapter isolates UI and engine code from backend details.

## Principles

- Do not hard-code API keys.
- Keep auth in the server-side Liclick / Atlas gateway session and local secure cookies.
- Keep request/response contracts typed.
- Keep mock service available for offline UI development.

## Current Atlas Gateway Status

The server exposes `GET /api/liclick/status` to verify real Liclick API access through the local `@lilith/atlas-skillhub` gateway. The endpoint requires the local Liclick session cookie and then runs `gateway list-tools --service liclick`.

As of this audit, the real gateway can discover Liclick tools such as `generate_image`, `generate_video`, `generate_model_3d`, `generate_music`, `get_task_status`, `upload_asset`, `list_workspaces`, and `list_tasks`.

The editor Generate panel now calls the server route `POST /api/liclick/generate-image`, not the old mock generator. The server performs the Atlas/Liclick call and the frontend receives only a sanitized generation result. Atlas tokens, Feishu tokens, and API keys never go to the browser.

The real `gpt-image-2` request requires `extra_params.name`. The current adapter sends:

```json
{
  "prompt": "...",
  "model": "gpt-image-2",
  "extra_params": {
    "name": "Liclick 3D Texture",
    "quality": "high",
    "n": 1,
    "aspect_ratio": "1:1",
    "image_size": "1K"
  }
}
```

When references are selected, the server uploads each reference through `upload_asset(asset_type=image)` first and passes returned `asset_id` values in `extra_params.reference_images`.

The submit response may only contain a `task_id`; the adapter then polls `get_task_status(task_type=image)` until a real image URL is returned. The parser intentionally rejects parameter-error payloads and no-task responses instead of treating unrelated URLs as generated images.

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

`createLiclickApiClient().generateTextureSingleView` calls the authenticated server route. The returned `Generation` stores:

- `metadata.provider = "liclick-atlas"`
- `metadata.taskId`
- `metadata.model`
- `metadata.resultUrls`
- `metadata.extraParams`
- `metadata.uploadedReferences`

The preview image can be manually added to projected layers or back into the project's reference images. It is not automatically injected as a reference.

## Account Boundary

The frontend session identifies the current Liclick user with an `httpOnly` cookie. The Atlas gateway provides the actual Liclick API access. Before image generation, the server compares the session email with the current Atlas identity email. If they do not match, `POST /api/liclick/generate-image` returns `403` and asks the user to log in again.

This prevents a local or server process from silently using another user's Atlas/Liclick account. For a Linux multi-user deployment, the process manager must also guarantee that Atlas credentials are scoped per logged-in user or replaced with a proper per-user server-side credential flow.

## Generated Asset Persistence

Liclick generation can return hosted `ai-assets.lilithgames.com` image URLs. During project autosave, the editor sends those URLs back to the workspace server through `POST /api/projects/:projectId/assets`. The server downloads the image into the authenticated user's current project asset directory and stores the project JSON with a relative workspace asset path.

For security, remote asset import is HTTPS-only and host allowlisted. The default allowlist includes `ai-assets.lilithgames.com`; add extra hosts with `LICLICK_ALLOWED_REMOTE_ASSET_HOSTS` only when they are trusted image asset domains.

## Inpaint

Inputs: prompt, mask, base image, selected object, and optional references.

## Normal Generation

Inputs: basecolor or prompt/image pair. Output should identify normal coordinate space.

## Multiview

Inputs: multiple camera snapshots and captures. Output should preserve per-view images and consistency metadata.

## Mock Service

`mockGenerationService.ts` remains useful for offline UI development only. Production and authenticated editor generation use the server-side Atlas adapter. API keys, Atlas tokens, and endpoints must never be committed or passed to frontend code.
