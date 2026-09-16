import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const source = fs.readFileSync(new URL('../src/components/panels/GeneratePanel.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('GeneratePanel.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let statusExpression, previewJsx;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'previewStatus') {
    statusExpression = node.initializer.getText(ast);
  }
  if (ts.isJsxElement(node) && node.openingElement.attributes.properties.some(attribute =>
    ts.isJsxAttribute(attribute) && attribute.name.getText(ast) === 'className' &&
    attribute.initializer?.getText(ast).includes('generate-preview-adaptive'))) previewJsx = node.getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(statusExpression && previewJsx, 'test executes the real preview selector and JSX');
const code = ts.transpileModule(`function renderPreview() {
  const previewStatus = ${statusExpression};
  return (${previewJsx});
}`, {compilerOptions:{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2022}}).outputText;
const element = (text) => () => React.createElement('span',null,text);
const environment = {
  React, previewResultUrl:undefined, checkerBackgroundStyle:{},
  setPreviewImageOpen:()=>{}, t:value=>value, isTextureMapGeneration:()=>true,
  handleAddProjectedLayer:()=>{}, handleDownloadGenerationImage:()=>{},
  Layers:element('apply-icon'), Download:element('download-icon'), Maximize2:element('zoom-icon'),
  previewProgressOverlayClassName:'gen-preview-progress',
  GenerationProgressStatus:element('running-status'),
  LocalRepaintPreparationStatus:element('preparing-status'),
  getUserFacingGenerationError:value=>value,
};
function render({mode='repaint',running=false,preparing=false,failed=false,cancelled=false,result=false,missing=false}={}) {
  const values = {...environment, displayedTexturePreviewMode:mode,
    displayedPreviewIsGenerating:running, displayedPreviewFailed:failed,
    displayedPreviewCancelled:cancelled,
    localRepaintPreparation:preparing ? {startedAt:1,detail:'preparing'} : undefined,
    displayedPreviewGeneration:missing ? undefined : {
      resultUrl:result ? '/saved-result.png' : undefined, metadata:{error:'failure-detail',cancelled},
    },
  };
  return renderToStaticMarkup(new Function(...Object.keys(values),`${code}; return renderPreview();`)(...Object.values(values)));
}
const titles=['暂无局部重绘结果','running-status','preparing-status','已终止','最近一次生成失败'];
function expectOnly(html,title) {
  assert.deepEqual(titles.filter(text=>html.includes(text)),title ? [title] : [],html);
}
let cases=0;
for(const mode of ['repaint','single']) for(const running of [false,true])
for(const preparing of [false,true]) for(const failed of [false,true])
for(const cancelled of [false,true]) for(const result of [false,true]) {
  const html=render({mode,running,preparing,failed,cancelled,result});
  const title=running ? 'running-status' : mode==='repaint' && preparing ? 'preparing-status'
    : failed ? cancelled ? '已终止' : '最近一次生成失败'
      : mode==='repaint' && !result ? '暂无局部重绘结果' : undefined;
  expectOnly(html,title);
  if(result) assert.ok(html.includes('src="/saved-result.png"'), 'do not discard saved preview');
  cases++;
}
expectOnly(render({missing:true}),'暂无局部重绘结果');
// The cancellation/retry lifecycle must never retain the old empty/error text.
for(const [state,title] of [
  [{preparing:true},'preparing-status'], [{running:true},'running-status'],
  [{failed:true,cancelled:true},'已终止'],
  [{failed:true,cancelled:true,preparing:true},'preparing-status'],
  [{running:true,preparing:true},'running-status'],
  [{failed:true},'最近一次生成失败'], [{result:true},undefined],
]) expectOnly(render(state),title);
console.log(`Preview status: ${cases} real JSX combinations plus empty/cancel/retry/failure/success transitions passed.`);
