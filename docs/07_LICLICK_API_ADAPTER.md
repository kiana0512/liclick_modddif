# Liclick API Adapter

The API adapter isolates UI and engine code from backend details.

## Principles

- Do not hard-code API keys.
- Keep auth in the server-side Liclick / Atlas gateway session and local secure cookies.
- Keep request/response contracts typed.
- Keep offline fallbacks explicit and remove frontend mock services once real server routes own the workflow.

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

## Generate Panel Mode Boundary

The Generate panel exposes two user-facing modes:

- `Liclick`: calls the authenticated Liclick image API and returns a normal generated image. The preview toolbar keeps the `Add to references` shortcut for this exploratory generation path.
- `Texture Map`: captures the current model view, combines it with exactly one selected material reference, and submits a strict shape-preserving prompt. The preview toolbar hides `Add to references`; users accept a usable result with `Add as Projected Layer` so the texture output remains layer/source data instead of becoming a material reference.

Liclick mode no longer requires a user-entered prompt at the UI boundary. Texture Map mode also allows an empty user prompt, but the client combines any optional user prompt with an internal shape-preserving material-transfer prompt before submission. Texture Map still requires one material reference; if none is selected the UI warns and does not submit.

## generateTextureSingleView

Inputs: optional prompt, one material reference, selected object id, capture id, resolution, visible-only flag, and upscale flag.

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

`GeneratePanel` first captures a clean current-model reference image, stores it as an in-memory reference ahead of the material reference, and then calls `createLiclickApiClient().generateTextureSingleView` through the authenticated server route. The returned `Generation` stores:

- `metadata.provider = "liclick-atlas"`
- `metadata.taskId`
- `metadata.model`
- `metadata.resultUrls`
- `metadata.extraParams`
- `metadata.uploadedReferences`
- `metadata.workflow = "texture-map"`
- `metadata.materialReferenceId`
- `metadata.modelViewReferenceId`
- `metadata.objectMatrixWorld`

The preview image can be opened fullscreen, downloaded, or manually added as a projected layer. It is not automatically injected as a reference.

## Account Boundary

The frontend session identifies the current Liclick user with an `httpOnly` cookie. The Atlas gateway provides the actual Liclick API access. Before image generation, the server compares the session email with the current Atlas identity email. If they do not match, `POST /api/liclick/generate-image` returns `403` and asks the user to log in again.

This prevents a local or server process from silently using another user's Atlas/Liclick account. For a Linux multi-user deployment, the process manager must also guarantee that Atlas credentials are scoped per logged-in user or replaced with a proper per-user server-side credential flow.

## Generated Asset Persistence

Liclick generation can return hosted `ai-assets.lilithgames.com` image URLs. During project autosave, the editor sends those URLs back to the workspace server through `POST /api/projects/:projectId/assets`. The server downloads the image into the authenticated user's current project asset directory and stores the project JSON with a relative workspace asset path.

For security, remote asset import is HTTPS-only and host allowlisted. The default allowlist includes `ai-assets.lilithgames.com`; add extra hosts with `LICLICK_ALLOWED_REMOTE_ASSET_HOSTS` only when they are trusted image asset domains.

## Inpaint

Inputs: prompt, mask, base image, and selected object.

Local repaint reuses the same authenticated Atlas/Liclick gateway configuration as normal image generation. The server first attempts `generate_image` with an `extra_params` object that mirrors the LiClick web editor's `/ai-video/image-task/submit` task payload:

- backend/model: `comfyui`
- pipeline: `局部重绘_volcengine`
- request type: `single_image`
- params: `需要重绘的图`, `输入图片蒙版`, `正向提示`, `重绘幅度`, `seed`
- ext infos: `task_type=edit`, `edit_type=inpaint`

LiClick's web editor uses base64 `{ data, type }` image entries for this workflow, and the adapter sends the same shape through the Atlas JSON-RPC gateway using `callAtlasToolJson`. This direct JSON-RPC helper reads the local Atlas token cache and avoids command-line argument size limits for base64 image payloads. It does not expose Atlas tokens to the browser.

Important boundary: the LiClick web page can call its own `/ai-video/image-task/submit` path directly with a web `id_token`; our desktop app calls the Atlas `generate_image` tool. If the Atlas tool rejects this custom ComfyUI workflow, the adapter falls back to the officially supported `gpt-image-2` image edit path: it uploads the base image and mask through `upload_asset`, passes both as `reference_images`, and adds a strict prompt telling the model to modify only the white mask region. The client still composites the returned image back through the local mask, so unmasked pixels remain protected on our side.

The matching poll request uses the existing `get_task_status(task_type=image)` path. There is no separate browser token or API-key setup for local repaint.

For current-view local repaint, the client sends a transparent-background viewport render plus a black/white mask. The mask is clipped to the visible model alpha before submission, so repaint strokes cannot target the editor background. The returned image is composited back only inside the edit mask, while protected/unmasked pixels preserve the original projection relationship.

## Normal Generation

Inputs: basecolor or prompt/image pair. Output should identify normal coordinate space.

## Multiview

Inputs: multiple camera snapshots and captures. Output should preserve per-view images and consistency metadata.

## Offline Fallbacks

The old frontend `mockGenerationService.ts` has been removed because generation now goes through the authenticated server-side Atlas adapter. The mock project gallery remains as an offline homepage fallback only. API keys, Atlas tokens, and endpoints must never be committed or passed to frontend code.
