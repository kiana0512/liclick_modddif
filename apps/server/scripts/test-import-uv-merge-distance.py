"""Run inside Blender: --python this.py -- production-repair.py output-directory."""
import bpy
import contextlib
import io
import json
import math
import os
import runpy
import sys

script, directory = sys.argv[sys.argv.index('--') + 1:]
os.makedirs(directory, exist_ok=True)

def clear():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)

def repair(source, target):
    before = sys.argv
    stream = io.StringIO()
    try:
        sys.argv = [script, '--', source, target]
        with contextlib.redirect_stdout(stream):
            runpy.run_path(script, run_name='__main__')
    finally:
        sys.argv = before
    return json.loads(stream.getvalue().split('IMPORT_UV_REPAIR_OK ')[-1].strip())

clear()
materials = [bpy.data.materials.new(name) for name in ['red', 'blue']]
materials[0].diffuse_color = (1, 0, 0, 1)
materials[1].diffuse_color = (0, 0, 1, 1)
for material in materials:
    material.use_nodes = True
    material.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value = material.diffuse_color
for name in ['panel-a', 'panel-b']:
    mesh = bpy.data.meshes.new(name)
    # Two triangles have matching edge endpoints separated by 0.00005.
    # Exact-position welding alone cannot join them.
    mesh.from_pydata([(0, 0, 0), (1, 0, 0), (0, 1, 0),
                     (1.00005, 0, 0), (1, 1, 0), (0.00005, 1, 0)], [],
                    [(0, 1, 2), (3, 4, 5)])
    mesh.uv_layers.new(name='UVMap')  # Deliberately collapsed UVs.
    for material in materials:
        mesh.materials.append(material)
    mesh.polygons[1].material_index = 1
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)

source = os.path.join(directory, 'near-vertices.glb')
target = os.path.join(directory, 'near-vertices-repaired.glb')
bpy.ops.export_scene.gltf(filepath=source, export_format='GLB')
report = repair(source, target)
assert report['mergedVertices'] == 4, report
assert report['triangles'] == 4, report
assert report['mergeDistance'] == 0.0001, report
objects = [o for o in bpy.context.scene.objects if o.type == 'MESH']
assert {o.name for o in objects} == {'panel-a', 'panel-b'}
for obj in objects:
    # Export can split vertices at UV/material seams; compare positions instead.
    assert len({tuple(v.co) for v in obj.data.vertices}) == 4
    colors = {tuple(round(c, 4) for c in obj.data.materials[f.material_index].node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value)
              for f in obj.data.polygons}
    assert colors == {(1, 0, 0, 1), (0, 0, 1, 1)}, colors
    obj.data.calc_loop_triangles()
    for tri in obj.data.loop_triangles:
        a, b, c = [obj.data.uv_layers[0].data[i].uv for i in tri.loops]
        assert all(math.isfinite(v) and 0 <= v <= 1 for p in (a, b, c) for v in p)
        assert (b-a).cross(c-a) != 0

clear()
mesh = bpy.data.meshes.new('tiny')
mesh.from_pydata([(0, 0, 0), (0.00001, 0, 0), (0, 0.00001, 0)], [], [(0, 1, 2)])
obj = bpy.data.objects.new('tiny', mesh)
bpy.context.collection.objects.link(obj)
source = os.path.join(directory, 'tiny.glb')
target = os.path.join(directory, 'tiny-rejected.glb')
bpy.ops.export_scene.gltf(filepath=source, export_format='GLB')
try:
    repair(source, target)
except RuntimeError as error:
    assert '零件消失或表面明显改变' in str(error), str(error)
else:
    raise AssertionError('Destructive merge must not produce an accepted model')
assert not os.path.exists(target)
print('MERGE_DISTANCE_TEST_OK ' + json.dumps(report))
