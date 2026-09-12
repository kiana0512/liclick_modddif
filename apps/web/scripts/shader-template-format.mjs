import ts from 'typescript';

// Keep GLSL tokens, preprocessor lines and interpolation separators intact.
// Only remove indentation AFTER physical newlines inside template tokens.
// In particular, `${type} ${name}` must retain its separating space.
export function compactShaderTemplateIndentation(source) {
  const ast = ts.createSourceFile('shader.ts', source, ts.ScriptTarget.Latest, true);
  const edits = [];
  const kinds = new Set([
    ts.SyntaxKind.NoSubstitutionTemplateLiteral, ts.SyntaxKind.TemplateHead,
    ts.SyntaxKind.TemplateMiddle, ts.SyntaxKind.TemplateTail,
  ]);
  const visit = (node) => {
    if (kinds.has(node.kind)) {
      const start = node.getStart(ast), end = node.end;
      const before = source.slice(start, end);
      const after = before.replace(/(\r?\n)[\t ]+/g, '$1');
      if (before !== after) edits.push({ start, end, after });
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    source = source.slice(0, edit.start) + edit.after + source.slice(edit.end);
  }
  return source;
}

export function shaderTemplateFormatPlugin() {
  return {
    name: 'li3d-projected-shader-format',
    apply: 'build',
    enforce: 'pre',
    transform(code, id) {
      // Explicitly scoped: no UI strings, external packages, or other templates.
      if (!/\/engine\/(?:projection\/(?:ProjectedLayerMaterial|createRuntimeProjectionDepth)|bake\/(?:gpuUvBakeRenderer|residentQualityComposite)|capture\/(?:captureDepth|captureNormal)|localRepaint\/(?:uvRepaint|consumeSelectionMask)|export\/comfyControlInputExporter)\.ts$|\/engine\/viewport\/ViewportCanvas\.tsx$/.test(id.replaceAll('\\', '/'))) return;
      return { code: compactShaderTemplateIndentation(code), map: null };
    },
  };
}
