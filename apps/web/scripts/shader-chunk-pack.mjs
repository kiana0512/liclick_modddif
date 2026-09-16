import { deflateSync } from 'fflate';
import { Buffer } from 'node:buffer';
import ts from 'typescript';

const prefix = '__li3d_shader_pack_';

// SHADER-CHUNK-PACK/1.0.0: losslessly store the registered Three shader text.
// Runs after existing formatting. Runtime strings, directives, line boundaries
// and JavaScript shader assembly are unchanged; no application text is packed.
export function packThreeShaderChunks(source) {
  const ast = ts.createSourceFile('three.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declarations = [], names = new Set();
  const visit = node => {
    if (ts.isIdentifier(node) && node.text.startsWith(prefix)) {
      throw new Error('Three shader packing identifier requires an audit.');
    }
    if (ts.isVariableDeclaration(node)) {
      declarations.push(node);
      if (node.name.getText(ast) === 'ShaderChunk' && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
        for (const property of node.initializer.properties) {
          if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.initializer)) {
            throw new Error('Three ShaderChunk registry requires a packing audit.');
          }
          names.add(property.initializer.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (!names.size) throw new Error('Three ShaderChunk registry was not found.');
  const texts = [], edits = [];
  for (const declaration of declarations) {
    if (!names.has(declaration.name.getText(ast))) continue;
    if (!declaration.initializer || !ts.isStringLiteral(declaration.initializer)) {
      throw new Error('Three ShaderChunk source requires a packing audit.');
    }
    const index = texts.push(declaration.initializer.text) - 1;
    edits.push({ start: declaration.initializer.getStart(ast), end: declaration.initializer.end,
      after: `/* @__PURE__ */ ${prefix}get(${index})` });
  }
  if (texts.length !== names.size) throw new Error('Three ShaderChunk declarations do not match the registry.');
  const bytes = Buffer.from(JSON.stringify(texts));
  if (bytes.length > 1024 * 1024) throw new Error('Three shader packing size requires an audit.');
  const encoded = Buffer.from(deflateSync(bytes, { level: 9 })).toString('base64');
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    source = source.slice(0, edit.start) + edit.after + source.slice(edit.end);
  }
  // Pure initialization allows geometry-only Worker imports to tree-shake the
  // whole pool. The renderer materializes it once per module, before use.
  return `import { inflateSync as ${prefix}inflate, strFromU8 as ${prefix}text } from 'fflate';
function ${prefix}decode() {
  const binary = atob(${JSON.stringify(encoded)});
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return JSON.parse(${prefix}text(${prefix}inflate(bytes)));
}
const ${prefix}texts = /* @__PURE__ */ ${prefix}decode();
function ${prefix}get(index) { return ${prefix}texts[index]; }
` + source;
}

export function shaderChunkPackPlugin() {
  return {
    name: 'li3d-three-shader-pack', apply: 'build', enforce: 'pre',
    transform(code, id) {
      if (!id.replaceAll('\\', '/').endsWith('/node_modules/three/build/three.module.js')) return;
      return { code: packThreeShaderChunks(code), map: null };
    },
  };
}
