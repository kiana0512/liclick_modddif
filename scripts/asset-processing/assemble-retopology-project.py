"""Assemble user models into a Li3D V4 retopology project.

The Asset V4 worker requires high/reference/current roles. For the
default single-high-model workflow, Li3D creates deterministic low-poly
bootstrap roles locally so users do not have to prepare two throwaway meshes.
"""

import argparse
import hashlib
import json
import os
import sys
import traceback

import bpy
import mathutils


ROLE_NAMES = {
    "high": "high",
    "reference": "reference_low",
    "current": "current_low",
}
GENERATED_LOW_NAME = "generated_low_v001"
SUPPORTED_EXTENSIONS = {".fbx", ".obj", ".glb", ".gltf", ".blend"}


def parse_arguments():
    parser = argparse.ArgumentParser()
    parser.add_argument("--high", required=True)
    parser.add_argument("--target-faces", type=int, default=500)
    parser.add_argument("--output", required=True)
    parser.add_argument("--manifest", required=True)
    script_arguments = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    return parser.parse_args(script_arguments)


def sha256_file(file_path):
    digest = hashlib.sha256()
    with open(file_path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def clear_factory_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)


def import_source(file_path):
    extension = os.path.splitext(file_path)[1].lower()
    if extension not in SUPPORTED_EXTENSIONS:
        raise RuntimeError(f"Unsupported model format: {extension or '(none)'}")

    if extension == ".fbx":
        bpy.ops.import_scene.fbx(filepath=file_path)
    elif extension == ".obj":
        bpy.ops.wm.obj_import(filepath=file_path)
    elif extension in {".glb", ".gltf"}:
        bpy.ops.import_scene.gltf(filepath=file_path)
    elif extension == ".blend":
        with bpy.data.libraries.load(file_path, link=False) as (
            data_from,
            data_to,
        ):
            data_to.objects = list(data_from.objects)
        for imported_object in data_to.objects:
            if imported_object is not None:
                bpy.context.scene.collection.objects.link(imported_object)


def world_bounds(mesh_object):
    corners = [
        mesh_object.matrix_world @ mathutils.Vector(corner)
        for corner in mesh_object.bound_box
    ]
    minimum = [min(corner[index] for corner in corners) for index in range(3)]
    maximum = [max(corner[index] for corner in corners) for index in range(3)]
    return {
        "min": minimum,
        "max": maximum,
        "size": [maximum[index] - minimum[index] for index in range(3)],
    }


def combined_world_bounds(mesh_objects):
    corners = [
        mesh_object.matrix_world @ mathutils.Vector(corner)
        for mesh_object in mesh_objects
        for corner in mesh_object.bound_box
    ]
    minimum = [min(corner[index] for corner in corners) for index in range(3)]
    maximum = [max(corner[index] for corner in corners) for index in range(3)]
    return {
        "min": minimum,
        "max": maximum,
        "size": [maximum[index] - minimum[index] for index in range(3)],
    }


def bounds_match(before, after):
    values = before["min"] + before["max"] + after["min"] + after["max"]
    tolerance = max(1.0, *(abs(value) for value in values)) * 1e-5
    return all(
        abs(before[key][index] - after[key][index]) <= tolerance
        for key in ("min", "max")
        for index in range(3)
    )


def matrix_rows(matrix):
    return [[float(value) for value in row] for row in matrix]


def import_role(role, file_path):
    before_ids = {obj.as_pointer() for obj in bpy.context.scene.objects}
    import_source(file_path)
    imported_objects = [
        obj for obj in bpy.context.scene.objects if obj.as_pointer() not in before_ids
    ]
    mesh_objects = [obj for obj in imported_objects if obj.type == "MESH"]

    if not mesh_objects:
        raise RuntimeError(f"{role} model does not contain a mesh object.")

    unsafe_meshes = [
        obj.name
        for obj in mesh_objects
        if obj.modifiers or obj.constraints or obj.data.shape_keys is not None
    ]
    if unsafe_meshes:
        raise RuntimeError(
            f"{role} model contains rigged, constrained, modified, or shape-key meshes "
            f"that cannot be safely joined: {', '.join(unsafe_meshes[:8])}."
        )

    auxiliary_objects = [obj for obj in imported_objects if obj.type != "MESH"]
    auxiliary_manifest = [
        {"name": obj.name, "type": obj.type}
        for obj in auxiliary_objects
    ]
    unsafe_auxiliary = [
        obj.name
        for obj in auxiliary_objects
        if obj.type not in {"EMPTY", "CAMERA", "LIGHT"}
        or (obj.type == "EMPTY" and obj.instance_type != "NONE")
    ]
    if unsafe_auxiliary:
        raise RuntimeError(
            f"{role} model contains non-mesh geometry, armatures, or instances "
            f"that cannot be safely removed: {', '.join(unsafe_auxiliary[:8])}."
        )

    source_meshes = [
        {
            "name": obj.name,
            "vertices": len(obj.data.vertices),
            "polygons": len(obj.data.polygons),
            "world_matrix": matrix_rows(obj.matrix_world),
            "world_bounds": world_bounds(obj),
        }
        for obj in mesh_objects
    ]
    source_object_names = [obj.name for obj in imported_objects]
    before_bounds = combined_world_bounds(mesh_objects)
    source_vertex_count = sum(len(obj.data.vertices) for obj in mesh_objects)
    source_polygon_count = sum(len(obj.data.polygons) for obj in mesh_objects)

    for obj in mesh_objects:
        world_matrix = obj.matrix_world.copy()
        obj.parent = None
        obj.matrix_world = world_matrix
        obj.hide_set(False)
        obj.hide_viewport = False

    bpy.ops.object.select_all(action="DESELECT")
    mesh_object = mesh_objects[0]
    for obj in mesh_objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = mesh_object
    if len(mesh_objects) > 1:
        join_result = bpy.ops.object.join()
        if "FINISHED" not in join_result:
            raise RuntimeError(f"Blender could not join the {role} mesh parts.")

    for obj in auxiliary_objects:
        bpy.data.objects.remove(obj, do_unlink=True)

    if len(mesh_object.data.vertices) != source_vertex_count:
        raise RuntimeError(f"Joining the {role} mesh parts changed the vertex count.")
    if len(mesh_object.data.polygons) != source_polygon_count:
        raise RuntimeError(f"Joining the {role} mesh parts changed the polygon count.")
    after_bounds = world_bounds(mesh_object)
    if not bounds_match(before_bounds, after_bounds):
        raise RuntimeError(f"Joining the {role} mesh parts changed their world-space bounds.")

    role_name = ROLE_NAMES[role]
    conflicting_object = bpy.data.objects.get(role_name)
    if conflicting_object is not None and conflicting_object != mesh_object:
        raise RuntimeError(
            f"{role} model imports an auxiliary object named '{role_name}'. "
            "Rename it before preparing the project."
        )

    source_name = mesh_object.name
    mesh_object.name = role_name
    if mesh_object.name != role_name:
        raise RuntimeError(f"Could not assign the required object name '{role_name}'.")

    mesh_object["li3d_role"] = role
    mesh_object["li3d_source_object_name"] = source_name
    mesh_object["li3d_source_object_names"] = json.dumps(
        [item["name"] for item in source_meshes],
        ensure_ascii=False,
    )
    mesh_object["li3d_source_sha256"] = sha256_file(file_path)

    return {
        "role": role,
        "object_name": role_name,
        "source_object_name": source_name,
        "source_mesh_count": len(source_meshes),
        "source_mesh_names": [item["name"] for item in source_meshes],
        "source_object_count": len(imported_objects),
        "source_object_names": source_object_names,
        "source_meshes": source_meshes,
        "removed_auxiliary_objects": auxiliary_manifest,
        "joined_meshes": len(source_meshes) > 1,
        "source_sha256": mesh_object["li3d_source_sha256"],
        "vertices": len(mesh_object.data.vertices),
        "polygons": len(mesh_object.data.polygons),
        "world_matrix": matrix_rows(mesh_object.matrix_world),
        "world_bounds": after_bounds,
        "imported_object_count": len(imported_objects),
    }


def create_bootstrap_role(role, source_object, source_manifest, target_faces):
    role_name = ROLE_NAMES[role]
    if bpy.data.objects.get(role_name) is not None:
        raise RuntimeError(f"Could not create bootstrap object '{role_name}': name is already used.")

    mesh_object = source_object.copy()
    mesh_object.data = source_object.data.copy()
    bpy.context.scene.collection.objects.link(mesh_object)
    mesh_object.name = role_name
    if mesh_object.name != role_name:
        raise RuntimeError(f"Could not assign the required object name '{role_name}'.")

    source_polygon_count = len(mesh_object.data.polygons)
    if source_polygon_count == 0:
        raise RuntimeError(f"Cannot create {role} bootstrap from an empty mesh.")

    if source_polygon_count > target_faces:
        bpy.ops.object.select_all(action="DESELECT")
        mesh_object.select_set(True)
        bpy.context.view_layer.objects.active = mesh_object
        modifier = mesh_object.modifiers.new(name="Li3D Bootstrap Decimate", type="DECIMATE")
        modifier.decimate_type = "COLLAPSE"
        modifier.ratio = max(0.0001, min(1.0, target_faces / source_polygon_count))
        if hasattr(modifier, "use_collapse_triangulate"):
            modifier.use_collapse_triangulate = True
        apply_result = bpy.ops.object.modifier_apply(modifier=modifier.name)
        if "FINISHED" not in apply_result:
            raise RuntimeError(f"Blender could not create the {role} bootstrap mesh.")

    mesh_object["li3d_role"] = role
    mesh_object["li3d_bootstrap_generated"] = True
    mesh_object["li3d_bootstrap_method"] = "decimate"
    mesh_object["li3d_bootstrap_target_faces"] = target_faces
    mesh_object["li3d_source_sha256"] = source_manifest["source_sha256"]

    return {
        "role": role,
        "object_name": role_name,
        "source_object_name": source_manifest["source_object_name"],
        "source_mesh_count": source_manifest["source_mesh_count"],
        "source_mesh_names": source_manifest["source_mesh_names"],
        "source_object_count": source_manifest["source_object_count"],
        "source_object_names": source_manifest["source_object_names"],
        "source_meshes": source_manifest["source_meshes"],
        "removed_auxiliary_objects": source_manifest["removed_auxiliary_objects"],
        "joined_meshes": source_manifest["joined_meshes"],
        "source_sha256": source_manifest["source_sha256"],
        "vertices": len(mesh_object.data.vertices),
        "polygons": len(mesh_object.data.polygons),
        "world_matrix": matrix_rows(mesh_object.matrix_world),
        "world_bounds": world_bounds(mesh_object),
        "imported_object_count": 0,
        "bootstrap_generated": True,
        "bootstrap_method": "decimate",
        "bootstrap_source_role": source_manifest["role"],
        "bootstrap_source_polygons": source_polygon_count,
        "bootstrap_target_faces": target_faces,
    }


def write_json_atomic(file_path, payload):
    partial_path = f"{file_path}.partial"
    with open(partial_path, "w", encoding="utf-8") as stream:
        json.dump(payload, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    os.replace(partial_path, file_path)


def save_blend_atomic(file_path):
    partial_path = f"{file_path}.partial.blend"
    if os.path.exists(partial_path):
        os.remove(partial_path)
    bpy.ops.wm.save_as_mainfile(
        filepath=partial_path,
        check_existing=False,
        compress=False,
    )
    if not os.path.isfile(partial_path):
        raise RuntimeError("Blender did not create the prepared project.")
    os.replace(partial_path, file_path)


def main():
    arguments = parse_arguments()
    if arguments.target_faces < 50 or arguments.target_faces > 5000:
        raise RuntimeError("Target faces must be from 50 to 5000.")
    output_path = os.path.abspath(arguments.output)
    manifest_path = os.path.abspath(arguments.manifest)
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    os.makedirs(os.path.dirname(manifest_path), exist_ok=True)

    clear_factory_scene()
    high_role = import_role("high", os.path.abspath(arguments.high))
    high_object = bpy.data.objects[ROLE_NAMES["high"]]

    reference_role = create_bootstrap_role(
        "reference",
        high_object,
        high_role,
        arguments.target_faces,
    )
    reference_object = bpy.data.objects[ROLE_NAMES["reference"]]

    current_role = create_bootstrap_role(
        "current",
        reference_object,
        reference_role,
        arguments.target_faces,
    )

    roles = [high_role, reference_role, current_role]

    if bpy.data.objects.get(GENERATED_LOW_NAME) is not None:
        raise RuntimeError(
            f"An imported source already uses the reserved name '{GENERATED_LOW_NAME}'."
        )

    scene = bpy.context.scene
    scene["li3d_retopology_schema"] = "v4"
    scene["li3d_high_object"] = ROLE_NAMES["high"]
    scene["li3d_reference_object"] = ROLE_NAMES["reference"]
    scene["li3d_low_object"] = ROLE_NAMES["current"]
    scene["li3d_generated_low_object"] = GENERATED_LOW_NAME
    scene["li3d_bootstrap_mode"] = True
    scene["li3d_bootstrap_target_faces"] = arguments.target_faces

    manifest = {
        "schema": "li3d-retopology-project-v4",
        "blender_version": bpy.app.version_string,
        "object_map": {
            "high_object": ROLE_NAMES["high"],
            "reference_object": ROLE_NAMES["reference"],
            "low_object": ROLE_NAMES["current"],
            "generated_low_object": GENERATED_LOW_NAME,
        },
        "bootstrap_mode": True,
        "bootstrap_target_faces": arguments.target_faces,
        "roles": roles,
    }
    save_blend_atomic(output_path)
    write_json_atomic(manifest_path, manifest)
    print("LI3D_PREP_OK:" + json.dumps(manifest["object_map"], separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"LI3D_PREP_ERROR:{error}", file=sys.stderr)
        traceback.print_exc()
        sys.exit(1)
