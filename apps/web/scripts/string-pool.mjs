import ts from 'typescript';

// BUILD-STRING-POOL/1: deduplicate long literal values within each chunk.
// No text rewriting, property mangling, cross-chunk dependencies or runtime decoding.
export function poolStrings(code) {
  const ast = ts.createSourceFile('chunk.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const values = new Map();
  const prefix = '__li3d_string_pool_';
  const visit = node => {
    if (ts.isIdentifier(node) && node.text.startsWith(prefix)) throw new Error('String pool identifier collision');
    if (ts.isStringLiteral(node) && node.text.length >= 64) {
      const p = node.parent;
      const value = (ts.isPropertyAssignment(p) && p.initializer === node) ||
        (ts.isVariableDeclaration(p) && p.initializer === node) ||
        (ts.isCallExpression(p) && p.arguments.includes(node)) ||
        (ts.isReturnStatement(p) && p.expression === node) || ts.isArrayLiteralExpression(p);
      if (value) {
        const entries = values.get(node.text) ?? [];
        entries.push(node); values.set(node.text, entries);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  const edits = [], declarations = [];
  for (const [value, nodes] of values) {
    if (nodes.length < 2) continue;
    const name = prefix + declarations.length;
    declarations.push(`const ${name}=${JSON.stringify(value)};`);
    for (const node of nodes) edits.push({ start: node.getStart(ast), end: node.end, name });
  }
  for (const edit of edits.sort((a, b) => b.start - a.start)) code = code.slice(0, edit.start) + edit.name + code.slice(edit.end);
  return declarations.join('\n') + '\n' + code;
}

export function stringPoolPlugin() {
  return { name: 'li3d-string-pool', apply: 'build', renderChunk: code => ({ code: poolStrings(code), map: null }) };
}
