# Project Schema

Liclick projects should serialize to a `project.json` document plus asset files for models, references, captures, generations, and baked textures.

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
  "settings": {}
}
```

## Objects

Objects track id, name, type, sourcePath, format, materialSlots, uvSets, transform, visible, and selected.

## References

References track id, name, url, width, height, and primary state.

## Captures

Captures store object id, camera snapshot, colorUrl, maskUrl, depthUrl, normalUrl, and createdAt.

## Generations

Generations store mode, prompt, negative prompt, references, capture id, result URL, status, and metadata.

## Layers

Layers store id, name, type, image URL, mask URL, object id, camera snapshot, visibility, opacity, blend mode, order, and createdAt.

## Settings

Settings include resolution, display mode, projection mode, and color management.

## Compatibility

Every persisted project should include schema version metadata before real save/load ships. Add migrations instead of breaking old project files.
