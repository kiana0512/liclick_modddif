import type { GenerationJob } from '../routes/liclick.js';
import { submitLiclickImageJob, type GenerateImageInput, type LiclickImageSubmission } from './liclickGenerationService.js';

// MULTIVIEW-REFERENCE-PIPELINE/1.0.0. User-tested Sunburst low -> medium.
// REFERENCE-DELIGHT-PROMPT/1.2.0: preserve midtones, suppress highlights, lift shadows conservatively.
export const referenceDelightPrompt = `对输入图片进行去光照编辑，输出接近 Base Color / Albedo 的材质颜色参考图。最高优先级是保持原图的基础配色，只修正明确由光照造成的颜色变化。

处理优先级：保留基础色和正常中间调 > 消除高光与反射 > 减弱阴影。若完全消除阴影会明显提亮材质或改变原有色调，优先保留颜色，允许少量残留明暗，不强求所有表面亮度完全一致。

一、锁定基础色

将原图中每种材质面积较大、颜色稳定、没有明显高光或深阴影的中间调区域，作为该材质的颜色基准。保留这一基准的色相、饱和度和明度，不以最亮区域、反光区域或最鲜艳区域作为底色。如果存在多个合理基准，选择最常见的正常中间调，不主动选择更亮的一个，也不把深阴影当作底色。

颜色已经均匀、没有明显光照干扰的区域保持原样。不要为了使整个物体更明亮、更干净或更好看而重新上色。

保留原有的具体色调与深浅程度：暗红仍是暗红，灰蓝仍是灰蓝，米白仍是米白，深色材料仍保持深色。不要将它们替换成更鲜亮、更纯、更浅或更中性的颜色。

多个视图中相同材质共用同一颜色基准，不分别调色，不向最亮的视图对齐。不同材质和原有的真实颜色分区分别处理，不强行统一。

二、仅去除光照影响

去除明确的方向性明暗、镜面高光、环境反射、投射阴影、接触阴影、环境遮蔽（AO）、轮廓亮边，以及沿圆管、弧面和倒角出现的明暗光带。

先消除高光、亮边和反射带，再谨慎修正明确的阴影。不要把去光照理解为补光、曝光校正或暗部增强，不通过抬升整片表面来减弱明暗差异。

只在受到这些光照影响的区域进行局部修正：
- 阴影仅做必要的局部补偿，向同材质的正常中间调靠近，不超过基准亮度；不要把所有暗部全部填成同一块明亮底色，不强行提亮整个内腔或凹面。
- 高光与反光区域恢复到同材质的颜色基准，不留下白斑或反射色。
- 正常中间调区域不随阴影和高光的修正而一起变亮、变暗或改变颜色。
- 裸露金属沿用原图非高光区域的稳定色调，不统一改成亮银色或纯灰色。

明显减弱连续同色表面上由受光方向造成的亮侧、暗侧和曲面光带，保留真实颜色变化。基础色稳定比完全消除细微明暗更重要。

无法确定某处是材质色差还是光照时，优先保留原有颜色和纹理，不擅自大面积改色。

三、保留纹理与结构

保留真实的图案、文字、贴花、纹理颗粒、污渍、锈迹、掉漆和磨损。不要把深色污渍当成阴影消除，也不要把真实浅色图案当成高光去除。

保留凹槽、接缝、孔洞、裂缝、细小零件和遮挡关系。仅去掉它们周围由光照产生的暗晕或亮边，不填平孔洞、不合并零件、不模糊边缘。

严格保持原图尺寸、视图数量、排版、相机角度、物体位置、大小、轮廓、比例、结构和开合状态不变。

四、禁止整体调色

不要调整整体曝光、亮度、对比度、饱和度、色温或白平衡。
不要自动增强颜色、提鲜、泛白、灰化或统一覆盖颜色。
不要用模糊、磨皮、卡通化或纯色色块替代去光照。
不要为了表现立体感或金属感重新添加光影。

最终结果应保持原图正常中间调的深浅程度和材质纹理，尤其不要让大面积有色表面显得更浅、更鲜亮或像增加了曝光。既不整体提亮，也不靠整体压暗补救；只修正明确的光照区域。允许外观变得平坦，也允许为保色保留极弱明暗，不追求摄影式立体感。

保留原有背景颜色和透明区域，移除额外地面投影。只输出编辑后的图片，不添加说明、标签、边框、水印或额外视图。`;

/** REFERENCE-LIGHTING/1.0.0: one editing request, using the shared color-preserving prompt. */
export function prepareReferencePipelineInput(input: GenerateImageInput): GenerateImageInput {
  if (input.referencePipeline === 'six-view-delight-v1') return { ...input, model: 'gpt-image-2.5-sunburst', quality: 'low', count: 1 };
  if (input.referencePipeline === 'delight-only-v1') return { ...input,
    prompt: referenceDelightPrompt, model: 'gpt-image-2.5-sunburst', quality: 'medium', count: 1,
    aspectRatio: 'auto', imageSize: 'auto',
  };
  return input;
}

export function referenceStageMessage(job: GenerationJob) {
  if (!job.input.referencePipeline) return undefined;
  if (job.input.referencePipeline === 'delight-only-v1') return '光照处理中';
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
