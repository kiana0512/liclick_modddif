# DCC validation scripts

Reusable Blender and 3ds Max import/smoke scripts live here. Pass source and output paths at invocation time; generated FBX files, reports, logs, and screenshots belong in the ignored `workspace/` tree or another temporary directory.

Examples:

```powershell
blender --background --python scripts/validation/dcc/blender-fbx-import-check.py -- --fbx C:\path\model.fbx --out workspace\blender-import.json
blender --background --python scripts/validation/dcc/blender-reexport-fbx.py -- --source C:\path\model.fbx --target workspace\blender-reexport.fbx
3dsmaxbatch.exe scripts/validation/dcc/max-fbx-import-check.ms -mxsString fbx:C:\path\model.fbx -mxsString out:workspace\max-import.txt
```
