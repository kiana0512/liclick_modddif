import type * as THREE from 'three';
import type {Layer} from '@/types/layer';
import type {BakeProgress,BakeProjectedLayerResult,UvBakeResolution} from './uvBakeTypes';
import {createReusableProjectionBakeSignature,cloneProjectionBakeImageData} from './projectionBakeSignature';
import {getMergeUvPostprocessOptions} from '@/engine/layers/mergeUvComposition';
import {createProjectionMaskedImage} from '@/engine/projection/createMaskedProjectedImage';
import {isLocalRepaintProjectedLayer} from './projectedOverlayComposition';
import {useSceneStore} from '@/stores/sceneStore';
import {useLayerStore} from '@/stores/layerStore';
import {useProjectStore} from '@/stores/projectStore';
import {isViewportInteractionBusy} from '@/engine/viewport/viewportInteractionState';
import {cancelMergeFinalPreparation,prepareMergeFinal} from './mergeFinalPreparation';
import {persistentMergeKey,readPersistentMerge,writePersistentMerge} from './persistentMergePreparation';

type Request={projectId:string;objectId:string;resolution:UvBakeResolution;group:THREE.Group;layers:Layer[]};
type Job={signature:string;controller:AbortController;promise:Promise<BakeProjectedLayerResult>};
let job:Job|undefined;
let ready:{signature:string;result:BakeProjectedLayerResult}|undefined;

export function mergePreparationSignature(input:Request) {
  const postprocess=getMergeUvPostprocessOptions(input.resolution);
  return createReusableProjectionBakeSignature({...input,purpose:'merge-uv',optionSignature:[
    `gutter:${postprocess.uvIslandGutterPixels}`,`interior:${postprocess.uvInteriorHolePixels}`,
    `coverage:${postprocess.uvCoverageGapPixels}`,`seam:${postprocess.uvSeamRepairPixels}`,
    'coverage-confidence:0',
  ].join('|')});
}

export function prepareMergeProjection(input:Request,onProgress?:(progress:BakeProgress)=>void,readOnly=false) {
  const signature=mergePreparationSignature(input);
  const copy=(result:BakeProjectedLayerResult)=>readOnly ? result : ({...result,
    imageData:result.imageData ? cloneProjectionBakeImageData(result.imageData) : undefined});
  if(ready?.signature===signature) {
    document.body.dataset.uvMergePreparation='ready';
    if(!readOnly) document.body.dataset.uvMergePreparationRead='ready-hit';
    return Promise.resolve(copy(ready.result));
  }
  if(job?.signature===signature) {
    if(!readOnly) document.body.dataset.uvMergePreparationRead='pending-join';
    return job.promise.then(copy);
  }
  if(!readOnly) document.body.dataset.uvMergePreparationRead='cold';
  job?.controller.abort();
  const controller=new AbortController();
  const guard=()=>{
    if(controller.signal.aborted) throw new DOMException('Projection preparation superseded.','AbortError');
  };
  const promise=(async()=>{
    const startedAt=performance.now();
    const durableKey=await persistentMergeKey(input);
    guard();
    const restored=await readPersistentMerge(durableKey,input.resolution);
    guard();
    if(restored) {
      ready={signature,result:restored};
      document.body.dataset.uvMergePreparation='ready';
      document.body.dataset.uvMergePreparationRead='disk-hit';
      return restored;
    }
    const layers=await Promise.all(input.layers.map(async layer=>
      isLocalRepaintProjectedLayer(layer) && layer.maskUrl ? {...layer,
        imageUrl:await createProjectionMaskedImage(layer.imageUrl, layer.maskUrl, {
          ignoreSourceAlpha: layer.ignoreSourceAlpha ?? true,
        }),
        maskUrl:undefined,ignoreSourceAlpha:false} : layer));
    guard();
    const {bakeVisibleProjectedLayersToTexture}=await import('./bakeProjectedLayerToTexture');
    guard();
    const result=await bakeVisibleProjectedLayersToTexture({objectId:input.objectId,
      transientLayers:layers,resolution:input.resolution,enableBackfaceCulling:true,
      enableDilation:false,dilationPixels:0,...getMergeUvPostprocessOptions(input.resolution),
      repairMissingUvSeams:true,outputAlpha:'transparent',commitToProject:false,
      markSourceLayersBaked:false,skipImageEncoding:true,skipCanvasUpload:true,
      onProgress:progress=>{guard();onProgress?.(progress);},
    });
    guard();
    if(mergePreparationSignature(input)!==signature) throw new DOMException('Projection geometry changed.','AbortError');
    ready={signature,result};
    // Finish the verified write before reporting ready: a subsequent refresh
    // must not race an unfinished cache write and start another full bake.
    await writePersistentMerge(durableKey,result);
    guard();
    document.body.dataset.uvMergePreparation='ready';
    document.body.dataset.uvMergePreparationReport=JSON.stringify({durationMs:performance.now()-startedAt,
      resolution:input.resolution,layers:input.layers.length,performance:result.report.performanceBreakdown});
    return result;
  })();
  const current={signature,controller,promise};job=current;
  void promise.catch(()=>undefined).finally(()=>{if(job===current) job=undefined;});
  return promise.then(copy);
}

/** Session-only preparation. It never writes layers, project revisions or assets. */
export function startMergeProjectionPreparation(options:{projectId:string;resolution:UvBakeResolution;canPrepare:()=>boolean}) {
  let stopped=false,signature='',stableSince=0;
  const invalidate=(clearReady=false)=>{signature='';stableSince=0;job?.controller.abort();if(clearReady) ready=undefined;
    cancelMergeFinalPreparation(clearReady);
    document.body.dataset.uvMergePreparation='invalidated';};
  const unsubscribe=useLayerStore.subscribe((state,previous)=>{if(state.layers!==previous.layers) invalidate();});
  const tick=()=>{
    if(stopped) return;
    const model=useSceneStore.getState().importedModel;
    if(!model || useProjectStore.getState().getCurrentProject()?.id!==options.projectId ||
      model.group.userData.liclickRestorePlaceholder || !options.canPrepare() ||
      document.visibilityState!=='visible' || isViewportInteractionBusy(500)) return;
    const layers=useLayerStore.getState().layers.filter(layer=>layer.type==='projected' && layer.visible &&
      layer.imageUrl && layer.camera && (!layer.objectId || layer.objectId===model.objectId));
    if(layers.length<2) return;
    const input={...options,objectId:model.objectId,group:model.group,layers};
    const next=mergePreparationSignature(input);
    const prepareFinal=(result:BakeProjectedLayerResult)=>{
      if(!result.imageData || stopped) return;
      // The visible-projection toolbar passes projected IDs only. Visible UV
      // underlays remain separate layers; including them here guarantees a
      // final-cache miss (and would be wrong to force-reuse at commit).
      // Explicit selected-UV merges keep their exact keyed fallback.
      void prepareMergeFinal(next,result.imageData,[]).catch(()=>{
        document.body.dataset.uvMergeFinalPreparation='unavailable';
      });
    };
    if(next!==signature) {signature=next;stableSince=performance.now();job?.controller.abort();return;}
    if(ready?.signature===next) {document.body.dataset.uvMergePreparation='ready';prepareFinal(ready.result);return;}
    if(performance.now()-stableSince<1500 || job) return;
    document.body.dataset.uvMergePreparation='preparing';
    void prepareMergeProjection(input,undefined,true).then(prepareFinal).catch(error=>{
      if(error instanceof Error && error.name==='AbortError') return;
      document.body.dataset.uvMergePreparation='unavailable';
      // Retry only after an authored change; failed preparation never blocks Merge.
      stableSince=Infinity;
    });
  };
  const timer=window.setInterval(tick,500);
  return ()=>{stopped=true;window.clearInterval(timer);unsubscribe();invalidate(true);delete document.body.dataset.uvMergePreparation;};
}
