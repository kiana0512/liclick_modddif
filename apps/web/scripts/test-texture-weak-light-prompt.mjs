import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');
function evaluate(source) {
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const module = { exports: {} };
  new Function('module', 'exports', code)(module, module.exports);
  return module.exports;
}
const { buildTextureMapPrompt, buildTextureMapCompletionPrompt } = evaluate(
  read('../src/engine/generation/textureMapPrompts.ts'),
);
const base = buildTextureMapPrompt('');
assert.equal(buildTextureMapPrompt(' \n '), base);
assert.equal(buildTextureMapCompletionPrompt(''), base);
const custom = buildTextureMapPrompt('  去掉文字，保留红色  ');
assert.equal(custom, `${base}\n\n用户补充材质要求：去掉文字，保留红色`);
assert.equal(buildTextureMapCompletionPrompt('去掉文字，保留红色'), custom);
for (const text of [
  '只在图一指定的待补全区域绘制材质，不重新生成物体。',
  '轮廓对齐优先于材质表现',
  '已经贴好的纹理区域保持不变，不对整张图重新调色、打光或去光照',
  '保留原有背景及透明区域，不向轮廓外扩展颜色',
  '不要沿用白模的灰度渐变、三角面明暗或硬法线色块',
  '只允许非常轻微、局限于真实接触位置的结构明暗',
  '不通过镜面反射、白色高光条或黑白光带增强金属感',
  '不要把真实浅色磨损误删为高光',
  '不要模糊、磨皮、整体泛白、降低饱和度',
]) assert.ok(base.includes(text), `Missing scoped weak-light requirement: ${text}`);

// Execute the real provider adapter without starting a server or paid job.
const source = read('../../server/src/services/liclickGenerationService.ts');
const ast = ts.createSourceFile('service.ts', source, ts.ScriptTarget.Latest, true);
const adapter = ast.statements.find((node) => ts.isFunctionDeclaration(node)
  && node.name?.text === 'buildSubmissionPrompt');
assert.ok(adapter);
const submit = evaluate(`${adapter.getText(ast)}\nmodule.exports = buildSubmissionPrompt;`);
for (const model of ['gpt-image-2', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare']) {
  for (const workflow of ['texture-map', 'local-repaint']) {
    for (const prompt of [base, custom]) assert.equal(submit({ workflow, prompt }, model), prompt);
  }
  const old = '只在图一上进行材质补全，不重新生成物体。\n历史任务';
  assert.equal(submit({ workflow: 'texture-map', prompt: old }, model), old);
  assert.match(submit({ workflow: 'texture-map', prompt: '普通材质' }, model), /贴图生成约束：/);
  assert.equal(submit({ workflow: 'liclick', prompt: '六视图参考图' }, model), '六视图参考图');
}
const panel = read('../src/components/panels/GeneratePanel.tsx');
assert.match(panel, /let texturePrompt =[\s\S]*?buildTextureMapPrompt\(prompt\)/);
assert.match(panel, /completionViewIds.has\(viewId\)[\s\S]*?buildTextureMapCompletionPrompt\(prompt\)/);
assert.match(panel, /isGptLocalRepaint\s*\? \{ prompt:[^\n]*buildGptRepaintPrompt\(rawUserPrompt, gptRepaintUseMaterialReference\)/);
console.log('Scoped weak-light template, shared entries, suffix and provider passthrough passed (no paid generation).');
