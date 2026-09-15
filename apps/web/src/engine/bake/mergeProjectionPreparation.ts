import type * as THREE from 'three';
import type {Layer} from '@/types/layer';
import type {BakeProgress,BakeProjectedLayerResult,UvBakeResolution} from './uvBakeTypes';
import {createReusableProjectionBakeSignature,cloneProjectionBakeImageData} from './projectionBakeSignature';
import {getMergeUvPostprocessOptions} from '@/engine/layers/mergeUvComposition';
import {prepareMergeProjectionLayers} from './prepareMergeProjectionLayers';
import {useSceneStore} from '@/stores/sceneStore';
import {useLayerStore} from '@/stores/layerStore';
import {useProjectStore} from '@/stores/projectStore';
import {isViewportInteractionBusy} from '@/engine/viewport/viewportInteractionState';
import {cancelMergeFinalPreparation,prepareMergeFinal} from './mergeFinalPreparation';
import {persistentMergeKey,readPersistentMerge,writePersistentMerge} from './persistentMergePreparation';
import {isFlattenableUvMergeSource,compareUvMergeSources} from '@/engine/layers/mergeUvComposition';
import {isResidentUvManaged} from '@/engine/projection/residentUvPresentation';

type Request={projectId:string;objectId:string;resolution:UvBakeResolution;group:THREE.Group;layers:Layer[]};
type Job={signature:string;controller:AbortController;promise:Promise<BakeProjectedLayerResult>};
let job:Job|undefined;
let ready:{signature:string;result:BakeProjectedLayerResult}|undefined;
let selection:{objectId?:string;ids:string[];explicit:boolean}|undefined;
/** UI publishes intent only; source selection and all preparation remain in the engine. */
export function setMergePreparationSelection(objectId:string|undefined,ids:string[],explicit=false) {
  const current={objectId,ids,explicit};selection=current;
  return ()=>{if(selection===current) selection=undefined;};
}

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
  const copy=async(result:BakeProjectedLayerResult)=>readOnly ? result : ({...result,
    imageData:result.imageData ? await cloneProjectionBakeImageData(result.imageData) : undefined});
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
    const layers=await prepareMergeProjectionLayers(input.layers);
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
    // The viewport already maintains this derived UV. A second speculative bake
    // competes for the same serial queue after every eye click. Explicit merge
    // still calls prepareMergeProjection and retains all validation/persistence.
    if (model && isResidentUvManaged(model.group)) return;
    if(!model || useProjectStore.getState().getCurrentProject()?.id!==options.projectId ||
      model.group.userData.liclickRestorePlaceholder || !options.canPrepare() ||
      document.visibilityState!=='visible' || isViewportInteractionBusy(500)) return;
    const selected=selection;
    const authored=useLayerStore.getState().layers;
    const selectedIds=selected?.objectId===model.objectId && (selected.ids.length>1 || selected.explicit) ? new Set(selected.ids) : undefined;
    const candidates=authored.filter(layer=>(!layer.objectId || layer.objectId===model.objectId) &&
      (selectedIds ? selectedIds.has(layer.id) : layer.visible));
    const layers=candidates.filter(layer=>layer.type==='projected' && layer.imageUrl && layer.camera);
    if(!layers.length) return;
    const underlays=candidates.filter(isFlattenableUvMergeSource).sort(compareUvMergeSources);
    const input={...options,objectId:model.objectId,group:model.group,layers};
    const next=mergePreparationSignature(input);
    const prepareFinal=(result:BakeProjectedLayerResult)=>{
      if(!result.imageData || stopped || selection!==selected || signature!==next) return;
      // Match the current explicit selection, including its ordered UV sources.
      // With no multiple selection, the toolbar still prepares projections only.
      void prepareMergeFinal(next,result.imageData,underlays).catch(()=>{
        document.body.dataset.uvMergeFinalPreparation='unavailable';
      });
    };
    if(next!==signature) {signature=next;stableSince=performance.now();job?.controller.abort();return;}
    if(ready?.signature===next) {document.body.dataset.uvMergePreparation='ready';prepareFinal(ready.result);return;}
    if(performance.now()-stableSince<250 || job) return;
    document.body.dataset.uvMergePreparation='preparing';
    void prepareMergeProjection(input,undefined,true).then(prepareFinal).catch(error=>{
      if(error instanceof Error && error.name==='AbortError') return;
      document.body.dataset.uvMergePreparation='unavailable';
      document.body.dataset.uvMergePreparationError=error instanceof Error ? error.message : String(error);
      // Retry only after an authored change; failed preparation never blocks Merge.
      stableSince=Infinity;
    });
  };
  const timer=window.setInterval(tick,250);
  return ()=>{stopped=true;window.clearInterval(timer);unsubscribe();invalidate(true);delete document.body.dataset.uvMergePreparation;};
}
