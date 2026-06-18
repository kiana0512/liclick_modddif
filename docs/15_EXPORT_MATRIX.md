# Export Matrix

Phase 7 changes Export from a mostly placeholder menu into a usable MVP export matrix.

## Menu Groups

Scene:

- Viewport PNG: implemented.
- GLB: implemented.
- FBX: coming soon / PRO badge.
- OBJ: implemented.
- STL: implemented.

Object:

- GLB: implemented for the selected imported object.
- FBX: coming soon / PRO badge.
- OBJ: implemented for the selected imported object.
- STL: implemented for the selected imported object.

Texture:

- Color: downloads the current baked BaseColor when available.
- Normal: downloads the model material normal map when one exists.
- Segments (ColorID): coming soon.

Video:

- Turntable video: implemented as WebM when `MediaRecorder` is available.

## Current MVP Behavior

Scene / Object export uses `GLTFExporter`, `OBJExporter`, and `STLExporter` from the existing Three.js ecosystem dependency `three-stdlib`. The exporter receives the imported model root rather than the full viewport helper scene, so grid and editor lights are not included in model files.

Texture / Color exports the active baked BaseColor PNG. Texture / Normal is enabled only when the imported material exposes `normalMap`.

Turntable WebM records the WebGL canvas stream for 5 seconds while rotating the imported model 360 degrees. Browsers without `MediaRecorder` show the action disabled.

## Still Unsupported

- FBX export remains disabled because Three.js does not provide a stable official FBX exporter.
- Segments ColorID export remains disabled until real segmentation data exists.
- MP4 export is not included in this phase; WebM is the browser-native MVP.
- Portable project package zip remains a server-side follow-up.

## Next Export Work

The next export pass should assign baked `baseColorTexture` records onto exported GLB materials and add a `.liclick3d` portable package once the project package endpoint is implemented.
