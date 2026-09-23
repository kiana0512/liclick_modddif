// IMPORT-DECIMATE v1.1.0. Merge by distance before consented import decimation.
export const importDecimateScript = String.raw`
import bpy, json, sys, math

source, target = sys.argv[sys.argv.index('--') + 1:]
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
# FBXLoader → GLTFExporter can emit non-indexed triangles. Reconnect identical
# position/normal vertices (UV remains per loop), or decimation deletes islands.
bpy.ops.import_scene.gltf(filepath=source, merge_vertices=True)
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']

def count(obj):
    obj.data.calc_loop_triangles()
    return len(obj.data.loop_triangles)

counts = [count(obj) for obj in meshes]
source_areas = {obj.name: sum(p.area for p in obj.data.polygons) for obj in meshes}
total = sum(counts)
budget = 200000
if total <= 1500000:
    raise RuntimeError('模型未超过 150 万三角面，无需自动减面')
if any(n == 0 for n in counts) or len(meshes) > budget:
    raise RuntimeError('模型包含空网格或零件过多，无法自动减面')
merge_distance = 0.0001
merged_vertices = 0
for obj in meshes:
    if obj.modifiers or obj.data.shape_keys:
        raise RuntimeError('暂不支持带骨骼或形态键的模型')
    if any(not math.isfinite(c) for v in obj.data.vertices for c in v.co):
        raise RuntimeError('模型坐标无效')
    obj.data = obj.data.copy()
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    before = len(obj.data.vertices)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    # Match import UV repair: local-space distance, never across objects.
    bpy.ops.mesh.remove_doubles(threshold=merge_distance, use_unselected=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    merged_vertices += before - len(obj.data.vertices)
    area = sum(p.area for p in obj.data.polygons)
    original_area = source_areas[obj.name]
    if (count(obj) == 0 or original_area <= 0 or not math.isfinite(area)
            or not 0.99 <= area/original_area <= 1.01):
        raise RuntimeError('按距离合并导致零件消失或表面明显改变，请手动处理模型')
    if any(not math.isfinite(c) for v in obj.data.vertices for c in v.co):
        raise RuntimeError('合并后模型坐标无效')
# Merging can remove collapsed/duplicate faces. Use the new counts for BOTH
# allocation and modifier ratios, while retaining the original 1.5M entry gate.
counts = [count(obj) for obj in meshes]
merged_total = sum(counts)
if merged_total <= budget:
    allocations = counts
else:
    allocations = [1 + int((budget-len(meshes))*(n-1)/(merged_total-len(meshes))) for n in counts]
    allocations[counts.index(max(counts))] += budget-sum(allocations)
for obj, original, allocation in zip(meshes, counts, allocations):
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    modifier = obj.modifiers.new(name='Import target triangles', type='DECIMATE')
    modifier.decimate_type = 'COLLAPSE'
    modifier.ratio = min(1.0, allocation/original)
    modifier.use_collapse_triangulate = True
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    if count(obj) == 0:
        raise RuntimeError('减面导致零件消失，请手动简化模型')

def validate(objects):
    if len(objects) != len(meshes) or any(count(o) == 0 for o in objects):
        raise RuntimeError('减面导出后零件数量不一致')
    triangles = sum(count(o) for o in objects)
    if triangles <= 0 or triangles > budget*1.01:
        raise RuntimeError('减面结果未达到约 20 万三角面')
    if any(not math.isfinite(c) for o in objects for v in o.data.vertices for c in v.co):
        raise RuntimeError('减面结果坐标无效')
    for obj in objects:
        original_area = source_areas.get(obj.name, 0)
        area = sum(p.area for p in obj.data.polygons)
        # A count-only gate accepts disconnected triangle deletion. Reject major
        # surface loss, both before export and after the serialized round trip.
        if original_area <= 0 or not 0.8 <= area/original_area <= 1.2:
            raise RuntimeError('减面导致表面大幅损失或异常，模型未导入')
    return triangles

validate(meshes)
bpy.ops.object.select_all(action='DESELECT')
for obj in meshes:
    obj.select_set(True)
bpy.ops.export_scene.gltf(filepath=target, export_format='GLB', use_selection=True,
                          export_animations=False, export_yup=True)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=target)
triangles = validate([o for o in bpy.context.scene.objects if o.type == 'MESH'])
print('IMPORT_DECIMATE_OK ' + json.dumps({'inputTriangles': total, 'triangles': triangles,
      'mergedTriangles': merged_total, 'mergedVertices': merged_vertices,
      'mergeDistance': merge_distance, 'version': '1.1.0'}))
`;
