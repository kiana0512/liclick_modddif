# Export Matrix

Phase 7 changes Export from a mostly placeholder menu into a usable MVP export matrix.

## Menu Groups

Scene:

- Viewport PNG: implemented.
- GLB: implemented.
- FBX: implemented with the local binary FBX writer.
- OBJ: implemented.
- STL: implemented.

Object:

- GLB: implemented for the selected imported object.
- FBX: implemented for the selected imported object.
- OBJ: implemented for the selected imported object.
- STL: implemented for the selected imported object.

Texture:

- Color: downloads the current baked BaseColor when available.
- Normal: downloads the model material normal map when one exists.
- Segments (ColorID): coming soon.

Video:

- Turntable video: implemented as WebM when `MediaRecorder` is available.

## Current MVP Behavior

Scene / Object export uses `GLTFExporter`, `OBJExporter`, and `STLExporter` from the existing Three.js ecosystem dependency `three-stdlib`. FBX export uses the local binary writer in `exportFbx.ts` because Three.js does not ship a stable official FBX exporter. The exporter receives the imported model root rather than the full viewport helper scene, so grid and editor lights are not included in model files.

Texture / Color exports the active baked BaseColor PNG. Texture / Normal is enabled only when the imported material exposes `normalMap`.

GLB, FBX, and OBJ model exports run through `prepareTexturedModelExport`. That helper finds an exact baked stack texture or, when Auto UV bake is enabled, bakes the current visible projected stack before export. It then composites visible UV repair/merged layers over that base texture, clones the export root, and applies a `Liclick_BaseColor` material. OBJ writes the PNG beside the `.obj/.mtl`; GLB embeds the material through `GLTFExporter`; FBX embeds mesh/material/texture records in the local binary FBX file.

Turntable WebM records the WebGL canvas stream for 5 seconds while rotating the imported model 360 degrees. Browsers without `MediaRecorder` show the action disabled.

## Still Unsupported

- Segments ColorID export remains disabled until real segmentation data exists.
- MP4 export is not included in this phase; WebM is the browser-native MVP.
- Portable project package zip remains a server-side follow-up.

## Next Export Work

The next export pass should harden FBX compatibility in more DCCs, add segmentation ColorID export, and add a `.liclick3d` portable package once the project package endpoint is implemented.
