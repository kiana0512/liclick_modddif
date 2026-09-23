// IMPORT-UV-REPAIR v1.3.0. Merge by distance before Smart UV Project.
export const importUvRepairScript = String.raw`
import bpy, json, math, sys
from mathutils import Vector

source, target = sys.argv[sys.argv.index('--') + 1:]
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=source)
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
if not meshes:
    raise RuntimeError('模型没有可展开的网格')
originals = meshes
merge_distance = 0.0001
source_areas = {}
merged_vertices = 0

def validate_surface(objects):
    if len(objects) != len(originals):
        raise RuntimeError('合并顶点后零件数量不一致')
    for obj in objects:
        original_area = source_areas.get(obj.name, 0)
        area = sum(face.area for face in obj.data.polygons)
        if (not obj.data.polygons or original_area <= 0 or
                not math.isfinite(area) or not 0.99 <= area/original_area <= 1.01):
            raise RuntimeError('按距离合并导致零件消失或表面明显改变，请手动处理模型')
        if any(not math.isfinite(c) for v in obj.data.vertices for c in v.co):
            raise RuntimeError('合并后模型坐标无效')

for obj in originals:
    if obj.modifiers or obj.data.shape_keys:
        raise RuntimeError('暂不支持自动修复带骨骼或形态键的模型')
    obj.data = obj.data.copy()
    source_areas[obj.name] = sum(face.area for face in obj.data.polygons)
    before = len(obj.data.vertices)
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    # Same per-object local-space operation as Edit Mode > Merge by Distance.
    bpy.ops.mesh.remove_doubles(threshold=merge_distance, use_unselected=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    merged_vertices += before - len(obj.data.vertices)
validate_surface(originals)
for obj in originals:
    obj.data.calc_loop_triangles()
# Collapsed/duplicate faces can disappear during merging. UV projection itself
# must preserve the triangle count of the merged geometry, including round trip.
source_count = sum(len(obj.data.loop_triangles) for obj in originals)
meshes = []
for obj in originals:
    if not obj.data.uv_layers:
        obj.data.uv_layers.new(name='UVMap')
    obj.data.uv_layers.active_index = 0
    obj.data.uv_layers[0].active_render = True
    # The UV-only workspace preserves the already-merged geometry and corners.
    points, vertices, remap = {}, [], []
    for vertex in obj.data.vertices:
        key = tuple(vertex.co)
        if key not in points:
            points[key] = len(vertices)
            vertices.append(key)
        remap.append(points[key])
    faces = [[remap[i] for i in face.vertices] for face in obj.data.polygons]
    mesh = bpy.data.meshes.new('UV_Workspace')
    mesh.from_pydata(vertices, [], faces)
    mesh.uv_layers.new(name='UVMap')
    work = bpy.data.objects.new('UV_Workspace', mesh)
    bpy.context.collection.objects.link(work)
    work.matrix_world = obj.matrix_world.copy()
    meshes.append(work)
bpy.ops.object.select_all(action='DESELECT')
for obj in meshes:
    obj.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.001)
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

for original, work in zip(originals, meshes):
    if len(original.data.polygons) != len(work.data.polygons):
        raise RuntimeError('UV 工作网格面数不一致')
    for dest, source_face in zip(original.data.polygons, work.data.polygons):
        if len(dest.loop_indices) != len(source_face.loop_indices):
            raise RuntimeError('UV 工作网格面角不一致')
        for d, s in zip(dest.loop_indices, source_face.loop_indices):
            if original.data.vertices[original.data.loops[d].vertex_index].co != work.data.vertices[work.data.loops[s].vertex_index].co:
                raise RuntimeError('UV 工作网格面角顺序不一致')
            original.data.uv_layers[0].data[d].uv = work.data.uv_layers[0].data[s].uv
for work in meshes:
    mesh = work.data
    bpy.data.objects.remove(work, do_unlink=True)
    bpy.data.meshes.remove(mesh)
meshes = originals
bpy.ops.object.select_all(action='DESELECT')
for obj in meshes:
    obj.select_set(True)
count = validate(meshes)
validate_surface(meshes)
if count != source_count:
    raise RuntimeError('UV 修复改变了三角形数量')
bpy.ops.export_scene.gltf(filepath=target, export_format='GLB', use_selection=True,
                          export_animations=False, export_yup=True)
# Round trip through the serialized Float32 attributes, not just Blender's live data.
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=target)
round_trip = [o for o in bpy.context.scene.objects if o.type == 'MESH']
validate_surface(round_trip)
verified = validate(round_trip)
if verified != count:
    raise RuntimeError('修复导出后的三角形数量不一致')
print('IMPORT_UV_REPAIR_OK ' + json.dumps({'triangles': count, 'mergedVertices': merged_vertices,
      'mergeDistance': merge_distance, 'version': '1.3.0'}))
`;
