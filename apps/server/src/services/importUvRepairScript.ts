// IMPORT-UV-REPAIR v1.0.0. Bundled with the server; never execute uploaded scripts.
export const importUvRepairScript = String.raw`
import bpy, bmesh, json, math, sys
from mathutils import Vector

source, target = sys.argv[sys.argv.index('--') + 1:]
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=source)
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
if not meshes:
    raise RuntimeError('模型没有可展开的网格')
for obj in meshes:
    if obj.modifiers or obj.data.shape_keys:
        raise RuntimeError('暂不支持自动修复带骨骼或形态键的模型')
    obj.data = obj.data.copy()
    if not obj.data.uv_layers:
        obj.data.uv_layers.new(name='UVMap')
    obj.data.uv_layers.active_index = 0
    obj.data.uv_layers[0].active_render = True
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    for edge in bm.edges:
        edge.seam = edge.seam or len(edge.link_faces) != 2 or edge.calc_face_angle(0) > math.radians(66)
    bm.to_mesh(obj.data)
    bm.free()
bpy.ops.object.select_all(action='DESELECT')
for obj in meshes:
    obj.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.uv.unwrap(method='ANGLE_BASED', margin=0.001)
bpy.ops.uv.average_islands_scale()
bpy.ops.uv.pack_islands(margin=0.001)
bpy.ops.object.mode_set(mode='OBJECT')
# Correct only insufficient outer clearance, keeping all islands mutually aligned.
coords = [loop.uv for obj in meshes for loop in obj.data.uv_layers[0].data]
lo = Vector((min(p.x for p in coords), min(p.y for p in coords)))
hi = Vector((max(p.x for p in coords), max(p.y for p in coords)))
epsilon = 1e-6
if lo.x < epsilon or lo.y < epsilon or hi.x > 1-epsilon or hi.y > 1-epsilon:
    extent = max(hi.x-lo.x, hi.y-lo.y)
    if not math.isfinite(extent) or extent <= 0:
        raise RuntimeError('展开后 UV 范围无效')
    scale = min(1.0, (1-2*epsilon)/extent)
    shift = Vector((max(epsilon-lo.x*scale, min(0, 1-epsilon-hi.x*scale)),
                    max(epsilon-lo.y*scale, min(0, 1-epsilon-hi.y*scale))))
    for p in coords:
        p[:] = p*scale + shift

def validate(objects):
    triangles = 0
    for obj in objects:
        mesh = obj.data
        mesh.calc_loop_triangles()
        uv = mesh.uv_layers[0].data
        for tri in mesh.loop_triangles:
            a,b,c = [uv[i].uv for i in tri.loops]
            if any(not math.isfinite(x) or x < 0 or x > 1 for p in (a,b,c) for x in p):
                raise RuntimeError('修复后 UV 仍然越界')
            if (b.x-a.x)*(c.y-a.y) == (c.x-a.x)*(b.y-a.y):
                raise RuntimeError('修复后仍存在退化 UV，可能需要先修复模型几何')
            triangles += 1
    return triangles

count = validate(meshes)
bpy.ops.export_scene.gltf(filepath=target, export_format='GLB', use_selection=True,
                          export_animations=False, export_yup=True)
# Round trip through the serialized Float32 attributes, not just Blender's live data.
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=target)
verified = validate([o for o in bpy.context.scene.objects if o.type == 'MESH'])
if verified != count:
    raise RuntimeError('修复导出后的三角形数量不一致')
print('IMPORT_UV_REPAIR_OK ' + json.dumps({'triangles': count, 'version': '1.0.0'}))
`;
