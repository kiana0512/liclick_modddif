let worker:Worker|undefined,nextId=0;
const pending=new Map<number,{resolve:(bitmap:ImageBitmap)=>void;reject:(error:Error)=>void}>();

/** Software Canvas conversion is deliberately kept off the input thread.
 * The worker owns its private input/output; no authored canvas is transferred.
 */
export async function prepareSamplingBitmap(blob:Blob,maxDimension:number) {
    if(!worker) {
      const current=new Worker(new URL('../../workers/prepareSamplingBitmap.worker.ts',import.meta.url),{type:'module'});
      current.onmessage=({data}:{data:{id:number;bitmap?:ImageBitmap;error?:string}})=>{
        const request=pending.get(data.id);pending.delete(data.id);
        if(!request) {data.bitmap?.close();return;}
        if(data.bitmap) request.resolve(data.bitmap);
        else request.reject(new Error(data.error||'Sampling bitmap preparation failed.'));
      };
      current.onerror=event=>{
        for(const request of pending.values()) request.reject(new Error(event.message||'Sampling worker failed.'));
        pending.clear();current.terminate();if(worker===current)worker=undefined;
      };
      worker=current;
    }
    const current=worker,id=++nextId;
    return await new Promise<ImageBitmap>((resolve,reject)=>{
      pending.set(id,{resolve,reject});
      try {current.postMessage({id,blob,maxDimension});}
      catch(error) {pending.delete(id);reject(error);}
    });
}
