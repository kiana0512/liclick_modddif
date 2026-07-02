import bpy

source = r"C:\Users\rentian\AppData\Local\Temp\max-test-current.fbx"
target = r"E:\Liclick 3D Texture\workspace\blender-reexport-reference.fbx"

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete()
bpy.ops.import_scene.fbx(filepath=source)
bpy.ops.export_scene.fbx(
    filepath=target,
    path_mode="COPY",
    embed_textures=True,
    add_leaf_bones=False,
    bake_anim=False,
)
