export {};
const scope=self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage=async({data}:{data:{id:number;blob:Blob;maxDimension:number;pixels?:boolean}})=>{
  const {id,blob,maxDimension,pixels}=data;
  let bitmap:ImageBitmap|undefined,canvas:OffscreenCanvas|undefined,output:ImageBitmap|undefined;
  try {
    bitmap=await createImageBitmap(blob);
    const scale=Math.min(1,maxDimension/Math.max(bitmap.width,bitmap.height));
    const width=Math.max(1,Math.round(bitmap.width*scale)),height=Math.max(1,Math.round(bitmap.height*scale));
    canvas=new OffscreenCanvas(width,height);
    const context=canvas.getContext('2d',{willReadFrequently:true});
    if(!context) throw new Error('Sampling canvas unavailable.');
    context.imageSmoothingEnabled=true;context.imageSmoothingQuality='high';
    context.drawImage(bitmap,0,0,width,height);
    if(pixels) {
      const bytes=context.getImageData(0,0,width,height).data.buffer;
      scope.postMessage({id,pixels:bytes,width,height},[bytes]);
      return;
    }
    output=canvas.transferToImageBitmap();
    scope.postMessage({id,bitmap:output},[output]);output=undefined;
  } catch(error) {
    scope.postMessage({id,error:error instanceof Error?error.message:String(error)});
  } finally {
    bitmap?.close();output?.close();if(canvas)canvas.width=canvas.height=1;
  }
};
