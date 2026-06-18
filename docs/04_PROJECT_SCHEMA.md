# Project Schema

Liclick projects should serialize to a `project.liclick.json` document plus asset files for models, references, captures, generations, layers, baked textures, and thumbnails.

```json
{
  "id": "project-id",
  "name": "Project name",
  "createdAt": "2026-06-18T00:00:00.000Z",
  "updatedAt": "2026-06-18T00:00:00.000Z",
  "thumbnail": "assets/thumb.png",
  "objects": [],
  "references": [],
  "captures": [],
  "generations": [],
  "layers": [],
  "bakedTextures": [],
  "workspaceName": "Client concepts",
  "workspaceMode": "file-system-access",
  "lastSavedAt": "2026-06-18T00:00:00.000Z",
  "dirty": false,
  "assetManifest": {
    "models": [],
    "references": [],
    "generations": [],
    "layers": [],
    "baked": []
  },
  "settings": {}
}
```

## Objects

Objects track id, name, type, sourcePath, format, meshCount, materialSlots, uvSets, transform, visible, and selected.

Phase 4 objects can also include:

- `originalBoundingBox`: unmodified source bounds before import normalization.
- `boundingBox`: bounds after normalization.
- `importNormalizationTransform`: the parent transform applied during import normalization.
- `userTransform`: the live transform after Move / Rotate / Scale edits.

Imported model geometry should not be rewritten during normalization.

## References

References track id, name, url, width, height, and primary state.

## Captures

Captures store object id, camera snapshot, colorUrl, maskUrl, depthUrl, normalUrl, and createdAt.

## Generations

Generations store mode, prompt, negative prompt, references, capture id, result URL, status, and metadata.

## Layers

Layers store id, name, type, image URL, mask URL, object id, camera snapshot, visibility, opacity, blend mode, order, and createdAt.

Phase 3 projected layers can also store `isBaked`, `bakedTextureId`, `bakedAt`, and `needsRebake`.

## Baked Textures

Baked textures store id, object id, source layer id, image URL, width, height, PNG format, createdAt, coverageRatio, and a bake report. The bake report includes triangle counts, covered/skipped pixels, warnings, and duration.

## Settings

Settings include resolution, display mode, projection mode, and color management.

## Compatibility

Every persisted project should include schema version metadata before real save/load ships. Add migrations instead of breaking old project files.

## Save / Load

Phase 2 added browser-only JSON export and import. Phase 4 adds local workspace persistence:

- `exportProjectJson(project)` creates a JSON Blob.
- `downloadProjectJson(project)` downloads the file from the toolbar.
- `importProjectJson(file)` reads a local JSON file and validates the basic project shape.
- `validateProjectJson(data)` rejects invalid project documents before they enter stores.
- `saveProjectAsWorkspace(project)` asks for a directory with the File System Access API.
- `saveProjectToWorkspace(project, handle)` writes `project.liclick.json` and asset folders.
- `loadProjectWithPicker()` reads a selected `.liclick.json` file.

Saved metadata includes project id/name, object metadata, references, captures, generations, layers, settings, and timestamps.

## Workspace Layout

```text
project.liclick.json
assets/
  models/
  references/
  captures/
  generations/
  layers/
  baked/
  thumbnails/
```

Data URLs and blob URLs are materialized into files where possible and replaced by relative paths in the saved project document. If the app loads a project with missing relative assets, it should warn the user and keep the project metadata intact.

## Fallback Behavior

File System Access is browser-dependent. If directory save is unavailable, Save and Save As fall back to downloading JSON. Browser blob URLs are session-scoped and may be invalid after reload or on another machine, so the workspace folder path is the preferred persistence path for current MVP testing.
