import ts from 'typescript';
import { TextDecoder } from 'node:util';
import { transformWithEsbuild } from 'vite';

// Explicit business boundary list, not whole-program profiling or pixel-loop instrumentation.
export const timedFunctions = {
  'engine/loaders/loadModelFromFile.ts': ['loadModelFromFile'],
  'engine/loaders/processModelImport.ts': ['processModelImport'],
  'engine/loaders/modelLoadUtils.ts': ['summarizeLoadedGroup', 'getImportedBaseColorTextureUrl'],
  'engine/capture/captureCurrentView.ts': ['captureCurrentView'],
  'engine/capture/captureColor.ts': ['captureColor'],
  'engine/capture/captureMask.ts': ['captureMask'],
  'engine/capture/captureNormal.ts': ['captureNormal'],
  'engine/capture/captureDepth.ts': ['captureDepth'],
  'engine/capture/renderTargetUtils.ts': ['renderSceneToPngUrl', 'renderScenePassesToPngUrl'],
  'engine/generation/contentFramingRestore.ts': ['restoreContentFraming'],
  'engine/generation/singleViewAutoProjection.ts': ['persistProjectionCommit'],
  'engine/projection/compileForRenderTarget.ts': ['compileForRenderTarget'],
  'services/workspaceApiClient.ts': ['createProject', 'loadProject', 'saveProject', 'uploadBlobAsset'],
  'services/liclickApiClient.ts': ['prepareReferences', 'requestJson'],
  'services/modelviewApiClient.ts': ['requestJson'],
  'engine/viewport/input.ts': ['interactionSafeJsonResponse', 'interactionSafeBlobDataUrl'],
};

export function instrumentFunctions(source, file, selected) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edits = [], found = [];
  const visit = node => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body && !node.asteriskToken && selected.includes(node.name.text)) {
      const label = file + '#' + node.name.text;
      const phase = ({ captureColor: 'capture.color', captureMask: 'capture.mask', captureNormal: 'capture.normal', captureDepth: 'capture.depth', createProject: 'project.create', loadProject: 'project.fetch', saveProject: 'save.execute', uploadBlobAsset: 'asset.upload.transfer', requestJson: 'http.request', prepareReferences: 'reference.decode', restoreContentFraming: 'result.decode', persistProjectionCommit: 'layer.commit', compileForRenderTarget: 'shader.compile' })[node.name.text]
        ?? (file.includes('/loaders/') ? 'model.load' : file.includes('/capture/') ? 'capture.frame' : file.includes('/viewport/') ? 'result.decode' : 'function.call');
      const kind = node.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword) ? 'async' : 'sync';
      const scope = '__li3dFunctionScope';
      if (node.body.getText(ast).includes(scope)) throw new Error('Reserved Trace binding: ' + label);
      edits.push([node.body.getStart(ast) + 1, `\nconst ${scope} = __li3dGetTrace()?.begin('${phase}', undefined, '${kind}', undefined, { functionName: ${JSON.stringify(label)} });\n${kind === 'async' ? 'let __li3dDeferred = false;\n' : ''}try {\n`]);
      if (kind === 'async') {
        const returns = child => {
          if (ts.isFunctionLike(child)) return;
          if (ts.isReturnStatement(child) && child.expression) {
            const expression = child.expression;
            edits.push([expression.getStart(ast), `${scope} ? (__li3dDeferred = true, __li3dFinishReturn(${scope}, `]);
            edits.push([expression.end, `)) : (${expression.getText(ast)})`]);
          }
          ts.forEachChild(child, returns);
        };
        ts.forEachChild(node.body, returns);
      }
      edits.push([node.body.end - 1, `\n} catch (__li3dError) { ${scope}?.end(__li3dError instanceof Error && __li3dError.name === 'AbortError' ? 'cancelled' : 'error'); throw __li3dError; } finally { ${kind === 'async' ? 'if (!__li3dDeferred) ' : ''}${scope}?.end(); }\n`]);
      found.push(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (found.length !== selected.length) throw new Error('Trace functions missing in ' + file + ': ' + selected.filter(n => !found.includes(n)).join(', '));
  for (const [offset, text] of edits.sort((a, b) => b[0] - a[0])) source = source.slice(0, offset) + text + source.slice(offset);
  return `import { getPipelineTrace as __li3dGetTrace, finishTraceReturn as __li3dFinishReturn } from '@/engine/performance/tracing/pipelineTrace';\n` + source;
}

export function functionTimingPlugin(enabled) {
  return { name: 'explicit-function-timing', enforce: 'pre', generateBundle(_options, bundle) {
    if (enabled) return;
    const remnants = Object.values(bundle).filter(v => v.type === 'chunk').flatMap(chunk => Object.entries(chunk.modules).filter(([id, module]) => /\/tracing\/|\/PipelineTrace(?:Panel|View)\./.test(id.replaceAll('\\', '/')) && module.renderedLength > 0).map(([id, module]) => id + ':' + module.renderedExports.join(',')));
    if (remnants.length) this.error('Release Trace modules were not removed: ' + remnants.join(', '));
    for (const chunk of Object.values(bundle)) {
      if (!chunk.fileName.endsWith('.js')) continue;
      const text = chunk.type === 'chunk' ? chunk.code : typeof chunk.source === 'string' ? chunk.source : new TextDecoder().decode(chunk.source);
      if (/traceContext|traceTiming|__pipelineTrace|LI3D-FUNCTION-TIMING/.test(text)) this.error('Release Trace protocol remains in ' + chunk.fileName);
    }
  }, async transform(source, id) {
    // Remove static branches before Rollup partitions shared exports into chunks.
    if (!enabled) {
      if (!id.includes('/src/') || !source.includes('import.meta.env.VITE_LICLICK_PIPELINE_TRACE_ENABLED')) return;
      return transformWithEsbuild(source, id, { define: { 'import.meta.env.VITE_LICLICK_PIPELINE_TRACE_ENABLED': '"false"' }, minifySyntax: true, treeShaking: true });
    }
    const file = id.replaceAll('\\', '/').split('/apps/web/src/')[1];
    if (file && timedFunctions[file]) return { code: instrumentFunctions(source, file, timedFunctions[file]), map: null };
  } };
}
