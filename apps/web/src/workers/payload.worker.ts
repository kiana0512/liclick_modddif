export {};
import type { PipelineTraceContext, WorkerTraceTiming } from '@/engine/performance/tracing/types';
import { beginWorkerTrace } from '@/engine/performance/tracing/workerTrace';

type ReadRequest={cacheName:string;requestUrl:string;resolution:number};
type InteractionRequest=ArrayBuffer|Blob|null;
type TracedInteractionRequest={type:'pipeline-payload';traceContext:PipelineTraceContext;payload:ArrayBuffer|Blob};
type ReadResponse=
  | {status:'hit';bytes:ArrayBuffer;pixelOffset:number;metadata:Record<string,unknown>}
  | {status:'miss'}
  | {status:'error';message:string};

const scope=self as unknown as {
  onmessage:((event:MessageEvent<ReadRequest|InteractionRequest|TracedInteractionRequest>)=>void)|null;
  postMessage(message:ReadResponse|0|null|[unknown]|{type:'pipeline-payload-timing';timing:WorkerTraceTiming},transfer?:Transferable[]):void;
};
let interactionResult:unknown;

const hash=async(bytes:Uint8Array<ArrayBuffer>)=>Array.from(
  new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),
  byte=>byte.toString(16).padStart(2,'0'),
).join('');

/** UV-PERSISTENT-MERGE-READ/1.1.0: materialize and verify the exact cached
 * 4K RGBA payload away from the presentation thread, then transfer ownership. */
scope.onmessage=async({data})=>{
  let traceContext:PipelineTraceContext|undefined;
  if(import.meta.env.VITE_LICLICK_PIPELINE_TRACE_ENABLED==='true'&&data&&'traceContext' in data&&'payload' in data&&data.type==='pipeline-payload') {traceContext=data.traceContext;data=data.payload;}
  if(!data) {scope.postMessage([interactionResult]);return;}
  if(!('cacheName' in data)) {
    const finishTrace=import.meta.env.VITE_LICLICK_PIPELINE_TRACE_ENABLED==='true'&&traceContext
      ?beginWorkerTrace(traceContext,data instanceof Blob?'result.blob.encode':'result.json.parse','sync'):undefined;
    try {
      interactionResult=data instanceof Blob
        ? new FileReaderSync().readAsDataURL(data)
        : JSON.parse(new TextDecoder().decode(data as ArrayBuffer));
      if(import.meta.env.VITE_LICLICK_PIPELINE_TRACE_ENABLED==='true'&&finishTrace) {try {scope.postMessage({type:'pipeline-payload-timing',timing:finishTrace()});} catch { /* Keep the decoded result. */ }}
      scope.postMessage(0);
    } catch {
      if(import.meta.env.VITE_LICLICK_PIPELINE_TRACE_ENABLED==='true'&&finishTrace) {try {scope.postMessage({type:'pipeline-payload-timing',timing:{...finishTrace(),status:'error'}});} catch { /* Preserve the original failure. */ }}
      scope.postMessage(null);
    }
    return;
  }
  try {
    const response=await (await caches.open(data.cacheName)).match(new Request(data.requestUrl));
    if(!response) {scope.postMessage({status:'miss'});return;}
    const bytes=new Uint8Array(await response.arrayBuffer());
    if(bytes.length<4 || await hash(bytes)!==response.headers.get('x-li3d-sha256')) {
      scope.postMessage({status:'miss'});return;
    }
    const size=new DataView(bytes.buffer).getUint32(0,true);
    if(size>1_000_000 || bytes.length!==4+size+data.resolution*data.resolution*4) {
      scope.postMessage({status:'miss'});return;
    }
    const metadata=JSON.parse(new TextDecoder().decode(bytes.subarray(4,4+size))) as Record<string,unknown>;
    const report=(metadata.report??{}) as {width?:number;height?:number};
    if(report.width!==data.resolution || report.height!==data.resolution) {
      scope.postMessage({status:'miss'});return;
    }
    scope.postMessage({status:'hit',bytes:bytes.buffer,pixelOffset:4+size,metadata},[bytes.buffer]);
  } catch(error) {
    scope.postMessage({status:'error',message:error instanceof Error?error.message:String(error)});
  }
};
