import ts from 'typescript';

// SHADER-TEMPLATE-FORMAT/1.4.0: the bundled Three registry identifies GLSL
// string literals explicitly. Never transform other vendor or application text.
export function compactThreeShaderChunks(source) {
  const ast = ts.createSourceFile('three.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declarations = [], names = new Set();
  const visit = node => {
    if (ts.isVariableDeclaration(node)) {
      declarations.push(node);
      if (node.name.getText(ast) === 'ShaderChunk' && node.initializer &&
          ts.isObjectLiteralExpression(node.initializer)) {
        for (const property of node.initializer.properties) {
          if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.initializer)) {
            throw new Error('Three ShaderChunk registry requires a formatting audit.');
          }
          names.add(property.initializer.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (!names.size) throw new Error('Three ShaderChunk registry was not found.');
  const edits = [];
  for (const declaration of declarations) {
    if (!names.has(declaration.name.getText(ast))) continue;
    const literal = declaration.initializer;
    if (!literal || !ts.isStringLiteral(literal)) {
      throw new Error('Three ShaderChunk source requires a formatting audit.');
    }
    const before = literal.text;
    let after = before.replace(/(\r?\n)[\t ]+/g, '$1');
    // Keep every physical newline and directive. Comments/continuations are
    // conservative: only indentation is changed in these ambiguous strings.
    if (!/\/\/|\/\*|\\/.test(after)) {
      after = after.split(/(\r?\n)/).map(line => line.startsWith('#') ? line :
        line.replace(/[\t ]+/g, (gap, index, text) => {
          if (index === 0 || index + gap.length === text.length) return gap;
          const left = text[index - 1], right = text[index + gap.length];
          // Preserve word/numeric separators and neighboring operators, so
          // a + +b cannot become a++b and 1 .0 cannot become 1.0.
          return /[\w.]/.test(left) && /[\w.]/.test(right) ||
            /[+\-*/<>=!&|^%]/.test(left) && /[+\-*/<>=!&|^%]/.test(right) ? ' ' : '';
        })).join('');
    }
    if (after !== before) edits.push({ start: literal.getStart(ast), end: literal.end, after: JSON.stringify(after) });
  }
  if (declarations.filter(node => names.has(node.name.getText(ast))).length !== names.size) {
    throw new Error('Three ShaderChunk declarations do not match the registry.');
  }
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    source = source.slice(0, edit.start) + edit.after + source.slice(edit.end);
  }
  return source;
}

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
      let after = before.replace(/(\r?\n)[\t ]+/g, '$1');
      // Static GLSL only: discard standalone comment text, keeping every line
      // boundary. Refuse block comments, escapes/continuations and interpolated
      // templates so comment state can never cross a token boundary.
      if (node.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral &&
          !before.includes('/*') && !before.includes('\\')) {
        after = after.replace(/(\r?\n)\/\/[^\r\n]*/g, '$1');
      }
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
      const normalizedId = id.replaceAll('\\', '/');
      if (normalizedId.endsWith('/node_modules/three/build/three.module.js')) {
        return { code: compactThreeShaderChunks(code), map: null };
      }
      // Application templates remain explicitly scoped; UI text is untouched.
      if (!/\/engine\/(?:projection\/(?:ProjectedLayerMaterial|createRuntimeProjectionDepth)|bake\/(?:gpuUvBakeRenderer|residentQualityComposite)|capture\/(?:captureDepth|captureNormal)|localRepaint\/(?:uvRepaint|consumeSelectionMask)|export\/comfyControlInputExporter)\.ts$|\/engine\/viewport\/ViewportCanvas\.tsx$/.test(id.replaceAll('\\', '/'))) return;
      return { code: compactShaderTemplateIndentation(code), map: null };
    },
  };
}
