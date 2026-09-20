"""Blender --background --factory-startup --python this.py -- output-directory.

Small geometric fixtures lower only the entry threshold; the production 1.5M
boundary is covered by the browser suite and optional real HTTP model test.
"""
import bpy
import contextlib
import io
import json
from pathlib import Path
import sys

directory = Path(sys.argv[sys.argv.index('--') + 1])
directory.mkdir(parents=True, exist_ok=True)
source_text = (Path(__file__).parent.parent / 'src/services/importDecimateScript.ts').read_text(encoding='utf-8')
production = source_text.split('String.raw`', 1)[1].rsplit('`;', 1)[0]


def clear():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)


def run(name, script=production, error=None):
    source, target = directory / (name + '.glb'), directory / (name + '-out.glb')
    bpy.ops.export_scene.gltf(filepath=str(source), export_format='GLB')
    argv, stream = sys.argv, io.StringIO()
    try:
        sys.argv = ['test', '--', str(source), str(target)]
        with contextlib.redirect_stdout(stream):
            exec(compile(script, 'production-import-decimate.py', 'exec'), {})
    except RuntimeError as exception:
        if error is None or error not in str(exception):
            raise
        assert not target.exists(), 'failed processing must not publish output'
        return
    finally:
        sys.argv = argv
    assert error is None, 'expected rejection: ' + str(error)
    return json.loads(stream.getvalue().split('IMPORT_DECIMATE_OK ')[-1].strip())


def panel(name, offset=0.00005):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([(0, 0, 0), (1, 0, 0), (0, 1, 0),
                     (1 + offset, 0, 0), (1, 1, 0), (offset, 1, 0)], [],
                    [(0, 1, 2), (3, 4, 5)])
    uv = mesh.uv_layers.new(name='UVMap')
    for loop, point in zip(uv.data, [(0, 0), (.4, 0), (0, .4), (.6, .6), (1, .6), (.6, 1)]):
        loop.uv = point
    for color in [(1, 0, 0, 1), (0, 0, 1, 1)]:
        mat = bpy.data.materials.new(name + str(color))
        mat.use_nodes = True
        mat.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value = color
        mesh.materials.append(mat)
    mesh.polygons[1].material_index = 1
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)


small = production.replace('if total <= 1500000:', 'if total <= 0:')
clear()
panel('gate')
run('below-threshold', error='未超过 150 万')

clear()
panel('panel-a')
panel('panel-b')  # Exact overlapping objects must NOT merge across objects.
report = run('near-seam', small)
assert report['version'] == '1.1.0' and report['mergedVertices'] == 4, report
assert report['mergeDistance'] == 0.0001 and report['triangles'] == 4, report
objects = [o for o in bpy.context.scene.objects if o.type == 'MESH']
assert {o.name for o in objects} == {'panel-a', 'panel-b'}
expected_uv = sorted([(0, 0), (.4, 0), (0, .4), (.6, .6), (1, .6), (.6, 1)])
for obj in objects:
    assert len({tuple(v.co) for v in obj.data.vertices}) == 4
    assert sorted(tuple(round(c, 4) for c in loop.uv) for loop in obj.data.uv_layers[0].data) == expected_uv
    colors = {tuple(obj.data.materials[p.material_index].node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value)
              for p in obj.data.polygons}
    assert colors == {(1, 0, 0, 1), (0, 0, 1, 1)}, colors

clear()
panel('far', offset=0.001)
assert run('outside-distance', small)['mergedVertices'] == 0

clear()
mesh = bpy.data.meshes.new('tiny')
mesh.from_pydata([(0, 0, 0), (0.00001, 0, 0), (0, 0.00001, 0)], [], [(0, 1, 2)])
bpy.context.collection.objects.link(bpy.data.objects.new('tiny', mesh))
run('destructive-merge', small, error='零件消失或表面明显改变')

# Near-duplicate surfaces must not be silently deleted by distance merging.
clear()
mesh = bpy.data.meshes.new('duplicates')
mesh.from_pydata([(0, 0, 0), (1, 0, 0), (0, 1, 0),
                 (0, 0, 0.00005), (1, 0, 0.00005), (0, 1, 0.00005)], [], [(0, 1, 2), (3, 4, 5)])
bpy.context.collection.objects.link(bpy.data.objects.new('duplicates', mesh))
run('duplicate-surface-loss', small, error='零件消失或表面明显改变')

# A negligible sliver may collapse; re-count before allocation and handle an
# already-under-budget model (including one triangle) without division by zero.
clear()
mesh = bpy.data.meshes.new('sliver')
mesh.from_pydata([(0, 0, 0), (1, 0, 0), (0, 1, 0),
                 (0.1, 0.1, 0), (0.10001, 0.1, 0), (0.1, 0.10001, 0)], [], [(0, 1, 2), (3, 4, 5)])
bpy.context.collection.objects.link(bpy.data.objects.new('sliver', mesh))
report = run('collapsed-sliver', small)
assert report['inputTriangles'] == 2 and report['mergedTriangles'] == report['triangles'] == 1, report

# Real modifier/serialization, small budget for a fast geometry regression.
clear()
bpy.ops.mesh.primitive_uv_sphere_add(segments=64, ring_count=32)
report = run('sphere-decimation', small.replace('budget = 200000', 'budget = 500'))
assert 0 < report['triangles'] <= 505, report
assert report['mergedTriangles'] >= report['triangles'], report
print('DECIMATE_MERGE_TEST_OK ' + json.dumps(report))
