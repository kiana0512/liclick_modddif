import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/components/panels/LayersPanel.tsx', import.meta.url), 'utf8');
const file = ts.createSourceFile('LayersPanel.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'LayerThumbnail');
assert(component, 'Test the actual production visibility boundary');
const js = ts.transpileModule(component.getText(file), { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React,
}}).outputText;

function mount(supportsObserver = true) {
  let visible = false;
  let effect;
  let callback;
  let disconnects = 0;
  let previewMounts = 0;
  const element = {};
  const ref = { current: element };
  const Observer = class {
    constructor(next) { callback = next; }
    observe(target) { assert.equal(target, element); }
    disconnect() { disconnects++; }
  };
  const render = new Function('useRef', 'useState', 'useEffect', 'IntersectionObserver', 'React', 'VisibleLayerThumbnail',
    `${js}; return LayerThumbnail;`)(
    () => ref,
    () => [visible, (next) => { visible = next; }],
    (next) => { effect = next; },
    supportsObserver ? Observer : undefined,
    { createElement(type, props, ...children) {
      return typeof type === 'function' ? type(props) : { type, props, children };
    } },
    () => { previewMounts++; return 'preview'; },
  );
  render({ layer: { id: 'first' } });
  const cleanup = effect();
  return {
    render(id) { return render({ layer: { id } }); },
    notify(isIntersecting, width = 48, height = 48) {
      callback([{ isIntersecting, intersectionRect: { width, height } }]);
    },
    counts: () => ({ previewMounts, disconnects }),
    cleanup,
  };
}

const thumbnail = mount();
for (let i = 0; i < 71; i++) {
  thumbnail.notify(false);
  thumbnail.render(`hidden-model-${i % 9}`);
}
assert.equal(thumbnail.counts().previewMounts, 0, 'Hidden dock/model switches must not start preview consumers');
thumbnail.notify(true, 0, 0);
thumbnail.render('clipped');
assert.equal(thumbnail.counts().previewMounts, 0, 'Edge intersections/collapsed zero-area thumbnails stay cold');
thumbnail.notify(true);
thumbnail.render('visible');
assert.equal(thumbnail.counts().previewMounts, 1, 'Visible thumbnails keep the original full preview pipeline');
thumbnail.notify(false);
thumbnail.render('offscreen');
assert.equal(thumbnail.counts().previewMounts, 1, 'Scrolling/hiding stops the consumer');
thumbnail.cleanup();
thumbnail.notify(true);
thumbnail.render('late-callback');
assert.deepEqual(thumbnail.counts(), { previewMounts: 1, disconnects: 1 }, 'Unmount disconnects and ignores queued observer delivery');
const fallback = mount(false);
fallback.render('legacy-browser');
assert.equal(fallback.counts().previewMounts, 1, 'Unsupported browsers preserve preview availability');
console.log('Layer thumbnail visibility passed: 71 hidden switches -> 0 preview consumers; visible, clipped, offscreen and cleanup covered.');
