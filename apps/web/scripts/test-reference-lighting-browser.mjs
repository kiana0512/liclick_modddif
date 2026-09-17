import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {fileURLToPath,pathToFileURL} from 'node:url';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const root=fileURLToPath(new URL('..',import.meta.url));process.chdir(root);
const fixture=`
import React from '/node_modules/.vite/deps/react.js';
import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
import {ReferenceGroupPicker} from '/src/components/panels/ReferenceGroupPicker.tsx';
import {useReferenceStore} from '/src/stores/referenceStore.ts';
import '/src/styles/globals.css';
const image='data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="30" height="20"><rect width="30" height="20" fill="red"/></svg>';
useReferenceStore.getState().setReferences([
 {id:'single',name:'单视图',url:image,width:30,height:20,isPrimary:true,referenceRole:'single-view'},
 {id:'multi',name:'上传的多视图',url:image,width:30,height:20,isPrimary:false,referenceRole:'multi-view'},
]);
window.calls=[];window.refs=useReferenceStore;
const host=document.createElement('div');host.style.width='300px';document.body.append(host);
const root=ReactDOM.createRoot(host);
window.renderPicker=(disabled=false)=>root.render(React.createElement(ReferenceGroupPicker,{disabled,onGenerateMultiview:r=>window.calls.push(r.id)}));
window.renderPicker();
`;
const server=await createServer({root,configFile:false,appType:'custom',esbuild:{jsx:'automatic'},resolve:{alias:{'@':root+'/src'}},optimizeDeps:{entries:[],include:['react','react-dom/client','react/jsx-runtime','react/jsx-dev-runtime','react-dom','three','three-stdlib','zustand','lucide-react']},server:{host:'127.0.0.1',port:0}});
server.middlewares.use('/fixture.mjs',(_req,res)=>{res.setHeader('content-type','text/javascript');res.end(fixture);});
server.middlewares.use('/__lighting',(_req,res)=>{res.setHeader('content-type','text/html');res.end('<!doctype html><script type="module" src="/fixture.mjs"></script>');});
await server.listen();const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error(e.message);});page.on('console',m=>{if(m.type()==='error')console.error(m.text());});
 await page.goto(server.resolvedUrls.local[0]+'__lighting');
 const menus=page.getByRole('button',{name:'图片功能',exact:true});await menus.first().waitFor();
 await menus.first().click({force:true});await page.getByRole('menuitem',{name:'生成多视图',exact:true}).click();
 await menus.nth(1).click({force:true});assert.equal(await page.getByRole('menuitem',{name:'生成多视图',exact:true}).count(),0);
 await page.getByRole('menuitem',{name:'光照处理',exact:true}).click();
 assert.deepEqual(await page.evaluate(()=>window.calls),['single','multi']);
 assert.deepEqual(await page.evaluate(()=>window.refs.getState().selectedReferenceIds),['multi']);
 await page.evaluate(()=>window.renderPicker(true));await page.waitForFunction(()=>[...document.querySelectorAll('[aria-label="图片功能"]')].every(b=>b.disabled));
 assert.deepEqual(errors,[]);console.log('Reference menu: single generates six views; uploaded multi sends itself to lighting; locked state disables actions.');
}finally{await browser.close();await server.close();}
