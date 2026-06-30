# Texture Map Mode Plan And Current State

Texture Map mode is the clean-room path for the Modddif-like workflow: reference images describe the material, while the current MVP viewport model view describes object shape, pose, camera, and visible surface layout.

This mode must not be treated as generic Liclick image generation. The required output is an aligned transparent projected texture layer that can be previewed on the model, adjusted in the layer stack, and baked into UV space.

Current implementation status:

- Texture Map has its own Generate-panel tab and prompt state.
- The user selects exactly one material reference.
- The client captures the current model view as the first reference and sends the material reference second.
- The client builds an internal shape-preserving material-transfer prompt; user text is optional extra guidance.
- The result appears as a preview generation. `Add to references` is hidden for Texture Map results, while `Add as Projected Layer`, download, and fullscreen preview remain available.
- Accepting the result creates a projected layer with camera/object matrix metadata. If Auto UV bake is enabled, the visible stack bakes into BaseColor immediately after acceptance.
- Local foreground matting, alignment scoring, and production multi-view conditioning are still follow-up work.

## Problem

The current Liclick image path returns a normal RGB image. It can look visually useful, but it has three structural problems for texture work:

- The generated object may not match the exact current model silhouette, camera angle, or visible surface layout.
- The returned image usually has an opaque background, while projected layers need a useful alpha/mask.
- Slow or random image generation makes iteration expensive if every alignment attempt depends only on a new remote generation.

## Mode Split

- `Liclick`: prompt and references go to the Liclick API. The result is a normal generated image and can be added manually as a projected layer.
- `Texture Map`: the app first captures the current model view and uses it as a hard spatial reference. Material references guide the surface appearance. The result should be a view-aligned RGBA projected layer.

Texture Map starts as a single-view workflow: generation returns a preview first, and the user explicitly accepts it with the projected-layer action. Accepting a Texture Map result creates the projected layer from the saved generation view; UV bake runs immediately only when the global Auto UV bake setting is enabled.

## Prompt Rules

- Liclick mode does not require a user prompt. If the prompt is empty, the request is still allowed to reach the server/API.
- Texture Map mode does not require a user prompt in the UI.
- Texture Map mode always has an internal default constraint prompt that says the current white/clay model view is the fixed shape, pose, camera, silhouette, and spatial reference.
- If the user writes a Texture Map prompt, append it to the internal constraint prompt as extra material direction instead of replacing the constraint prompt.

The user prompt is therefore optional guidance, not the source of truth for shape or camera alignment.

## Algorithm Pipeline

1. Capture the current model view:
   - fitted clay/white render that fills the reference frame by visible object extent, not by current viewport distance;
   - no floor grid, view cube, UI, environment background, or non-target scene objects in the model reference sent to Liclick;
   - selected-object mask;
   - RGBA-packed depth;
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
   - remove the generated-image background with a fast connected-background matte seeded from image borders;
   - intersect that foreground matte with the generation-time selected-object RGB mask;
   - trim and feather edges to avoid hard halos;
   - reject pixels outside the projector frustum, failed depth, source alpha, or backfaces during projection.

5. Create and optionally bake a projected layer:
   - store the RGBA image;
   - store the mask/depth/camera snapshot;
   - store the object world matrix snapshot from generation time;
   - preview it through the existing projected-layer shader;
   - run UV bake from the saved projector state after the user accepts the preview when Auto UV bake is enabled;
   - let the layer stack control opacity and visibility.

Projected layer creation must stay user-confirmed. Texture Map generation should put the result in the preview area first. Users click `Add as Projected Layer` only when the result is good enough.

6. Bake rules:
   - use the existing UV bake path to write the accepted projected samples into BaseColor;
   - only write texels visible from the generation projector after frustum, RGB mask, depth, source alpha, and backface gates pass;
   - leave all unseen or rejected texels alpha 0 so the exported PNG shows checkerboard transparency in image editors;
   - preserve the projected layer as editable source metadata.

## Alpha Strategy

The alpha path must be fast and deterministic, but it cannot be geometry-only. The generated image can contain dark or white background inside the model-shaped canvas, and using only the geometry mask bakes that background into the model. Use a two-stage matte:

- Estimate the generated-image background color from border pixels and pixels outside the generation-time model mask.
- Flood fill from image borders through pixels that match the estimated background. This marks only connected background, so holes and interior material details are not erased just because they are dark.
- Convert connected background confidence into alpha, with a small feather band.
- Intersect the result with the current capture RGB mask as the hard geometry boundary.
- Treat the mask as RGB luminance, not image alpha. Capture passes use opaque black background, so mask alpha cannot be used for validity.
- Use depth and backface gates to avoid painting through the model.
- Feather only near mask boundaries.
- Keep the original opaque generated image for debugging, but the layer asset must be RGBA.

This avoids depending on the remote API to return a transparent PNG. It will not solve AI silhouette drift perfectly, so silhouette drift must become a warning metric before a user accepts the result.

When no layer is present, the model should render through the selected viewport material mode. When a projected texture exists, surfaces without aligned texture coverage should fall back to the model's base/original material in the live viewport. Missing-coverage diagnostics can exist as an explicit debug view, but they must not appear as black edges, white masks, or accidental checker artifacts in the normal editing view.

## Alignment Strategy

The generated image must be encouraged to keep the same object layout:

- Include the clay/current viewport capture as a reference image.
- Include exactly one user-selected material reference image in Texture Map mode. Liclick mode can keep multiple references for exploratory image generation.
- Use prompts that forbid changing silhouette, pose, camera, and object category.
- Prefer square or viewport-matched aspect ratio until projection/crop rules are stable.
- Store the exact capture camera and reuse it for projection.
- Store the object matrix from generation time. If the user rotates the viewport or transforms the model before adding the layer or baking, projection uses `capturedObjectMatrix * inverse(currentObjectMatrix)` so the texture remains aligned to the original human-visible capture state.

If the API output changes the object shape too much, the alpha/mask intersection will clip it. That is an alignment failure and should be reported before the user accepts the result.

## Public Algorithm Map

These public references are the closest useful routes for our clean-room implementation:

- Modddif product behavior: current camera view drives single-view generation, the user accepts the result as a layer, projected layers and UV-mapped layers are separate concepts, and projected layers can return to the original camera. This maps directly to our saved camera, object matrix, mask, depth, and layer metadata: https://docs.modddif.com/
- Projective texture mapping: a generated 2D image is treated as a projector camera and sampled on 3D surfaces through a stored projection matrix. This is the base for our projected-layer preview: https://en.wikipedia.org/wiki/Projective_texture_mapping
- Shadow mapping: visibility is decided by comparing a projected fragment against a depth map rendered from the projector. This is the base for our depth gate so hidden or back-side surfaces are not painted: https://en.wikipedia.org/wiki/Shadow_mapping
- Text2Tex: renders a mesh from a view, generates a partial texture with a depth-aware model, projects the result back, and chooses later views to refine uncovered or blurry regions: https://daveredrum.github.io/Text2Tex/
- TEXTure: uses depth-to-image generation, iterative view painting, and a trimap state to separate keep/generate/refine regions across views: https://arxiv.org/abs/2302.01721
- Make-A-Texture: combines depth-aware inpainting, automatic view selection, optimized backprojection, and rejection of non-frontal/internal faces. The non-frontal rejection is especially relevant to our backface and normal gates: https://arxiv.org/abs/2412.07766
- TexGen: studies multi-view sampling and resampling for texture consistency. This informs the future multi-view path, not the current single-view acceptance path: https://arxiv.org/abs/2408.01291
- Paint3D: open-source diffusion texture generation that separates lighting-less appearance from geometry-conditioned texture synthesis: https://github.com/OpenTexture/Paint3D
- Fantasia3D: open-source text-to-3D work that explicitly separates geometry and appearance. The separation reinforces our rule that Liclick's material reference must not redefine geometry: https://github.com/Gorilla-Lab-SCUT/Fantasia3D
- xatlas: public UV unwrapping/atlas generation. If user models do not have usable UVs, this is the kind of library we need before high-quality bake export: https://github.com/jpcy/xatlas
- three-mesh-bvh: fast triangle ray queries for Three.js. This is a good future replacement or validation path for CPU-side occlusion/depth checks during bake: https://github.com/gkjohnson/three-mesh-bvh
- OpenMVS texture mesh pipeline: a public multi-view reconstruction/texturing stack that is useful for studying view scoring, visibility, and texture atlas assignment: https://github.com/cdcseacave/openMVS

The common structure is not "paste an image on the screen." It is:

1. Render geometry state from a chosen camera.
2. Condition generation with that geometry state.
3. Save camera, object matrix, mask, depth, and normal at generation time.
4. Extract a clean foreground RGBA result.
5. Project only pixels that pass frustum, mask, depth, source-alpha, and front-facing checks.
6. Bake only those accepted samples into UV space.
7. Leave every unseen or rejected texel transparent.

## Task Breakdown

### Phase A: Liclick-Conditioned Texture Map

Status: implemented as the current single-view Texture Map path.

- Allow Texture Map mode to submit one material reference plus the current model-view capture.
- Keep user prompt optional.
- Save the returned result as a preview generation, not an automatic layer.
- Store generation metadata: `workflow=texture-map`, material reference id, model-view capture id, and alpha mode.

### Phase B: Guided Foreground Alpha

Status: partially implemented through current matte/cutout utilities, but still not a full production foreground-alpha pipeline.

- Convert the generated RGB output into RGBA with connected-background matting.
- Intersect the foreground matte with the generation-time capture RGB mask.
- Feather only the accepted foreground boundary.
- Store the generated RGBA as the image that becomes the projected layer.
- Preserve the original opaque output for debugging.

### Phase C: Coverage Preview

Status: mostly implemented. Projected preview and UV bake fall back to the model/base material for uncovered fragments. Automatic bake depends on the global Auto UV bake setting.

- In projected preview, show accepted projected fragments normally.
- Show uncovered or rejected fragments through the base/original material in normal editing mode.
- Track coverage ratio from the projected layer and bake report.
- Adding a Texture Map result as a projected layer should automatically run UV bake from the saved projector state when Auto UV bake is enabled; when it is off, the layer remains a live projection preview.

### Phase D: Alignment Score

- Compare generated-image foreground edges against the captured model mask.
- Report a warning when silhouette drift is too high.
- Add a retry hint before users add the result as a projected layer.

### Phase E: Better Conditioning

- Replace plain image generation with an image-to-image or inpaint-style server pipeline when available.
- Use depth/normal/mask as conditioning signals.
- Add multi-view capture and view-weighted UV compositing after the single-view path is stable.

### Phase F: Robust UV Export

- Detect missing or broken UVs before bake.
- Add an atlas unwrap path for models without usable UVs.
- Move heavy bake and visibility checks to a worker when resolution or triangle count grows.
- Add optional BVH ray validation for occlusion on complex geometry.

## Acceptance Tests

- The white/clay model reference sent to Liclick fills the frame by visible object extent, not by camera distance.
- The white/clay model reference contains no floor grid, view cube, UI, scene background, or material texture.
- Texture Map mode submits the model reference first and the single material reference second.
- Generated preview can be opened fullscreen.
- The projected-layer action is compact icon UI with hover labels, not a large text button over the preview.
- Adding a Texture Map result creates the projected layer and immediately bakes it only when Auto UV bake is enabled.
- Rotating the viewport after generation but before adding the layer must not change projection alignment.
- Transforming the object after generation must still align through the captured object matrix delta.
- Mask alpha is never used as mask validity; RGB mask luminance is the validity source.
- Source pixels with alpha 0 or near-transparent edge residue must never bake.
- Depth capture and UV bake use the same RGBA-packed depth decoding path.
- Backfaces, failed depth samples, and pixels outside the generation mask must not overwrite valid projected samples.
- UV texels for unseen model parts should remain inspectable without creating black/white viewport artifacts; current viewport-ready BaseColor output fills unprojected texels with a neutral material color after projection coverage has been decided.

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
