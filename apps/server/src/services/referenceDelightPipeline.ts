import type { GenerationJob } from '../routes/liclick.js';
import { submitLiclickImageJob, type LiclickImageSubmission } from './liclickGenerationService.js';

// MULTIVIEW-REFERENCE-PIPELINE/1.0.0. User-tested Sunburst low -> medium.
export const referenceDelightPrompt = `对输入图片进行材质去光照编辑，输出接近 Base Color / Albedo 的无光照颜色参考图。

仅编辑光照造成的颜色变化。严格保持原图尺寸、视图数量、排版、相机角度、物体位置、大小、轮廓、结构、零件、开合状态和遮挡关系不变。不重新设计或重新构图，不增删物体及零件。

去除方向性明暗、投射阴影、接触阴影、环境遮蔽（AO）、镜面高光、环境反射、轮廓亮边，以及沿曲面出现的明暗光带。用对应材质的合理固有颜色恢复这些区域，而不是简单提亮暗部或压暗亮部。

从同一材质中未明显受到高光、阴影和反射影响的区域推定底色。同一连续、同色表面的底色不应因朝向、曲率、深度或视角而变化；多个视图中对应材质的底色应保持一致。

保留真实的材质分区、固有色差、图案、文字、贴花、纹理颗粒、锈迹、污渍、掉漆和磨损。消除随受光方向形成的渐变，不抹除真实的颜色渐变和纹理变化。不要将高光白斑、反射色或遮挡暗部保留为材质图案。

分别处理不同材质：

- 有色表面保留原有色相和饱和度，去除受光亮侧与背光暗侧。
- 裸露金属保留合理的金属固有色及真实磨损，去除镜面倒影、闪亮白线和黑白反光条带。
- 黑色和深色材质仍保持真实深色，不为了去阴影统一提亮。
- 白色和浅色材质保留纹理与局部色差，不变成过曝纯白。

凹槽、接缝、孔洞和突出部件保持原有几何边界。去除凹处人为加深的遮蔽阴影和凸边高光，但保留真实深色材料、真实裂缝以及透出背景的空隙。不要填平孔洞、合并细小零件或模糊边缘。

不要用全局亮度调整、降低对比度、降低饱和度、均匀灰色覆盖、模糊或磨皮代替去光照。不要改成卡通、矢量插画或描边风格。

允许结果显得平坦、缺少摄影式立体感。通过轮廓、遮挡和材质边界保留结构，不为增强真实感、金属感或立体感重新添加光影。

保留原有背景颜色和透明区域，清除额外地面投影。只输出编辑后的图片，不添加说明文字、边框、水印或额外视图。`;

export function referenceStageMessage(job: GenerationJob) {
  if (!job.input.referencePipeline) return undefined;
  return job.referenceDelight ? '第二步：去光照（Sunburst 中质量）' : '第一步：生成六视图（Sunburst 低质量）';
}

/** Called under the existing per-job submission/poll lock; never publish stage one. */
export async function advanceReferenceDelight(
  job: GenerationJob, result: Pick<LiclickImageSubmission, 'resultUrl'>,
  save: (strict?: boolean) => Promise<void>, submit = submitLiclickImageJob,
) {
  if (job.input.referencePipeline !== 'six-view-delight-v1' || !result.resultUrl) return false;
  if (job.referenceDelight) {
    if (job.referenceDelight.stage === 'running') job.referenceDelight.stage = 'complete';
    return false;
  }
  job.referenceDelight = { stage: 'submitting', inputUrl: result.resultUrl,
    sourceTaskId: job.taskId, prompt: referenceDelightPrompt };
  job.taskId = undefined;
  job.terminalWithoutResultAt = undefined;
  job.nextPollAt = undefined;
  job.recoveryPollIntervalMs = undefined;
  job.pollFailureCount = 0;
  job.status = 'running';
  job.resultUrl = undefined; job.resultUrls = undefined; job.raw = undefined;
  job.message = referenceStageMessage(job);
  try {
    // Persist the submission intent BEFORE any second paid request. After an
    // interrupted/ambiguous submission, recovery must not blindly resubmit it.
    await save(true);
    if (job.status !== 'running') return true;
    const next = await submit({ ...job.input, referencePipeline: undefined,
      prompt: job.referenceDelight.prompt, model: 'gpt-image-2.5-sunburst', quality: 'medium', count: 1,
      references: [{ id: `${job.id}-six-view`, name: 'six-view.png', url: result.resultUrl }],
    }, { atlasHomeDir: job.atlasHomeDir });
    job.taskId = next.taskId;
    if (job.status !== 'running') { await save(); return true; }
    job.model = next.model; job.extraParams = next.extraParams;
    job.uploadedReferences = next.uploadedReferences; job.raw = next.raw;
    job.referenceDelight.stage = next.resultUrl ? 'complete' : 'running';
    job.status = next.resultUrl ? 'succeeded' : 'running';
    job.resultUrl = next.resultUrl; job.resultUrls = next.resultUrls;
    job.updatedAt = new Date().toISOString();
    await save(true);
  } catch (error) {
    // Cancellation can mutate the job while submission/persistence is awaited.
    if ((job as GenerationJob).status !== 'failed') {
      job.status = 'failed';
      job.resultUrl = undefined; job.resultUrls = undefined;
      job.error = `去光照提交未完成，已保留第一轮记录；不会自动重复提交：${error instanceof Error ? error.message : String(error)}`;
      job.updatedAt = new Date().toISOString();
      await save();
    }
  }
  return true;
}
