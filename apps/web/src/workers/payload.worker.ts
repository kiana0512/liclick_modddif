export {};

type ReadRequest={cacheName:string;requestUrl:string;resolution:number};
type InteractionRequest=ArrayBuffer|Blob|null;
type ReadResponse=
  | {status:'hit';bytes:ArrayBuffer;pixelOffset:number;metadata:Record<string,unknown>}
  | {status:'miss'}
  | {status:'error';message:string};

const scope=self as unknown as {
  onmessage:((event:MessageEvent<ReadRequest|InteractionRequest>)=>void)|null;
  postMessage(message:ReadResponse|0|null|[unknown],transfer?:Transferable[]):void;
};
let interactionResult:unknown;

const hash=async(bytes:Uint8Array<ArrayBuffer>)=>Array.from(
  new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),
  byte=>byte.toString(16).padStart(2,'0'),
).join('');

/** UV-PERSISTENT-MERGE-READ/1.1.0: materialize and verify the exact cached
 * 4K RGBA payload away from the presentation thread, then transfer ownership. */
scope.onmessage=async({data})=>{
  if(!data) {scope.postMessage([interactionResult]);return;}
  if(!('cacheName' in data)) {
    try {
      interactionResult=data instanceof Blob
        ? new FileReaderSync().readAsDataURL(data)
        : JSON.parse(new TextDecoder().decode(data));
      scope.postMessage(0);
    } catch {scope.postMessage(null);}
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
