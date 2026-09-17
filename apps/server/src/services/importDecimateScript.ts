// IMPORT-DECIMATE v1.0.0. Preserve materials/UV; UV changes need a separate consent.
export const importDecimateScript = String.raw`
import bpy, json, sys, math

source, target = sys.argv[sys.argv.index('--') + 1:]
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=source)
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']

def count(obj):
    obj.data.calc_loop_triangles()
    return len(obj.data.loop_triangles)

counts = [count(obj) for obj in meshes]
total = sum(counts)
budget = 200000
if total <= 1500000:
    raise RuntimeError('模型未超过 150 万三角面，无需自动减面')
if any(n == 0 for n in counts) or len(meshes) > budget:
    raise RuntimeError('模型包含空网格或零件过多，无法自动减面')
# Allocate a total budget across all objects, rather than 200k to each object.
allocations = [1 + int((budget-len(meshes))*(n-1)/(total-len(meshes))) for n in counts]
allocations[counts.index(max(counts))] += budget-sum(allocations)
for obj, original, allocation in zip(meshes, counts, allocations):
    if obj.modifiers or obj.data.shape_keys:
        raise RuntimeError('暂不支持带骨骼或形态键的模型')
    if any(not math.isfinite(c) for v in obj.data.vertices for c in v.co):
        raise RuntimeError('模型坐标无效')
    obj.data = obj.data.copy()
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
print('IMPORT_DECIMATE_OK ' + json.dumps({'inputTriangles': total, 'triangles': triangles, 'version': '1.0.0'}))
`;
