"""Freeze the owner's existing UI workflow without changing its model/settings."""
import hashlib
import json
from pathlib import Path
import urllib.request

source = Path('/root/ComfyUI/user/default/workflows/li3d-8.json')
root = Path('/root/li3d-personal-repaint')
workflow = json.loads(source.read_bytes())
schemas = json.load(urllib.request.urlopen('http://127.0.0.1:6006/object_info', timeout=30))
links = {link[0]: link for link in workflow['links']}
prompt = {}
for node in workflow['nodes']:
    kind = node['type']
    assert kind in schemas, 'Missing node: ' + kind
    assert node.get('mode', 0) == 0, 'Muted/bypass nodes require explicit conversion'
    inputs, widget_index = {}, 0
    for entry in node.get('inputs', []):
        value = None
        if 'widget' in entry:
            value = node['widgets_values'][widget_index]
            widget_index += 1
        if entry.get('link') is not None:
            link = links[entry['link']]
            inputs[entry['name']] = [str(link[1]), link[2]]
        elif 'widget' in entry and entry['name'] != 'upload':
            inputs[entry['name']] = value
    schema = schemas[kind]['input']
    # li3d-8 predates the added tail widget: its serialized status widgets
    # occupy the new input positions. Restore the saved device/cache settings.
    if kind == 'Li3DPromptCacheEncode' and node['widgets_values'][1:3] == ['default', True]:
        inputs.update(tail_prompt='', device='default', disk_cache=True)
    for name in schema.get('required', {}):
        assert name in inputs, f'Missing input: {kind}.{name}'
    for name, value in inputs.items():
        definition = schema.get('required', {}).get(name, schema.get('optional', {}).get(name))
        if definition and isinstance(definition[0], list) and not isinstance(value, list) and kind != 'LoadImage':
            assert value in definition[0], f'Unavailable model/value: {kind}.{name}: {value}'
    prompt[str(node['id'])] = {'class_type': kind, 'inputs': inputs}
for node_id in ['4', '5', '44', '81']:
    assert prompt[node_id]['class_type'] == 'LoadImage'
assert prompt['15']['inputs']['steps'] == 2
assert prompt['29']['class_type'] == 'PreviewImage'
root.mkdir(mode=0o700, exist_ok=True)
(root / 'workflow.json').write_text(json.dumps(prompt, ensure_ascii=False), encoding='utf-8')
(root / 'workflow-source.sha256').write_text(hashlib.sha256(source.read_bytes()).hexdigest())
print('Fixed workflow ready:', len(prompt), 'nodes; original parameters preserved.')
