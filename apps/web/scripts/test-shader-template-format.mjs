import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stdout } from 'node:process';
import ts from 'typescript';
import { compactShaderTemplateIndentation as compact, shaderTemplateFormatPlugin } from './shader-template-format.mjs';

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
assert.equal(after.shader, before.shader.replace(/(\r?\n)[\t ]+/g, '$1'));
assert.ok(after.shader.includes('float value;'));
assert.ok(after.shader.includes('// Preserve comment newline\nfloat'));
assert.ok(compact(fixture).includes('const ordinary = "  UI text"'));
assert.equal(compact(compact(fixture)), compact(fixture));
assert.equal(compact('const s = `\r\n\t  float a;\r\n`;'), 'const s = `\r\nfloat a;\r\n`;');

const filename = new URL('../src/engine/projection/ProjectedLayerMaterial.ts', import.meta.url);
const source = fs.readFileSync(filename, 'utf8');
const result = compact(source);
// Compare every leaf token of the actual module, including comments/trivia;
// only template indentation may differ. Expressions and token separators stay.
const templates = new Set([ts.SyntaxKind.NoSubstitutionTemplateLiteral, ts.SyntaxKind.TemplateHead, ts.SyntaxKind.TemplateMiddle, ts.SyntaxKind.TemplateTail]);
function tokens(code) {
  const ast = ts.createSourceFile('shader.ts', code, ts.ScriptTarget.Latest, true);
  assert.equal(ast.parseDiagnostics.length, 0);
  const out = [];
  const visit = node => {
    const children = node.getChildren(ast);
    if (children.length) children.forEach(visit);
    else {
      let text = node.getFullText(ast);
      if (templates.has(node.kind)) text = text.replace(/(\r?\n)[\t ]+/g, '$1');
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
stdout.write(`Shader formatting preserves actual module tokens and GLSL line boundaries; removes ${saved} source bytes.\n`);
