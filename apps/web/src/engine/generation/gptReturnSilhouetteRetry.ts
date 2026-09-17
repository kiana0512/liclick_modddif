import type { Generation } from '@/types/generation';

// GPT-RETURN-SILHOUETTE-QA/1.2.0 and GPT-SILHOUETTE-RETRY/1.0.1.
export const GPT_SILHOUETTE_RETRY_LIMIT = 1;
export const SILHOUETTE_RETRY_FAILURE_MESSAGE = '远端回图构图漂移，已保留结果并自动重试当前视角一次。';

const retryMarker = '【轮廓对齐重试】';

export function buildTextureMapSilhouetteRetryPrompt(prompt: string) {
  if (prompt.includes(retryMarker)) return prompt;
  return `${prompt}\n\n${retryMarker}
上一次输出因主体移动、缩放、裁切或在透明区生成背景而被拒绝。本次必须逐像素保持图一的画布坐标、主体外轮廓、内部孔洞、占图比例和透明区域：图一透明的像素继续保持透明，禁止添加背景、地面、投影、光晕、烟雾、边框或轮廓外颜色；禁止移动、缩放、放大、裁切或重新构图主体。只在图一原有非透明轮廓内部补充材质。`;
}

export function createTextureMapSilhouetteRetryId(generationId: string) {
  return `${generationId}-silhouette-retry-1`;
}

export function silhouetteRetryAttempt(metadata: Record<string, unknown>) {
  return typeof metadata.silhouetteRetryAttempt === 'number'
    ? metadata.silhouetteRetryAttempt
    : 0;
}

export function isGptReturnSilhouetteMismatch(error: unknown) {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'GPT_RETURN_SILHOUETTE_MISMATCH',
  );
}

export function terminalSilhouetteRetryError() {
  return new Error('远端回图连续两次与模型轮廓不对齐，已保留两次结果并停止回贴。');
}

export function createTextureMapSilhouetteRetry(failed: Generation) {
  const id = createTextureMapSilhouetteRetryId(failed.id);
  const prompt = buildTextureMapSilhouetteRetryPrompt(failed.prompt);
  return {
    viewLabel: String(failed.metadata.cameraViewLabel ?? '当前视角'),
    generation: {
      ...failed,
      id,
      prompt,
      resultUrl: undefined,
      status: 'running' as const,
      metadata: {
        ...failed.metadata,
        clientGenerationId: id,
        serverJobId: undefined,
        taskId: undefined,
        completedAt: undefined,
        error: undefined,
        returnQaRejected: undefined,
        returnQaErrorCode: undefined,
        silhouetteRetryGenerationId: undefined,
        framingRestored: undefined,
        generationFraming: undefined,
        serverSubmitted: false,
        startedAt: new Date().toISOString(),
        silhouetteRetryOf: failed.id,
        silhouetteRetryAttempt: 1,
      },
    },
  };
}
