import {prewarmPreviewTextures, promotePreparedPreviewTexture, releasePreviewTexture, retainPreviewTexture} from '@/engine/viewport/previewTextureCache';

type Entry={blob:Blob;url:string;unpin:()=>void;ready:boolean;disposed:boolean};
let current:Entry|undefined;

function dispose(entry:Entry, promoted=false) {
  if(entry.disposed) return;
  entry.disposed=true;
  if(!promoted) releasePreviewTexture(entry.url);
  entry.unpin();
  URL.revokeObjectURL(entry.url);
}

export function clearPreparedMergePreview() {
  const entry=current;current=undefined;
  // An in-flight decode/upload owns its pin until its finally block runs.
  if(entry?.ready) dispose(entry);
}

/** One bounded full-resolution GPU preview; PNG bytes and project state unchanged. */
export async function prepareMergePreview(blob:Blob) {
  if(current?.blob===blob) return;
  clearPreparedMergePreview();
  const url=URL.createObjectURL(blob);
  const entry:Entry={blob,url,unpin:retainPreviewTexture(url),ready:false,disposed:false};
  current=entry;
  try {
    const results=await prewarmPreviewTextures([url],{shouldCancel:()=>current!==entry});
    if(current!==entry || results.some(result=>result.status!=='fulfilled')) return;
    entry.ready=true;
    document.body.dataset.uvMergeGpuPreparation='ready';
  } finally {
    if(!entry.ready) {
      if(current===entry) current=undefined;
      dispose(entry);
    }
  }
}

/** Call only with the URL returned by saving this same immutable Blob. */
export function adoptPreparedMergePreview(blob:Blob, assetUrl:string) {
  const entry=current;
  if(!entry?.ready || entry.blob!==blob || !promotePreparedPreviewTexture(entry.url,assetUrl)) return false;
  current=undefined;
  // Protect the new key while releasing the temporary owner's old-key pin.
  const unpinAsset=retainPreviewTexture(assetUrl);
  dispose(entry,true);
  unpinAsset();
  document.body.dataset.uvMergeGpuPreparation='adopted';
  return true;
}
