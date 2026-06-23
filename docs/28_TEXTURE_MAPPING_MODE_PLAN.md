# Texture Map Mode Plan

Texture Map mode is the clean-room path for the Modddif-like workflow: reference images describe the material, while the current MVP viewport model view describes object shape, pose, camera, and visible surface layout.

This mode must not be treated as generic Liclick image generation. The required output is an aligned transparent projected texture layer that can be previewed on the model, adjusted in the layer stack, and baked into UV space.

## Problem

The current Liclick image path returns a normal RGB image. It can look visually useful, but it has three structural problems for texture work:

- The generated object may not match the exact current model silhouette, camera angle, or visible surface layout.
- The returned image usually has an opaque background, while projected layers need a useful alpha/mask.
- Slow or random image generation makes iteration expensive if every alignment attempt depends only on a new remote generation.

## Mode Split

- `Liclick`: prompt and references go to the Liclick API. The result is a normal generated image and can be added manually as a projected layer.
- `Texture Map`: the app first captures the current model view and uses it as a hard spatial reference. Material references guide the surface appearance. The result should be a view-aligned RGBA projected layer.

Texture Map is enabled only as a single-view projected-layer workflow first. It is not an automatic UV bake workflow.

## Prompt Rules

- Liclick mode does not require a user prompt. If the prompt is empty, the request is still allowed to reach the server/API.
- Texture Map mode does not require a user prompt in the UI.
- Texture Map mode always has an internal default constraint prompt that says the current white/clay model view is the fixed shape, pose, camera, silhouette, and spatial reference.
- If the user writes a Texture Map prompt, append it to the internal constraint prompt as extra material direction instead of replacing the constraint prompt.

The user prompt is therefore optional guidance, not the source of truth for shape or camera alignment.

## MVP Pipeline

1. Capture the current model view:
   - fitted clay/white render that fills the reference frame by visible object extent, not by current viewport distance;
   - no floor grid, view cube, UI, environment background, or non-target scene objects in the model reference sent to Liclick;
   - selected-object mask;
   - depth;
   - normal;
   - serialized camera matrices.
   - selected object world matrix at capture time.

2. Build generation context:
   - current model view is the shape and position reference;
   - Texture Map mode accepts one selected material reference image;
   - prompt describes the desired material transfer, not a free object redesign.

3. Generate or transform the image:
   - current first step: submit model-view capture plus one material reference to the available Liclick image API with a strict internal prompt;
   - better path: use an image-to-image or inpaint-style server pipeline that can condition on mask/depth/normal.

4. Produce alpha:
   - start from the captured selected-object mask as the alpha matte;
   - trim or feather edges to avoid hard halos;
   - reject pixels outside the projector frustum, failed depth, or backfaces during projection.

5. Create a projected layer:
   - store the RGBA image;
   - store the mask/depth/camera snapshot;
   - store the object world matrix snapshot from generation time;
   - preview it through the existing projected-layer shader;
   - let the layer stack control opacity and visibility.

Projected layer creation must stay user-confirmed. Texture Map generation should put the result in the preview area first. Users click `Add as Projected Layer` only when the result is good enough.

6. Bake:
   - use the existing UV bake path to write the accepted projected samples into BaseColor;
   - only write texels visible from the generation projector after frustum, RGB mask, depth, source alpha, and backface gates pass;
   - leave all unseen or rejected texels alpha 0 so the exported PNG shows checkerboard transparency in image editors;
   - preserve the projected layer as editable source metadata.

## Alpha Strategy

For the first working version, alpha should come from geometry, not from the AI output:

- Use the current capture mask as the base alpha.
- Treat the mask as RGB luminance, not image alpha. Capture passes use opaque black background, so mask alpha cannot be used for validity.
- Use depth and backface gates to avoid painting through the model.
- Feather only near mask boundaries.
- Keep the original opaque generated image as RGB, but ignore background pixels outside the model mask.

This avoids depending on the remote API to return a transparent PNG. It will not solve AI silhouette drift perfectly, but it gives us a deterministic MVP.

When no layer is present, the model should render as the white/clay material. When a projected texture exists, surfaces without aligned texture coverage should show a transparent checker/grid-style missing-coverage state so artists can see what has not been textured yet.

## Alignment Strategy

The generated image must be encouraged to keep the same object layout:

- Include the clay/current viewport capture as a reference image.
- Include exactly one user-selected material reference image in Texture Map mode. Liclick mode can keep multiple references for exploratory image generation.
- Use prompts that forbid changing silhouette, pose, camera, and object category.
- Prefer square or viewport-matched aspect ratio until projection/crop rules are stable.
- Store the exact capture camera and reuse it for projection.
- Store the object matrix from generation time. If the user rotates the viewport or transforms the model before adding the layer or baking, projection uses `capturedObjectMatrix * inverse(currentObjectMatrix)` so the texture remains aligned to the original human-visible capture state.

If the API output changes the object shape too much, the alpha mask will clip it. That is an acceptable MVP failure mode and should be reported as an alignment warning.

## Task Breakdown

### Phase A: Liclick-Conditioned Texture Map

- Allow Texture Map mode to submit one material reference plus the current model-view capture.
- Keep user prompt optional.
- Save the returned result as a preview generation, not an automatic layer.
- Store generation metadata: `workflow=texture-map`, material reference id, model-view capture id, and alpha mode.

### Phase B: Geometry Alpha

- Convert the generation-time capture mask into an alpha channel for the generated image.
- Feather alpha at boundaries.
- Store the generated RGBA as the image that becomes the projected layer.
- Preserve the original opaque output for debugging.

### Phase C: Coverage Preview

- In projected preview, show accepted projected fragments normally.
- Show uncovered or rejected fragments as white/clay or checker-grid missing coverage.
- Track coverage ratio from the projected layer and bake report.

### Phase D: Alignment Score

- Compare generated-image foreground edges against the captured model mask.
- Report a warning when silhouette drift is too high.
- Add a retry hint before users add the result as a projected layer.

### Phase E: Better Conditioning

- Replace plain image generation with an image-to-image or inpaint-style server pipeline when available.
- Use depth/normal/mask as conditioning signals.
- Add multi-view capture and view-weighted UV compositing after the single-view path is stable.

## Future Stronger Path

The production-quality route likely needs a server-side texture-transfer pipeline:

- depth/normal/mask-conditioned image-to-image;
- optional ControlNet-like conditioning if available in the deployed stack;
- foreground matte refinement;
- multi-view capture and view-weighted compositing;
- UV-space consistency checks before bake.

This is the core algorithmic work for Texture Map mode and should live under engine/server boundaries, not inside UI panels.

## Research Notes

- Modddif product docs describe this as a generated-image-to-layer workflow, where single-view generation uses the current camera view, reference images guide material/style, and Add as Layer is a user action after review: https://docs.modddif.com/
- Modddif separates projected layers from UV mapped layers and supports returning to a projected layer camera, which maps directly to our saved camera/matrix snapshot requirement: https://docs.modddif.com/
- Projective texture mapping provides the core camera/projector matrix idea for projecting a 2D image onto 3D geometry: https://en.wikipedia.org/wiki/Projective_texture_mapping
- Shadow mapping uses a light-view depth map to decide whether a fragment is visible from the projector/light. The same idea informs our depth gate: https://en.wikipedia.org/wiki/Shadow_mapping
- TEXTure uses depth-to-image generation and iterative painting across viewpoints for 3D shapes: https://arxiv.org/abs/2302.01721
- Make-A-Texture emphasizes depth-aware inpainting, view selection, and backprojection for fast shape-aware texture generation: https://arxiv.org/abs/2412.07766
- TexGen studies multi-view sampling/resampling for consistent generated textures: https://arxiv.org/abs/2408.01291
- Alpha/matting work shows why transparent extraction should be treated as an alpha problem, ideally with trimap/mask guidance instead of relying on raw RGB output: https://en.wikipedia.org/wiki/Video_matting
