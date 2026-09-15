import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stdout } from 'node:process';
import ts from 'typescript';
import { compactShaderTemplateIndentation as compact, compactThreeShaderChunks, shaderTemplateFormatPlugin } from './shader-template-format.mjs';

const fixture = [
  'const type = "float", name = "value";',
  '// untouched `   comment`',
  'const ordinary = "  UI text";',
  'export const shader = `',
  '    #define ENABLED 1',
  '    // Preserve comment newline',
  '    ${type} ${name};',
  '    ${`vec3 nested;\n      vec4 second;`}',
  '    #include <common>',
  '    void main() {',
  '      value = 1.0;',
  '    }',
  '`;',
].join('\n');
const load = code => import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const before = await load(fixture), after = await load(compact(fixture));
assert.deepEqual(glslTokens(after.shader), glslTokens(before.shader));
assert.deepEqual(directiveLines(after.shader), directiveLines(before.shader));
assert.equal(after.shader.split('\n').length, before.shader.split('\n').length);
assert.ok(after.shader.includes('float value;'));
assert.ok(after.shader.includes('// Preserve comment newline\nfloat'));
assert.ok(compact(fixture).includes('const ordinary = "  UI text"'));
assert.equal(compact(compact(fixture)), compact(fixture));
assert.equal(compact('const s = `\r\n\t  float a;\r\n`;'), 'const s = `\r\nfloat a;\r\n`;');
assert.equal(compact('const s = `\n  // comment\n  float a;\n`;'), 'const s = `\n\nfloat a;\n`;');
for (const guarded of ['/* block\n// closes */', '// continuation\\\nfloat a;', '// ${value}\nfloat a;']) {
  const code = 'const s = `\n' + guarded + '\n`;';
  assert.equal(compact(code), code, 'Ambiguous comment state must remain intact');
}

const filename = new URL('../src/engine/projection/ProjectedLayerMaterial.ts', import.meta.url);
const source = fs.readFileSync(filename, 'utf8');
const result = compact(source);
// Compare every leaf token of the actual module, including comments/trivia;
// only template indentation may differ. Expressions and token separators stay.
const templates = new Set([ts.SyntaxKind.NoSubstitutionTemplateLiteral, ts.SyntaxKind.TemplateHead, ts.SyntaxKind.TemplateMiddle, ts.SyntaxKind.TemplateTail]);
function tokens(code, scriptKind = ts.ScriptKind.TS) {
  const ast = ts.createSourceFile('shader.ts', code, ts.ScriptTarget.Latest, true, scriptKind);
  assert.equal(ast.parseDiagnostics.length, 0);
  const out = [];
  const visit = node => {
    const children = node.getChildren(ast);
    if (children.length) children.forEach(visit);
    else {
      let text = node.getFullText(ast);
      if (templates.has(node.kind)) {
        const start = node.getStart(ast), end = node.end;
        const raw = code.slice(start, end);
        let expected = raw.replace(/(\r?\n)[\t ]+/g, '$1');
        if (node.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral &&
            !raw.includes('/*') && !raw.includes('\\')) {
          expected = expected.replace(/(\r?\n)\/\/[^\r\n]*/g, '$1');
        }
        const normalized = JSON.stringify({ tokens: glslTokens(expected), directives: directiveLines(expected), lines: expected.split('\n').length });
        text = text.slice(0, text.length - raw.length) + normalized;
      }
      out.push([node.kind, text]);
    }
  };
  visit(ast);
  return out;
}
assert.deepEqual(tokens(result), tokens(source));
const saved = Buffer.byteLength(source) - Buffer.byteLength(result);
assert.ok(saved > 10000, `Expected meaningful shader indentation savings, got ${saved}`);
const plugin = shaderTemplateFormatPlugin();
assert.equal(plugin.apply, 'build');
assert.equal(plugin.transform(fixture, '/src/ui/Panel.ts'), undefined);
assert.equal(plugin.transform(source, filename.pathname).code, result);
const compositorFile = new URL('../src/engine/bake/gpuUvBakeRenderer.ts', import.meta.url);
const compositorSource = fs.readFileSync(compositorFile, 'utf8');
const compositorResult = compact(compositorSource);
assert.deepEqual(tokens(compositorResult), tokens(compositorSource));
assert.equal(plugin.transform(compositorSource, compositorFile.pathname).code, compositorResult);
assert.ok(Buffer.byteLength(compositorSource) - Buffer.byteLength(compositorResult) >= 2000);
// Every changed template in this additional file must belong to a GLSL variable.
const compositorAst = ts.createSourceFile('shader.ts', compositorSource, ts.ScriptTarget.Latest, true);
function verifyShaderOnly(node) {
  if (templates.has(node.kind) && /(\r?\n)[\t ]+/.test(node.getText(compositorAst))) {
    let parent = node.parent;
    while (parent && !ts.isVariableDeclaration(parent)) parent = parent.parent;
    assert.ok(parent && /Shader$/.test(parent.name.getText(compositorAst)));
  }
  ts.forEachChild(node, verifyShaderOnly);
}
verifyShaderOnly(compositorAst);
const additionalShaderFiles = [
  '../src/engine/bake/residentQualityComposite.ts',
  '../src/engine/projection/createRuntimeProjectionDepth.ts',
  '../src/engine/capture/captureDepth.ts',
  '../src/engine/capture/captureNormal.ts',
  '../src/engine/localRepaint/uvRepaint.ts',
  '../src/engine/localRepaint/consumeSelectionMask.ts',
  '../src/engine/export/comfyControlInputExporter.ts',
  '../src/engine/viewport/ViewportCanvas.tsx',
];
let additionalSaved = 0;
for (const relativeFile of additionalShaderFiles) {
  const file = new URL(relativeFile, import.meta.url);
  const before = fs.readFileSync(file, 'utf8');
  const result = compact(before);
  const scriptKind = relativeFile.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  assert.deepEqual(tokens(result, scriptKind), tokens(before, scriptKind));
  assert.equal(plugin.transform(before, file.pathname).code, result);
  additionalSaved += Buffer.byteLength(before) - Buffer.byteLength(result);
  const ast = ts.createSourceFile('shader.ts', before, ts.ScriptTarget.Latest, true, scriptKind);
  const verifyTemplate = node => {
    if (templates.has(node.kind) && /(\r?\n)[\t ]+/.test(node.getText(ast))) {
      const owners = [];
      let parent = node.parent;
      while (parent) {
        if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) {
          owners.push(parent.name.getText(ast));
        }
        parent = parent.parent;
      }
      assert.ok(
        /(?:void main|#include|uniform|varying|precision|gl_)/.test(node.getText(ast)) ||
          /(?:Shader|shader|material|vertexAssignment|fragmentBlend)/.test(owners.join(' ')),
        `Only GLSL templates may be compacted: ${owners.join(' ')}`,
      );
    }
    ts.forEachChild(node, verifyTemplate);
  };
  verifyTemplate(ast);
}
assert.ok(additionalSaved >= 1500, `Expected bundle headroom savings, got ${additionalSaved}`);
// GLSL token equivalence alone does not verify JavaScript shader assembly.
// Exercise the real repaint vertex splice before and after the build transform.
const repaintSource = fs.readFileSync(new URL('../src/engine/localRepaint/uvRepaint.ts', import.meta.url), 'utf8');
function assembledRepaintVertex(code) {
  const ast = ts.createSourceFile('uvRepaint.ts', code, ts.ScriptTarget.Latest, true);
  let vertex, assembly, entry;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'vertex' && node.initializer && ts.isNoSubstitutionTemplateLiteral(node.initializer)) vertex = node.initializer.getText(ast);
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'shaderMain') entry = node.initializer.getText(ast);
    if (ts.isBinaryExpression(node) && node.left.getText(ast) === 'this.brush.vertexShader' && node.right.getText(ast).includes('paintSourceVertex')) assembly = node.right.getText(ast);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(vertex && assembly && entry, 'Exercise the production repaint shader assembly');
  return new Function('material', `const shaderMain = ${entry}; const vertex = ${vertex}; return (${assembly});`)({vertexShader: 'void main(){gl_Position=vec4(position,1.0);}'});
}
for (const code of [repaintSource, compact(repaintSource)]) {
  const shader = assembledRepaintVertex(code);
  assert.match(shader, /void\s+main\s*\(\)\s*\{\s*paintSourceVertex\s*\(/, 'The UV paint entry must invoke the frozen source projection after production formatting');
  assert.equal((shader.match(/void\s+main\s*\(/g) ?? []).length, 1);
}
assert.equal(
  plugin.transform(compositorSource, new URL('../src/engine/projection/ProjectedLayerPreviewCompositor.ts', import.meta.url).pathname),
  undefined,
);
stdout.write(`Shader formatting preserves actual module tokens and GLSL line boundaries; removes ${saved + additionalSaved} source bytes.\n`);

// Independently tokenize GLSL, including compound operators and numeric
// literals. Compare the actual pinned vendor module, not a replacement kernel.
function glslTokens(text) { return text.match(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|[A-Za-z_]\w*|0[xX][\dA-Fa-f]+[uU]?|(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?[fFuU]?|<<=|>>=|\+\+|--|&&|\|\||\^\^|<<|>>|<=|>=|==|!=|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|[^\s]/g) ?? []; }
function directiveLines(text) { return text.split(/\r?\n/).filter(line => line.trimStart().startsWith('#')).map(line => line.trimStart()); }
const threeFile = new URL('../node_modules/three/build/three.module.js', import.meta.url);
const threeSource = fs.readFileSync(threeFile, 'utf8');
const threeResult = compactThreeShaderChunks(threeSource);
assert.equal(plugin.transform(threeSource, threeFile.pathname).code, threeResult);
assert.equal(plugin.transform(threeSource, '/node_modules/another/build/three.module.js'), undefined);
assert.equal(compactThreeShaderChunks(threeResult), threeResult);
const vendorLeaves = code => {
  const ast = ts.createSourceFile('three.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(ast.parseDiagnostics.length, 0);
  const out = [];
  const visit = node => {
    const children = node.getChildren(ast);
    if (children.length) children.forEach(visit);
    else out.push({ kind: node.kind, text: node.getFullText(ast), value: ts.isStringLiteral(node) ? node.text : undefined });
  };
  visit(ast);
  return out;
};
const vendorBefore = vendorLeaves(threeSource), vendorAfter = vendorLeaves(threeResult);
assert.equal(vendorAfter.length, vendorBefore.length);
let changedShaders = 0;
for (let index = 0; index < vendorBefore.length; index++) {
  const before = vendorBefore[index], after = vendorAfter[index];
  assert.equal(after.kind, before.kind);
  if (before.text === after.text) continue;
  assert.equal(before.kind, ts.SyntaxKind.StringLiteral);
  assert.deepEqual(glslTokens(after.value), glslTokens(before.value));
  assert.deepEqual(directiveLines(after.value), directiveLines(before.value));
  assert.equal(after.value.split('\n').length, before.value.split('\n').length);
  changedShaders++;
}
assert.ok(changedShaders > 80);
assert.ok(Buffer.byteLength(threeSource) - Buffer.byteLength(threeResult) >= 16000);
const vendorFixture = 'const shader = ' + JSON.stringify('precision highp float;\n\tfloat a = 1e-3;\n\ta + +a; a - -a;\n\t#define X(a) ( a + 1 )\n') + '; const ui = "  UI text"; const ShaderChunk = { shader: shader };';
const formattedFixture = compactThreeShaderChunks(vendorFixture);
assert.ok(formattedFixture.includes('const ui = "  UI text"'));
assert.deepEqual(vendorLeaves(formattedFixture).filter(node => node.value !== undefined).map(node => glslTokens(node.value)), vendorLeaves(vendorFixture).filter(node => node.value !== undefined).map(node => glslTokens(node.value)));
assert.throws(() => compactThreeShaderChunks('const ShaderChunk = { shader: 1 };'), /audit/);
assert.throws(() => compactThreeShaderChunks('const shader = compute(); const ShaderChunk = { shader: shader };'), /audit/);
const commentFixture = 'const shader = ' + JSON.stringify('// standalone\n#define P 1\n/* block\n// inside block\n*/\nfloat a = 1.;\n') + '; const ShaderChunk = { shader: shader };';
assert.ok(compactThreeShaderChunks(commentFixture).includes('standalone'), 'Block-comment ambiguity must disable comment removal');
stdout.write(`Three registered shaders retain all GLSL tokens, directives and line counts: ${changedShaders} strings; ${Buffer.byteLength(threeSource) - Buffer.byteLength(threeResult)} source bytes removed.\n`);
