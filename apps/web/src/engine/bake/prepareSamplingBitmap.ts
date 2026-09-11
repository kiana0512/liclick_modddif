let worker:Worker|undefined,nextId=0;
const pending=new Map<number,{resolve:(image:ImageBitmap|ImageData)=>void;reject:(error:Error)=>void}>();

/** Software Canvas conversion is deliberately kept off the input thread.
 * The worker owns its private input/output; no authored canvas is transferred.
 */
export function prepareSamplingBitmap(blob:Blob,maxDimension:number):Promise<ImageBitmap>;
export function prepareSamplingBitmap(blob:Blob,maxDimension:number,pixels:boolean):Promise<ImageBitmap|ImageData>;
export async function prepareSamplingBitmap(blob:Blob,maxDimension:number,pixels=false) {
    if(!worker) {
      const current=new Worker(new URL('../../workers/prepareSamplingBitmap.worker.ts',import.meta.url),{type:'module'});
      current.onmessage=({data}:{data:{id:number;bitmap?:ImageBitmap;pixels?:ArrayBuffer;width:number;height:number;error?:string}})=>{
        const request=pending.get(data.id);pending.delete(data.id);
        if(!request) {data.bitmap?.close();return;}
        if(data.bitmap) request.resolve(data.bitmap);
        else if(data.pixels) request.resolve(new ImageData(new Uint8ClampedArray(data.pixels),data.width,data.height));
        else request.reject(new Error(data.error||'Sampling bitmap preparation failed.'));
      };
      current.onerror=event=>{
        for(const request of pending.values()) request.reject(new Error(event.message||'Sampling worker failed.'));
        pending.clear();current.terminate();if(worker===current)worker=undefined;
      };
      worker=current;
    }
    const current=worker,id=++nextId;
    return await new Promise<ImageBitmap|ImageData>((resolve,reject)=>{
      pending.set(id,{resolve,reject});
      try {current.postMessage({id,blob,maxDimension,pixels});}
      catch(error) {pending.delete(id);reject(error);}
    });
}
