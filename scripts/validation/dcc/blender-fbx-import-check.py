import argparse
import json
import mathutils
import os
import sys

import bpy


def world_bbox(obj):
    corners = [obj.matrix_world @ mathutils.Vector(corner) for corner in obj.bound_box]
    mn = [min(corner[i] for corner in corners) for i in range(3)]
    mx = [max(corner[i] for corner in corners) for i in range(3)]
    return mn, mx, [mx[i] - mn[i] for i in range(3)]


def texture_paths(mat):
    paths = []
    if not mat or not mat.use_nodes:
        return paths
    for node in mat.node_tree.nodes:
        if node.type == "TEX_IMAGE" and node.image:
            paths.append({
                "name": node.name,
                "image": node.image.name,
                "filepath": node.image.filepath,
                "has_data": bool(node.image.has_data),
                "size": list(node.image.size),
            })
    return paths


parser = argparse.ArgumentParser()
parser.add_argument("--fbx", required=True)
parser.add_argument("--out", required=True)
script_args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
args = parser.parse_args(script_args)

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete()

result = {"input": args.fbx, "exists": os.path.exists(args.fbx)}
try:
    bpy.ops.import_scene.fbx(filepath=args.fbx)
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    result["mesh_count"] = len(meshes)
    result["object_count"] = len(bpy.context.scene.objects)
    result["objects"] = []
    global_min = [float("inf")] * 3
    global_max = [float("-inf")] * 3
    for obj in meshes:
        mn, mx, size = world_bbox(obj)
        for i in range(3):
            global_min[i] = min(global_min[i], mn[i])
            global_max[i] = max(global_max[i], mx[i])
        mats = []
        for slot in obj.material_slots:
            mat = slot.material
            mats.append({
                "name": mat.name if mat else None,
                "blend_method": getattr(mat, "blend_method", None) if mat else None,
                "alpha": getattr(mat, "alpha_threshold", None) if mat else None,
                "textures": texture_paths(mat),
            })
        result["objects"].append({
            "name": obj.name,
            "scale": list(obj.scale),
            "dimensions": list(obj.dimensions),
            "bbox_min": mn,
            "bbox_max": mx,
            "bbox_size": size,
            "materials": mats,
        })
    if meshes:
        result["bbox_min"] = global_min
        result["bbox_max"] = global_max
        result["bbox_size"] = [global_max[i] - global_min[i] for i in range(3)]
except Exception as exc:
    result["error"] = repr(exc)

with open(args.out, "w", encoding="utf-8") as stream:
    json.dump(result, stream, ensure_ascii=False, indent=2)
