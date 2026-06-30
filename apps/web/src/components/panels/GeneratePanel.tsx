import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, Image, ImagePlus, Layers, Maximize2, Plus, Settings, Sparkles, Square, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Panel } from '@/components/ui/Panel';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { AutoBakeProgressBar, type AutoBakeProgress } from '@/components/panels/AutoBakeProgressBar';
import { applyBakedTextureToObject } from '@/engine/bake/applyBakedTexture';
import { bakeVisibleProjectedLayersToTexture } from '@/engine/bake/bakeProjectedLayerToTexture';
import { captureCurrentView } from '@/engine/capture/captureCurrentView';
import { createMaskedProjectedImage } from '@/engine/projection/createMaskedProjectedImage';
import { ReferenceImagePicker } from '@/components/panels/ReferenceImagePicker';
import { devLogin } from '@/services/authApiClient';
import { runFeishuLoginFlow } from '@/services/feishuLoginFlow';
import {
  createLiclickApiClient,
  type LiclickAspectRatio,
  type LiclickImageModel,
  type LiclickImageSize,
} from '@/services/liclickApiClient';
import { useAuthStore } from '@/stores/authStore';
import { useGenerationStore } from '@/stores/generationStore';
import { useT } from '@/stores/i18nStore';
import { useLayerStore } from '@/stores/layerStore';
import { useProjectStore } from '@/stores/projectStore';
import { useReferenceStore } from '@/stores/referenceStore';
import { useSceneStore } from '@/stores/sceneStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useToastStore } from '@/stores/toastStore';
import type { Capture } from '@/types/capture';
import type { Generation } from '@/types/generation';
import type { Layer } from '@/types/layer';
import type { ReferenceImage } from '@/types/project';
import { getRegisteredObjectUrlBlob } from '@/utils/blobUrlRegistry';
import { createId } from '@/utils/id';
import { downloadImageAsset } from '@/utils/downloadImage';
import {
  isWorkspaceAssetUrl,
  saveBlobAsset,
  saveDataUrlAsset,
  saveProject as saveWorkspaceProject,
  saveRemoteUrlAsset,
  urlToDataUrl,
  type AssetCategory,
} from '@/services/workspaceApiClient';

type GenerateTab = 'single' | 'multiview';
type GenerateMode = 'visible' | 'upscale';
type GenerateNotice = {
  tone: 'info' | 'warning' | 'error';
  message: string;
};
const resolutionToSize = {
  '1K': 1024,
  '2K': 2048,
  '4K': 4096,
  '8K': 8192,
} as const;

const imageModels: { value: LiclickImageModel; label: string }[] = [
  { value: 'gpt-image-2', label: 'GPT-Image 2' },
  { value: 'nano_banana_2', label: 'Nano Banana 2' },
  { value: 'nano_banana_pro', label: 'Nano Banana Pro' },
  { value: 'gpt-image-1.5', label: 'GPT-Image 1.5' },
  { value: 'doubao-seedream-4-5-251128', label: 'Seedream 4.5' },
  { value: 'midjourney-7', label: 'Midjourney V7' },
];

const aspectRatios: LiclickAspectRatio[] = ['auto', '1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16'];
const imageSizes: LiclickImageSize[] = ['auto', '1K', '2K', '4K'];
const pendingSubmissionTimeoutMs = 3 * 60 * 1000;
const autoBakeProgressHideDelayMs = 1600;
const defaultImageGenerationSettings = {
  model: 'gpt-image-2' as LiclickImageModel,
  aspectRatio: 'auto' as LiclickAspectRatio,
  imageSize: 'auto' as LiclickImageSize,
  count: 1,
  prompt: '',
  liclickPrompt: '',
  textureMapPrompt: '',
  mode: 'visible' as GenerateMode,
  upscaleStrength: 0,
};

const checkerBackgroundStyle = {
  backgroundColor: '#d8d8d8',
  backgroundImage:
    'linear-gradient(45deg, #a7a7a7 25%, transparent 25%), linear-gradient(-45deg, #a7a7a7 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #a7a7a7 75%), linear-gradient(-45deg, transparent 75%, #a7a7a7 75%)',
  backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0',
  backgroundSize: '16px 16px',
};

const textureMapDefaultPrompt =
  '第一张参考图是唯一的几何、轮廓、姿态、相机、构图、主体大小、画面占比、裁切、可见表面和空间位置约束，必须严格一比一对齐第一张白膜模型视图。最终图里的模型必须和第一张白膜一样大、一样近、一样裁切、一样视角，不能缩小成远景，不能改变模型形状、朝向、透视、比例和可见区域。第二张参考图只提供材质贴图本身的颜色、粗糙度、纹理颗粒和细节风格，禁止复制第二张参考图的多视角排版、背景、构图、物体姿态或物体大小。最终只输出第一张白膜视角里的同一个模型，把第二张参考图的材质贴到第一张白膜模型的可见表面上。必须是可用于 3D 贴图投射的 base color/albedo 结果，不要明显光照、阴影、投影、强高光、镜面反光、环境光渐变或烘焙光影，只保留材质自身颜色和纹理变化。不要生成地面网格、场景背景、阴影背景、文字、边框、拼图、多视角图或额外物体。';

function buildTextureMapPrompt(userPrompt: string) {
  const trimmedPrompt = userPrompt.trim();
  return trimmedPrompt ? `${textureMapDefaultPrompt}\n\n用户补充材质要求：${trimmedPrompt}` : textureMapDefaultPrompt;
}

function buildLiclickPrompt(userPrompt: string, model: LiclickImageModel) {
  const trimmedPrompt = userPrompt.trim();
  if (trimmedPrompt) return trimmedPrompt;
  if (model === 'nano_banana_2' || model === 'nano_banana_pro') return '生成一张高质量的参考图。';
  return '';
}

function isTextureMapGeneration(generation: Generation) {
  return generation.metadata.workflow === 'texture-map';
}

function formatAutoBakeCompleteDetail(width: number, baseDetail: string) {
  return `${width}px ${baseDetail}`;
}

function isRunningGeneration(generation?: Generation) {
  return Boolean(generation && !generation.resultUrl && (generation.status === 'queued' || generation.status === 'running'));
}

function getGenerationStartedAt(generation: Generation) {
  const startedAt = generation.metadata.startedAt;
  return typeof startedAt === 'string' ? Date.parse(startedAt) : Number.NaN;
}

function isGenerationSubmittedToServer(generation: Generation) {
  return generation.metadata.serverSubmitted === true || Boolean(generation.metadata.taskId);
}

function createFailedGeneration(generation: Generation, message: string, extraMetadata: Record<string, unknown> = {}) {
  return {
    ...generation,
    status: 'failed' as const,
    metadata: {
      ...generation.metadata,
      error: message,
      completedAt: new Date().toISOString(),
      ...extraMetadata,
    },
  };
}

function resolveRequestImageSize(imageSize: LiclickImageSize) {
  return imageSize;
}

function resolveRequestAspectRatio(
  model: LiclickImageModel,
  aspectRatio: LiclickAspectRatio,
  requestImageSize: LiclickImageSize,
) {
  if (model === 'gpt-image-2' && aspectRatio === 'auto' && requestImageSize !== 'auto') return '1:1';
  return aspectRatio;
}

function getImageSize(url: string) {
  return new Promise<{ width: number; height: number }>((resolve) => {
    const image = new window.Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => resolve({ width: 0, height: 0 });
    image.src = url;
  });
}

function getImportedModelMatrixWorld() {
  const model = useSceneStore.getState().importedModel;
  if (!model) return undefined;
  model.group.updateMatrixWorld(true);
  return model.group.matrixWorld.toArray();
}

export function GeneratePanel() {
  const t = useT();
  const [tab, setTab] = useState<GenerateTab>('single');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [previewImageOpen, setPreviewImageOpen] = useState(false);
  const [generateNotice, setGenerateNotice] = useState<GenerateNotice | undefined>();
  const [autoBakeProgress, setAutoBakeProgress] = useState<AutoBakeProgress | undefined>();
  const currentProject = useProjectStore((state) =>
    state.projects.find((project) => project.id === state.currentProjectId),
  );
  const isTextureMapTab = tab === 'multiview';
  const updateCurrentProject = useProjectStore((state) => state.updateCurrentProject);
  const setWorkspaceState = useProjectStore((state) => state.setWorkspaceState);
  const generationSettings = {
    ...defaultImageGenerationSettings,
    ...currentProject?.settings.imageGeneration,
  };
  const liclickPrompt = generationSettings.liclickPrompt ?? generationSettings.prompt ?? '';
  const textureMapPrompt = generationSettings.textureMapPrompt ?? '';
  const prompt = isTextureMapTab ? textureMapPrompt : liclickPrompt;
  const generateMode = generationSettings.mode ?? 'visible';
  const imageModel = generationSettings.model as LiclickImageModel;
  const aspectRatio = generationSettings.aspectRatio as LiclickAspectRatio;
  const imageSize = generationSettings.imageSize as LiclickImageSize;
  const count = generationSettings.count;
  const upscaleStrength = generationSettings.upscaleStrength ?? 0;
  const selectedReferenceIds = useReferenceStore((state) => state.selectedReferenceIds);
  const references = useReferenceStore((state) => state.references);
  const setSelectedReferences = useReferenceStore((state) => state.setSelectedReferences);
  const addReferences = useReferenceStore((state) => state.addReferences);
  const { generations, lastCapture, start, finish, addGeneration, setLastCapture } = useGenerationStore();
  const addProjectGeneration = useProjectStore((state) => state.addGeneration);
  const setProjectLayers = useProjectStore((state) => state.setProjectLayers);
  const setProjectReferences = useProjectStore((state) => state.setProjectReferences);
  const addProjectedLayerFromGeneration = useLayerStore((state) => state.addProjectedLayerFromGeneration);
  const selectedObjectId = useSceneStore((state) => state.selectedObjectId);
  const objects = useSceneStore((state) => state.objects);
  const importedModel = useSceneStore((state) => state.importedModel);
  const activeReferences = useMemo(
    () => references.filter((reference) => !reference.objectId || reference.objectId === selectedObjectId),
    [references, selectedObjectId],
  );
  const activeReferenceIds = useMemo(() => new Set(activeReferences.map((reference) => reference.id)), [activeReferences]);
  const activeSelectedReferenceIds = useMemo(
    () => selectedReferenceIds.filter((id) => activeReferenceIds.has(id)),
    [activeReferenceIds, selectedReferenceIds],
  );
  const resolution = useSettingsStore((state) => state.resolution);
  const autoUvBakeEnabled = useSettingsStore((state) => state.autoUvBakeEnabled);
  const pushToast = useToastStore((state) => state.pushToast);
  const authStatus = useAuthStore((state) => state.status);
  const providerStatus = useAuthStore((state) => state.providerStatus);
  const setAuthenticated = useAuthStore((state) => state.setAuthenticated);
  const submitLockRef = useRef(false);
  const cancelledGenerationIdsRef = useRef(new Set<string>());
  const autoBakeRunningRef = useRef(false);
  const autoBakeQueueRef = useRef<Layer[]>([]);
  const autoBakeProgressTimerRef = useRef<number>();
  const portalRoot = typeof document === 'undefined' ? undefined : document.body;
  const tabGenerations = generations.filter((generation) => {
    const projectId = typeof generation.metadata.projectId === 'string' ? generation.metadata.projectId : undefined;
    const belongsToProject = !currentProject?.id || !projectId || projectId === currentProject.id;
    return belongsToProject && isTextureMapGeneration(generation) === isTextureMapTab;
  });
  const activeProjectGeneration = tabGenerations.find((generation) => isRunningGeneration(generation));
  const previewGeneration = activeProjectGeneration ?? tabGenerations[0];
  const previewIsGenerating = isRunningGeneration(previewGeneration);
  const previewFailed = previewGeneration?.status === 'failed';
  const previewCancelled = previewGeneration?.metadata.cancelled === true;
  const canCancelLiclickGeneration =
    Boolean(activeProjectGeneration) && !isTextureMapTab && !isTextureMapGeneration(activeProjectGeneration!);

  useEffect(() => () => window.clearTimeout(autoBakeProgressTimerRef.current), []);

  const syncGeneration = useCallback(
    (generation: Generation) => {
      addGeneration(generation);
      addProjectGeneration(generation);
    },
    [addGeneration, addProjectGeneration],
  );

  const markGenerationFailed = useCallback(
    (generationToFail: Generation, message: string) => {
      syncGeneration(createFailedGeneration(generationToFail, message));
      finish();
      setGenerateNotice({
        tone: 'error',
        message,
      });
      pushToast({
        tone: 'error',
        title: isTextureMapGeneration(generationToFail) ? t('textureMapFailed') : 'Generate failed',
        description: message,
        dedupeKey: `generation-failed:${generationToFail.id}`,
      });
    },
    [finish, pushToast, syncGeneration, t],
  );

  useEffect(() => {
    if (!settingsOpen) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSettingsOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [settingsOpen]);

  useEffect(() => {
    if (tab === 'multiview' && activeSelectedReferenceIds.length > 1) {
      setSelectedReferences([activeSelectedReferenceIds[0]]);
    }
  }, [activeSelectedReferenceIds, setSelectedReferences, tab]);

  useEffect(() => {
    if (!previewGeneration || previewGeneration.resultUrl) return undefined;
    if (previewGeneration.status !== 'queued' && previewGeneration.status !== 'running') return undefined;
    const generationToPoll = previewGeneration;
    if (cancelledGenerationIdsRef.current.has(generationToPoll.id)) return undefined;
    if (!isGenerationSubmittedToServer(generationToPoll)) {
      const startedAt = getGenerationStartedAt(generationToPoll);
      if (Number.isFinite(startedAt) && Date.now() - startedAt < pendingSubmissionTimeoutMs) return undefined;
      markGenerationFailed(generationToPoll, '生图任务没有成功提交到莉刻后台，请重新生成。');
      return undefined;
    }
    const taskId = typeof generationToPoll.metadata.taskId === 'string' ? generationToPoll.metadata.taskId : undefined;
    const clientGenerationId =
      typeof generationToPoll.metadata.clientGenerationId === 'string'
        ? generationToPoll.metadata.clientGenerationId
        : undefined;
    const serverJobId =
      typeof generationToPoll.metadata.serverJobId === 'string' ? generationToPoll.metadata.serverJobId : undefined;
    const jobId = taskId ?? serverJobId ?? clientGenerationId ?? generationToPoll.id;
    if (cancelledGenerationIdsRef.current.has(jobId)) return undefined;
    let cancelled = false;
    let timeoutId: number | undefined;
    const client = createLiclickApiClient();

    async function pollJob() {
      try {
        const result = await client.getGenerationJob(jobId);
        if (cancelled) return;
        if (result.status === 'succeeded' && result.resultUrl) {
          const generation: Generation = {
            ...generationToPoll,
            resultUrl: result.resultUrl,
            status: 'succeeded',
            metadata: {
              ...generationToPoll.metadata,
              taskId: result.taskId,
              model: result.model ?? generationToPoll.metadata.model,
              resultUrls: result.resultUrls,
              extraParams: result.extraParams,
              uploadedReferences: result.uploadedReferences,
              completedAt: result.updatedAt ?? new Date().toISOString(),
            },
          };
          syncGeneration(generation);
          pushToast({
            tone: 'success',
            title: '图片生成完成',
            description: '刷新前的莉刻生成任务已恢复结果。',
            dedupeKey: `generation-restored:${generation.id}`,
          });
          return;
        }
        if (result.status === 'succeeded' && !result.resultUrl) {
          markGenerationFailed(generationToPoll, '莉刻后台任务已结束，但没有返回图片 URL，已停止等待。');
          return;
        }
        if (result.status === 'running' || result.status === 'queued') {
          const generation: Generation = {
            ...generationToPoll,
            id: result.id || generationToPoll.id,
            status: 'running',
            metadata: {
              ...generationToPoll.metadata,
              taskId: result.taskId ?? generationToPoll.metadata.taskId,
              model: result.model ?? generationToPoll.metadata.model,
              extraParams: result.extraParams ?? generationToPoll.metadata.extraParams,
              uploadedReferences: result.uploadedReferences ?? generationToPoll.metadata.uploadedReferences,
              lastPolledAt: result.updatedAt ?? new Date().toISOString(),
            },
          };
          syncGeneration(generation);
        }
        if (result.status === 'failed') {
          const generation = createFailedGeneration(generationToPoll, result.error ?? '莉刻图片生成任务失败。', {
            completedAt: result.updatedAt ?? new Date().toISOString(),
          });
          syncGeneration(generation);
          pushToast({
            tone: 'error',
            title: 'Generate failed',
            description: result.error ?? '莉刻图片生成任务失败。',
            dedupeKey: `generation-failed:${generation.id}`,
          });
          return;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (message.includes('Generation job not found')) {
          if (!cancelled) markGenerationFailed(generationToPoll, '莉刻后台没有找到这个生图任务，已停止本地等待，请重新生成。');
          return;
        }
      }
      if (!cancelled) timeoutId = window.setTimeout(pollJob, 5000);
    }

    void pollJob();
    return () => {
      cancelled = true;
      if (timeoutId) window.clearTimeout(timeoutId);
    };
  }, [markGenerationFailed, previewGeneration, pushToast, syncGeneration]);

  function updateGenerationSettings(patch: Partial<typeof defaultImageGenerationSettings>) {
    if (!currentProject) return;
    updateCurrentProject({
      settings: {
        ...currentProject.settings,
        imageGeneration: {
          ...generationSettings,
          ...patch,
        },
      },
    });
  }

  function getGenerationJobId(generation: Generation) {
    const taskId = typeof generation.metadata.taskId === 'string' ? generation.metadata.taskId : undefined;
    const serverJobId =
      typeof generation.metadata.serverJobId === 'string' ? generation.metadata.serverJobId : undefined;
    const clientGenerationId =
      typeof generation.metadata.clientGenerationId === 'string'
        ? generation.metadata.clientGenerationId
        : undefined;
    return taskId ?? serverJobId ?? clientGenerationId ?? generation.id;
  }

  function cancelLiclickGeneration() {
    const generationToCancel = activeProjectGeneration;
    if (!generationToCancel || isTextureMapGeneration(generationToCancel)) return;
    const jobId = getGenerationJobId(generationToCancel);
    cancelledGenerationIdsRef.current.add(generationToCancel.id);
    cancelledGenerationIdsRef.current.add(jobId);
    const cancelledGeneration: Generation = {
      ...generationToCancel,
      status: 'failed',
      metadata: {
        ...generationToCancel.metadata,
        cancelled: true,
        error: '用户已终止莉刻生图任务。',
        completedAt: new Date().toISOString(),
      },
    };
    submitLockRef.current = false;
    syncGeneration(cancelledGeneration);
    finish();
    setGenerateNotice({
      tone: 'info',
      message: '已终止当前莉刻生图任务。',
    });
    void createLiclickApiClient()
      .cancelGenerationJob(jobId)
      .catch((error) => {
        console.warn('[Liclick 3D Texture] Could not cancel remote generation job:', error);
        pushToast({
          tone: 'warning',
          title: '本地已终止',
          description: error instanceof Error ? error.message : '后端取消请求失败，但本地已停止等待。',
          dedupeKey: `generation-cancel-warning:${jobId}`,
        });
      });
  }

  async function requireAiLogin() {
    if (authStatus === 'authenticated') return true;
    setGenerateNotice({
      tone: 'warning',
      message: 'AI 生图需要先完成飞书/IDaaS 授权。正在启动登录流程...',
    });
    pushToast({
      tone: 'warning',
      title: '需要飞书登录',
      description: 'AI 生图需要莉刻 API 权限验证，登录后会继续使用当前项目。',
      dedupeKey: 'ai-login-required',
    });
    try {
      if (providerStatus?.devLoginEnabled && !providerStatus.feishuOAuthEnabled) {
        const result = await devLogin({ displayName: 'Liclick Dev User', email: 'dev@liclick.local' });
        setAuthenticated(result.user, 'dev-mock', providerStatus);
        return true;
      }
      const result = await runFeishuLoginFlow({
        onStatus: (message) => {
          setGenerateNotice({ tone: 'info', message });
          pushToast({
            tone: 'info',
            title: '等待飞书授权',
            description: message,
            dedupeKey: 'ai-login-waiting',
          });
        },
      });
      if (result.user) {
        setAuthenticated(result.user, result.authMode ?? 'feishu-oauth', providerStatus);
        setGenerateNotice({
          tone: 'info',
          message: '飞书授权已完成，正在继续提交莉刻生图任务。',
        });
        return true;
      }
      throw new Error('登录服务没有返回用户信息，请确认 Atlas/莉刻登录已完成。');
    } catch (error) {
      setGenerateNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Could not start login.',
      });
      pushToast({
        tone: 'error',
        title: '飞书登录不可用',
        description: error instanceof Error ? error.message : 'Could not start login.',
        dedupeKey: 'ai-login-start-failed',
      });
      return false;
    }
  }

  async function captureTextureMapReferenceView() {
    if (!importedModel) throw new Error(t('importModelFirst'));
    const objectId = selectedObjectId ?? importedModel.objectId;
    const capture = await captureCurrentView({
      objectId,
      resolution: resolutionToSize[resolution],
      framing: 'fit-object',
      colorMode: 'clay-target',
      fillRatio: 0.92,
    });
    setLastCapture(capture);
    return capture;
  }

  async function handleGenerate() {
    if (tab === 'multiview') {
      await handleTextureMapGenerate();
      return;
    }
    let pendingGeneration: Generation | undefined;
    try {
      if (submitLockRef.current || previewIsGenerating) {
        setGenerateNotice({
          tone: 'warning',
          message: '当前工程已有莉刻生图任务在运行，完成前不能再次提交。',
        });
        pushToast({
          tone: 'warning',
          title: '已有生图任务在运行',
          description: '当前工程的莉刻任务完成前不能再次生成。',
          dedupeKey: `generation-locked:${currentProject?.id ?? 'default'}`,
        });
        return;
      }
      submitLockRef.current = true;
      if (!(await requireAiLogin())) return;
      const submittedPrompt = buildLiclickPrompt(prompt, imageModel);
      const generationId = createId('liclick-image');
      const objectMatrixWorld = getImportedModelMatrixWorld();
      pendingGeneration = {
        id: generationId,
        mode: 'single',
        prompt: submittedPrompt,
        referenceIds: [...activeSelectedReferenceIds],
        status: 'running',
        metadata: {
          provider: 'liclick-atlas',
          clientGenerationId: generationId,
          projectId: currentProject?.id,
          model: imageModel,
          visibleOnly: generateMode === 'visible',
          upscale: generateMode === 'upscale',
          resolution,
          serverSubmitted: false,
          startedAt: new Date().toISOString(),
        },
      };
      start(pendingGeneration);
      addProjectGeneration(pendingGeneration);
      setGenerateNotice({
        tone: 'info',
        message: '正在提交莉刻生图任务，请等待。',
      });
      const generation = await createLiclickApiClient().generateTextureSingleView({
        clientGenerationId: generationId,
        projectId: currentProject?.id,
        workflow: 'liclick',
        mode: 'single',
        prompt: submittedPrompt,
        referenceIds: activeSelectedReferenceIds,
        referenceImages: activeReferences.filter((reference) => activeSelectedReferenceIds.includes(reference.id)),
        resolution,
        textureMode: 'realistic',
        visibleOnly: generateMode === 'visible',
        upscale: generateMode === 'upscale',
        model: imageModel,
        aspectRatio: resolveRequestAspectRatio(imageModel, aspectRatio, resolveRequestImageSize(imageSize)),
        imageSize: resolveRequestImageSize(imageSize),
        count,
      });
      const alignedGeneration: Generation = {
        ...generation,
        metadata: {
          ...generation.metadata,
          objectMatrixWorld,
          serverSubmitted: true,
          serverJobId: generation.metadata.serverJobId ?? generation.id,
        },
      };
      if (cancelledGenerationIdsRef.current.has(generationId) || cancelledGenerationIdsRef.current.has(getGenerationJobId(alignedGeneration))) {
        finish();
        return;
      }
      syncGeneration(alignedGeneration);
      if (alignedGeneration.status === 'succeeded' && alignedGeneration.resultUrl) {
        setGenerateNotice(undefined);
        pushToast({
          tone: 'success',
          title: '图片生成完成',
          description: '莉刻返回的结果已放入预览区。',
        });
      } else {
        setGenerateNotice(undefined);
      }
    } catch (error) {
      console.error('[Liclick 3D Texture] Generate failed:', error);
      setGenerateNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Could not generate a texture image.',
      });
      if (pendingGeneration) {
        syncGeneration(
          createFailedGeneration(
            pendingGeneration,
            error instanceof Error ? error.message : 'Could not generate a texture image.',
          ),
        );
      }
      finish();
      pushToast({
        tone: 'error',
        title: 'Generate failed',
        description: error instanceof Error ? error.message : 'Could not generate a texture image.',
      });
    } finally {
      submitLockRef.current = false;
    }
  }

  async function handleTextureMapGenerate() {
    let pendingGeneration: Generation | undefined;
    try {
      if (submitLockRef.current || previewIsGenerating) {
        setGenerateNotice({
          tone: 'warning',
          message: '当前工程已有莉刻生图任务在运行，完成前不能再次提交。',
        });
        return;
      }
      const materialReference = activeReferences.find((reference) => reference.id === activeSelectedReferenceIds[0]);
      if (!materialReference) {
        setGenerateNotice({
          tone: 'warning',
          message: t('selectOneMaterialReference'),
        });
        pushToast({
          tone: 'warning',
          title: t('textureMap'),
          description: t('selectOneMaterialReference'),
          dedupeKey: 'texture-map-reference-required',
        });
        return;
      }
      submitLockRef.current = true;
      const capture = await captureTextureMapReferenceView();
      const object = objects.find((item) => item.id === capture.objectId);
      if (!(await requireAiLogin())) return;
      const texturePrompt = buildTextureMapPrompt(prompt);
      const generationId = createId('texture-map');
      const objectMatrixWorld = getImportedModelMatrixWorld();
      const modelViewReference: ReferenceImage = {
        id: `${capture.id}-model-view`,
        name: 'Current model view',
        url: capture.colorUrl,
        width: capture.width,
        height: capture.height,
        objectId: capture.objectId,
        isPrimary: false,
      };
      pendingGeneration = {
        id: generationId,
        mode: 'single',
        prompt: texturePrompt,
        referenceIds: [modelViewReference.id, materialReference.id],
        captureId: capture.id,
        status: 'running',
        metadata: {
          provider: 'liclick-atlas',
          workflow: 'texture-map',
          clientGenerationId: generationId,
          projectId: currentProject?.id,
          model: imageModel,
          objectId: object?.id,
          objectMatrixWorld,
          materialReferenceId: materialReference.id,
          modelViewReferenceId: modelViewReference.id,
          resolution,
          serverSubmitted: false,
          startedAt: new Date().toISOString(),
          alphaMode: 'pending-guided-foreground-matte',
        },
      };
      start(pendingGeneration);
      addProjectGeneration(pendingGeneration);
      setGenerateNotice({
        tone: 'info',
        message: t('textureMapSubmitting'),
      });
      const generation = await createLiclickApiClient().generateTextureSingleView({
        clientGenerationId: generationId,
        projectId: currentProject?.id,
        workflow: 'texture-map',
        mode: 'single',
        prompt: texturePrompt,
        referenceIds: [modelViewReference.id, materialReference.id],
        referenceImages: [modelViewReference, materialReference],
        capture,
        object,
        resolution,
        textureMode: 'realistic',
        visibleOnly: true,
        upscale: false,
        model: imageModel,
        aspectRatio: resolveRequestAspectRatio(imageModel, aspectRatio, resolveRequestImageSize(imageSize)),
        imageSize: resolveRequestImageSize(imageSize),
        count: 1,
      });
      const textureMapGeneration: Generation = {
        ...generation,
        metadata: {
          ...generation.metadata,
          workflow: 'texture-map',
          objectMatrixWorld,
          materialReferenceId: materialReference.id,
          modelViewReferenceId: modelViewReference.id,
          serverSubmitted: true,
          serverJobId: generation.metadata.serverJobId ?? generation.id,
          alphaMode: 'pending-guided-foreground-matte',
        },
      };
      syncGeneration(textureMapGeneration);
      if (textureMapGeneration.status === 'succeeded' && textureMapGeneration.resultUrl) {
        setGenerateNotice(undefined);
        pushToast({
          tone: 'success',
          title: t('textureMapGenerated'),
          description: t('textureMapGeneratedHelp'),
        });
      } else {
        setGenerateNotice(undefined);
      }
    } catch (error) {
      console.error('[Liclick 3D Texture] Texture map generation failed:', error);
      setGenerateNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Could not generate a texture map image.',
      });
      if (pendingGeneration) {
        syncGeneration(
          createFailedGeneration(
            pendingGeneration,
            error instanceof Error ? error.message : 'Could not generate a texture map image.',
          ),
        );
      }
      finish();
      pushToast({
        tone: 'error',
        title: t('textureMapFailed'),
        description: error instanceof Error ? error.message : 'Could not generate a texture map image.',
      });
    } finally {
      submitLockRef.current = false;
    }
  }

  async function persistGeneratedImage(category: AssetCategory, url: string, filename: string, blob?: Blob) {
    if (!currentProject || currentProject.workspaceMode !== 'local-server' || isWorkspaceAssetUrl(url)) return url;
    if (blob) {
      const result = await saveBlobAsset({ projectId: currentProject.id, category, blob, filename });
      return result.asset.url;
    }
    if (url.startsWith('http')) {
      const result = await saveRemoteUrlAsset({ projectId: currentProject.id, category, url, filename });
      return result.asset.url;
    }
    if (url.startsWith('blob:')) {
      const registeredBlob = getRegisteredObjectUrlBlob(url);
      if (registeredBlob) {
        const result = await saveBlobAsset({ projectId: currentProject.id, category, blob: registeredBlob, filename });
        return result.asset.url;
      }
    }
    const dataUrl = url.startsWith('data:') ? url : await urlToDataUrl(url);
    const result = await saveDataUrlAsset({ projectId: currentProject.id, category, dataUrl, filename });
    return result.asset.url;
  }

  async function persistCaptureAssets(captures: Capture[]) {
    if (!currentProject || currentProject.workspaceMode !== 'local-server') return captures;
    let changed = false;
    const persistedCaptures = await Promise.all(
      captures.map(async (capture) => {
        const colorUrl = await persistGeneratedImage('captures', capture.colorUrl, `${capture.id}-color.png`);
        const maskUrl = await persistGeneratedImage('captures', capture.maskUrl, `${capture.id}-mask.png`);
        const depthUrl = capture.depthUrl
          ? await persistGeneratedImage('captures', capture.depthUrl, `${capture.id}-depth.png`)
          : undefined;
        const normalUrl = capture.normalUrl
          ? await persistGeneratedImage('captures', capture.normalUrl, `${capture.id}-normal.png`)
          : undefined;
        changed ||=
          colorUrl !== capture.colorUrl ||
          maskUrl !== capture.maskUrl ||
          depthUrl !== capture.depthUrl ||
          normalUrl !== capture.normalUrl;
        return { ...capture, colorUrl, maskUrl, depthUrl, normalUrl };
      }),
    );
    if (changed) updateCurrentProject({ captures: persistedCaptures });
    return persistedCaptures;
  }

  async function saveCriticalProjectState(overrides: { layers?: Layer[]; references?: ReferenceImage[] }) {
    const project = useProjectStore.getState().getCurrentProject() ?? currentProject;
    if (!project || project.workspaceMode !== 'local-server') return;
    const captures = await persistCaptureAssets(useProjectStore.getState().getCurrentProject()?.captures ?? project.captures);
    const projectForSave = {
      ...project,
      objects: useSceneStore.getState().objects,
      layers: overrides.layers ?? useLayerStore.getState().layers,
      references: overrides.references ?? useReferenceStore.getState().references,
      generations: useGenerationStore.getState().generations,
      captures,
      bakedTextures: useProjectStore.getState().getCurrentProject()?.bakedTextures ?? project.bakedTextures,
      updatedAt: new Date().toISOString(),
      dirty: false,
      workspaceMode: 'local-server' as const,
    };
    const result = await saveWorkspaceProject(projectForSave);
    setWorkspaceState({
      workspaceMode: 'local-server',
      workspaceName: result.slug,
      lastSavedAt: result.project.lastSavedAt,
      dirty: false,
      assetManifest: result.project.assetManifest,
    });
  }

  function queueAutoBakeTask(callback: () => void) {
    const idleWindow = window as typeof window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    };
    if (idleWindow.requestIdleCallback) {
      idleWindow.requestIdleCallback(callback, { timeout: 900 });
      return;
    }
    window.setTimeout(callback, 120);
  }

  async function autoBakeVisibleProjectedLayers(layer: Layer) {
    if (!useSettingsStore.getState().autoUvBakeEnabled) throw new Error(t('autoBakeDisabledHelp'));
    const currentImportedModel = useSceneStore.getState().importedModel;
    if (!currentImportedModel) throw new Error(t('importModelFirst'));
    const objectId = layer.objectId ?? selectedObjectId ?? currentImportedModel.objectId;
    window.clearTimeout(autoBakeProgressTimerRef.current);
    setAutoBakeProgress({
      title: t('autoBake'),
      detail: `${layer.name} ${t('autoBakePreparing')}`,
      progress: 0.02,
    });
    const bakeResult = await bakeVisibleProjectedLayersToTexture({
      objectId,
      resolution: resolutionToSize[resolution],
      enableBackfaceCulling: true,
      enableDilation: true,
      dilationPixels: 4,
      preferBlobOutput: currentProject?.workspaceMode === 'local-server',
      onProgress: (progress) => {
        const percent = Math.round(progress.progress * 100);
        const triangleDetail =
          progress.totalTriangles && progress.processedTriangles !== undefined
            ? ` · ${progress.processedTriangles}/${progress.totalTriangles} ${t('autoBakeTriangles')}`
            : '';
        const layerDetail =
          progress.layerCount && progress.layerName
            ? ` · ${progress.layerIndex === undefined ? 1 : progress.layerIndex + 1}/${progress.layerCount} ${progress.layerName}`
            : progress.layerName
              ? ` · ${progress.layerName}`
              : '';
        const phaseLabel =
          progress.phase === 'loading-assets'
            ? t('autoBakeLoadingAssets')
            : progress.phase === 'rasterizing'
              ? t('autoBakeRasterizing')
              : progress.phase === 'compositing'
                ? t('autoBakeCompositing')
                : progress.phase === 'encoding'
                  ? t('autoBakeEncoding')
                  : progress.phase === 'applying'
                    ? t('autoBakeApplying')
                    : t('autoBakePersisting');
        setAutoBakeProgress({
          title: t('autoBake'),
          detail: `${phaseLabel} ${percent}%${layerDetail}${triangleDetail}`,
          progress: progress.progress,
        });
      },
    });
    setAutoBakeProgress({
      title: t('autoBake'),
      detail: t('autoBakeApplyPbr'),
      progress: 0.98,
    });
    await applyBakedTextureToObject(currentImportedModel.group, bakeResult.imageUrl);

    let bakedTextures = useProjectStore.getState().getCurrentProject()?.bakedTextures ?? currentProject?.bakedTextures ?? [];
    if (currentProject?.workspaceMode === 'local-server') {
      setAutoBakeProgress({
        title: t('autoBake'),
        detail: t('autoBakePersistWorkspace'),
        progress: 0.99,
      });
      const imageUrl = await persistGeneratedImage(
        'baked',
        bakeResult.imageUrl,
        `${bakeResult.bakedTexture.id}.png`,
        bakeResult.imageBlob,
      );
      if (imageUrl !== bakeResult.imageUrl) {
        bakedTextures = bakedTextures.map((item) =>
          item.id === bakeResult.bakedTexture.id ? { ...item, imageUrl } : item,
        );
        updateCurrentProject({ bakedTextures });
      }
    }

    const bakedLayers = useLayerStore.getState().layers;
    setProjectLayers(bakedLayers);
    await saveCriticalProjectState({ layers: bakedLayers });
    setAutoBakeProgress({
      title: t('autoBakeComplete'),
      detail: formatAutoBakeCompleteDetail(bakeResult.bakedTexture.width, t('autoBakeCompleteDetail')),
      progress: 1,
    });
    return bakeResult;
  }

  function drainAutoBakeQueue() {
    if (!useSettingsStore.getState().autoUvBakeEnabled) {
      autoBakeQueueRef.current = [];
      setAutoBakeProgress(undefined);
      return;
    }
    if (autoBakeRunningRef.current) {
      return;
    }
    const layer = autoBakeQueueRef.current.shift();
    if (!layer) return;
    autoBakeRunningRef.current = true;

    queueAutoBakeTask(() => {
      void (async () => {
        pushToast({
          tone: 'info',
          title: t('autoBakeStart'),
          description: `${layer.name} ${t('autoBakeStartHelp')}`,
          dedupeKey: `auto-bake-start:${layer.id}`,
        });
        try {
          const bakeResult = await autoBakeVisibleProjectedLayers(layer);
          pushToast({
            tone: 'success',
            title: t('autoBakeComplete'),
            description: `${t('autoBakeSuccessHelp')} ${bakeResult.bakedTexture.width}px，${t('coverage')} ${(bakeResult.report.coverageRatio * 100).toFixed(1)}%。`,
            dedupeKey: `auto-bake-success:${layer.id}`,
          });
        } catch (error) {
          console.error('[Liclick 3D Texture] Auto bake failed:', error);
          pushToast({
            tone: 'warning',
            title: t('autoBakeFailed'),
            description: error instanceof Error ? error.message : t('autoBakeFailedHelp'),
            dedupeKey: `auto-bake-failed:${layer.id}`,
          });
        } finally {
          autoBakeRunningRef.current = false;
          autoBakeProgressTimerRef.current = window.setTimeout(() => {
            setAutoBakeProgress(undefined);
          }, autoBakeProgressHideDelayMs);
          drainAutoBakeQueue();
        }
      })();
    });
  }

  function scheduleAutoBakeVisibleProjectedLayers(layer: Layer) {
    autoBakeQueueRef.current.push(layer);
    if (autoBakeRunningRef.current || autoBakeQueueRef.current.length > 1) {
      pushToast({
        tone: 'info',
        title: t('autoBakeQueued'),
        description: `${autoBakeQueueRef.current.length} ${t('autoBakeQueuedHelp')}`,
        dedupeKey: 'auto-bake-queued',
      });
      return;
    }
    drainAutoBakeQueue();
  }

  async function handleAddProjectedLayer() {
    if (!previewGeneration?.resultUrl || !isTextureMapGeneration(previewGeneration)) return;
    const generationCapture =
      lastCapture?.id === previewGeneration.captureId
        ? lastCapture
        : currentProject?.captures.find((capture) => capture.id === previewGeneration.captureId) ?? lastCapture;
    const layerGeneration = {
      ...previewGeneration,
      resultUrl: await createMaskedProjectedImage(
        previewGeneration.resultUrl.startsWith('http') ? await urlToDataUrl(previewGeneration.resultUrl) : previewGeneration.resultUrl,
      ),
      metadata: {
        ...previewGeneration.metadata,
        alphaMode: 'solid-background-cutout',
      },
    };
    let layer = addProjectedLayerFromGeneration(layerGeneration, generationCapture, selectedObjectId);
    let nextLayers = useLayerStore.getState().layers;
    setProjectLayers(nextLayers);
    try {
      await saveCriticalProjectState({ layers: nextLayers });
      const imageUrl = await persistGeneratedImage('layers', layer.imageUrl, `${layer.id}.png`);
      layer = { ...layer, imageUrl };
      nextLayers = nextLayers.map((item) => (item.id === layer.id ? layer : item));
      useLayerStore.getState().setLayers(nextLayers);
      setProjectLayers(nextLayers);
      await saveCriticalProjectState({ layers: nextLayers });
    } catch (error) {
      console.error('[Liclick 3D Texture] Could not persist projected layer:', error);
      setProjectLayers(nextLayers);
      pushToast({
        tone: 'warning',
        title: '图层已添加，但保存失败',
        description: error instanceof Error ? error.message : '请确认工作区服务在线后再试。',
        dedupeKey: `layer-save-failed:${layer.id}`,
      });
    }
    pushToast({
      tone: 'success',
      title: t('autoBakeLayerAdded'),
      description: `${layer.name} ${autoUvBakeEnabled ? t('autoBakeLayerAddedHelp') : t('projectedLayerPreviewOnlyHelp')}`,
    });
    if (autoUvBakeEnabled) scheduleAutoBakeVisibleProjectedLayers(layer);
  }

  async function handleAddGenerationAsReference() {
    if (!previewGeneration?.resultUrl) return;
    const size = await getImageSize(previewGeneration.resultUrl);
    const referenceId = createId('reference');
    const name = previewGeneration.prompt.trim().slice(0, 48) || 'Generated reference';
    let reference: ReferenceImage = {
      id: referenceId,
      name,
      url: previewGeneration.resultUrl,
      width: size.width,
      height: size.height,
      objectId: selectedObjectId,
      isPrimary: true,
    };
    addReferences([reference]);
    const nextReferences = [reference, ...useReferenceStore.getState().references.filter((item) => item.id !== reference.id)];
    setProjectReferences(nextReferences);
    try {
      await saveCriticalProjectState({ references: nextReferences });
      const persistedUrl = await persistGeneratedImage('references', reference.url, `${reference.id}.png`);
      if (persistedUrl !== reference.url) {
        reference = { ...reference, url: persistedUrl };
        const persistedReferences = [reference, ...nextReferences.filter((item) => item.id !== reference.id)];
        useReferenceStore.getState().setReferences(persistedReferences);
        setProjectReferences(persistedReferences);
        await saveCriticalProjectState({ references: persistedReferences });
      }
    } catch (error) {
      console.error('[Liclick 3D Texture] Could not save reference into project:', error);
      pushToast({
        tone: 'warning',
        title: '参考图已添加，但工程保存失败',
        description: error instanceof Error ? error.message : '请确认工作区服务在线后再试。',
        dedupeKey: `reference-project-save-failed:${reference.id}`,
      });
    }
    pushToast({
      tone: 'success',
      title: t('referenceAdded'),
    });
  }

  function handleDownloadGenerationImage() {
    if (!previewGeneration?.resultUrl) return;
    const kind = isTextureMapGeneration(previewGeneration) ? 'texture_map' : 'liclick_generation';
    void downloadImageAsset(previewGeneration.resultUrl, `liclick_${kind}_${previewGeneration.id}`);
  }

  return (
    <>
    <Panel title={t('generatePanel')}>
      <SegmentedControl
        value={tab}
        options={[
          { value: 'single', label: t('single') },
          { value: 'multiview', label: t('multiview') },
        ]}
        onChange={setTab}
        className="mb-2"
      />
      <div className="overflow-hidden rounded-md border border-white/10 bg-black/24">
        <div className="relative h-[240px] overflow-hidden bg-[#1b1b1b]">
          {previewGeneration?.resultUrl ? (
            <button
              type="button"
              className="h-full w-full cursor-zoom-in"
              onClick={() => setPreviewImageOpen(true)}
              aria-label={t('view')}
              title={t('view')}
              style={checkerBackgroundStyle}
            >
              <img src={previewGeneration.resultUrl} alt="" className="h-full w-full object-contain" />
            </button>
          ) : (
            <div className="h-full w-full bg-[#1b1b1b]" />
          )}
          {previewGeneration?.resultUrl && (
            <div className="absolute right-2 top-2 flex gap-1 rounded-md border border-white/10 bg-black/68 p-1 shadow-xl backdrop-blur-sm">
              {!isTextureMapTab && !isTextureMapGeneration(previewGeneration) && (
                <button
                  type="button"
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-white transition hover:bg-liclick-pink/90"
                  title={t('addToReferences')}
                  aria-label={t('addToReferences')}
                  onClick={handleAddGenerationAsReference}
                >
                  <ImagePlus className="h-4 w-4" />
                </button>
              )}
              {isTextureMapGeneration(previewGeneration) && (
                <button
                  type="button"
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-white transition hover:bg-liclick-pink/90"
                  title={t('addAsProjectedLayer')}
                  aria-label={t('addAsProjectedLayer')}
                  onClick={handleAddProjectedLayer}
                >
                  <Layers className="h-4 w-4" />
                </button>
              )}
              <button
                type="button"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-white transition hover:bg-white/12"
                title={t('downloadImage')}
                aria-label={t('downloadImage')}
                onClick={handleDownloadGenerationImage}
              >
                <Download className="h-4 w-4" />
              </button>
              <button
                type="button"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-white transition hover:bg-white/12"
                title={t('view')}
                aria-label={t('view')}
                onClick={() => setPreviewImageOpen(true)}
              >
                <Maximize2 className="h-4 w-4" />
              </button>
            </div>
          )}
          {previewIsGenerating && (
            <div className="absolute inset-0 grid place-items-center bg-black/62 text-white backdrop-blur-[2px]">
              <div className="grid justify-items-center gap-3">
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/22 border-t-liclick-pink" />
                <div className="text-sm font-semibold">{t('generating')}</div>
              </div>
            </div>
          )}
          {previewFailed && !previewIsGenerating && (
            <div className="absolute inset-0 grid place-items-center bg-rose-950/28 px-4 text-center text-white">
              <div className="grid gap-1">
                <div className="text-sm font-semibold">{previewCancelled ? '已终止' : '生成失败'}</div>
                <div className="text-xs text-white/66">
                  {previewCancelled ? '当前莉刻生图任务已停止等待。' : '请检查提示词、参考图或模型要求后重试。'}
                </div>
              </div>
            </div>
          )}
          {generateMode === 'upscale' && (
            <div className="absolute right-2 top-2 flex overflow-hidden rounded-md bg-black/62 text-white shadow-lg">
              <button type="button" className="grid h-8 w-8 place-items-center hover:bg-white/10" title={t('captureCurrentView')}>
                <Image className="h-4 w-4" />
              </button>
              <label
                htmlFor="generate-reference-upload"
                className="grid h-8 w-8 cursor-pointer place-items-center border-l border-white/10 hover:bg-white/10"
                title={t('uploadReference')}
              >
                <Plus className="h-4 w-4" />
              </label>
            </div>
          )}
        </div>

        <div className="space-y-3 p-2.5">
          <div className={`relative grid gap-2 text-xs text-white/72 ${generateMode === 'visible' ? 'grid-cols-[1fr_1fr_32px]' : 'grid-cols-2'}`}>
            <button
              type="button"
              className={`h-9 rounded-md font-medium transition ${
                generateMode === 'visible' ? 'bg-white text-black' : 'bg-white/[0.045] text-white/78 hover:bg-white/10'
              }`}
              onClick={() => updateGenerationSettings({ mode: 'visible' })}
            >
              {t('visible')}
            </button>
            <button
              type="button"
              className={`h-9 rounded-md font-medium transition ${
                generateMode === 'upscale' ? 'bg-white text-black' : 'bg-white/[0.045] text-white/78 hover:bg-white/10'
              }`}
              onClick={() => updateGenerationSettings({ mode: 'upscale' })}
            >
              {t('upscale')}
            </button>
            {generateMode === 'visible' && (
              <button
                type="button"
                className="grid h-9 place-items-center rounded-md text-white/72 transition hover:bg-white/10 hover:text-white"
                aria-label={t('settings')}
                title={t('settings')}
                onClick={() => setSettingsOpen((open) => !open)}
              >
                <Settings className="h-4 w-4" />
              </button>
            )}
          </div>

          {generateMode === 'visible' ? (
            <>
              <label className="grid gap-1.5 text-xs font-semibold text-white/82">
                <span>{t('prompt')}</span>
                <textarea
                  value={prompt}
                  onChange={(event) =>
                    updateGenerationSettings(
                      isTextureMapTab
                        ? { textureMapPrompt: event.target.value }
                        : { liclickPrompt: event.target.value },
                    )
                  }
                  className="h-[104px] w-full resize-none rounded-md border border-white/18 bg-black/34 p-2.5 text-[13px] leading-5 text-white outline-none transition focus:border-liclick-pink"
                />
              </label>

              <section className="grid gap-2">
                <div className="flex items-center justify-between gap-2 text-sm font-semibold text-white/88">
                  <span>{t('referenceImage')}</span>
                  {activeSelectedReferenceIds.length > 0 && (
                    <span className="rounded-full border border-liclick-pink/40 bg-liclick-pink/16 px-2 py-0.5 text-[11px] font-semibold text-liclick-pink">
                      {activeSelectedReferenceIds.length} {t('referenceSelected')}
                    </span>
                  )}
                  <label
                    htmlFor="generate-reference-upload"
                    className="grid h-7 w-7 cursor-pointer place-items-center rounded-md text-white/82 hover:bg-white/10"
                    title={t('uploadReference')}
                  >
                    <Plus className="h-4 w-4" />
                  </label>
                </div>
                <ReferenceImagePicker
                  compact
                  inputId="generate-reference-upload"
                  selectionMode={tab === 'multiview' ? 'single' : 'multiple'}
                />
          </section>
            </>
          ) : (
            <label className="grid gap-2 text-sm font-semibold text-white/88">
              <span className="flex items-center gap-2">
                Strength
                <span className="grid h-4 w-4 place-items-center rounded-full border border-white/48 text-[10px] text-white/70">i</span>
              </span>
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={upscaleStrength}
                onChange={(event) => updateGenerationSettings({ upscaleStrength: Number(event.target.value) })}
                className="w-full accent-liclick-orange"
              />
            </label>
          )}

          {generateNotice && (
            <div
              className={`rounded-md border px-2.5 py-2 text-xs leading-5 ${
                generateNotice.tone === 'error'
                  ? 'border-red-400/30 bg-red-500/12 text-red-50'
                  : generateNotice.tone === 'warning'
                    ? 'border-amber-300/30 bg-amber-400/12 text-amber-50'
                    : 'border-sky-300/28 bg-sky-400/12 text-sky-50'
              }`}
            >
              {generateNotice.message}
            </div>
          )}

          <div className={canCancelLiclickGeneration ? 'grid grid-cols-[1fr_52px] gap-2' : undefined}>
            <Button
              className="h-12 w-full text-base"
              variant="primary"
              disabled={previewIsGenerating}
              onClick={handleGenerate}
              icon={<Sparkles className="h-4 w-4" />}
            >
              {previewIsGenerating ? t('generating') : tab === 'multiview' ? t('generateTextureMap') : t('generateImage')}
            </Button>
            {canCancelLiclickGeneration && (
              <Button
                className="h-12 w-full px-0"
                variant="danger"
                onClick={cancelLiclickGeneration}
                title="终止莉刻生图"
                aria-label="终止莉刻生图"
                icon={<Square className="h-4 w-4 fill-current" />}
              />
            )}
          </div>
        </div>
      </div>
    </Panel>
      {portalRoot && previewImageOpen && previewGeneration?.resultUrl && createPortal(
      <button
        type="button"
        className="fixed inset-0 z-[135] grid cursor-zoom-out place-items-center bg-black/72 p-4 backdrop-blur-sm"
        onClick={() => setPreviewImageOpen(false)}
        aria-label={t('close')}
      >
        <img
          src={previewGeneration.resultUrl}
          alt=""
          className="max-h-[92vh] max-w-[94vw] rounded-md border border-white/16 bg-[#181818] object-contain shadow-2xl"
          style={checkerBackgroundStyle}
          draggable={false}
        />
      </button>,
      portalRoot,
      )}
      {portalRoot && autoBakeProgress && createPortal(
        <AutoBakeProgressBar progress={autoBakeProgress} />,
        portalRoot,
      )}
    {portalRoot && settingsOpen && generateMode === 'visible' && createPortal(
      <div
        className="fixed inset-0 z-[130] grid place-items-center bg-black/62 px-4"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) setSettingsOpen(false);
        }}
      >
        <div className="w-full max-w-[560px] rounded-lg border border-white/16 bg-[#151520] p-4 text-white shadow-2xl">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold">{t('generationSettings')}</h2>
            <button
              type="button"
              className="grid h-8 w-8 place-items-center rounded-md text-white/72 hover:bg-white/10 hover:text-white"
              aria-label={t('close')}
              onClick={() => setSettingsOpen(false)}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="grid gap-4">
            <label className="grid gap-1.5">
              <span className="text-xs font-semibold text-white/64">{t('model')}</span>
              <select
                value={imageModel}
                onChange={(event) => updateGenerationSettings({ model: event.target.value as LiclickImageModel })}
                className="h-10 rounded-md border border-white/12 bg-white px-3 text-sm text-black outline-none focus:border-liclick-pink"
              >
                {imageModels.map((model) => (
                  <option key={model.value} value={model.value}>
                    {model.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="grid gap-1.5">
              <span className="text-xs font-semibold text-white/64">{t('ratio')}</span>
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-8">
                {aspectRatios.map((ratio) => (
                  <button
                    key={ratio}
                    type="button"
                    className={`h-9 rounded-md text-xs font-semibold transition ${
                      aspectRatio === ratio
                        ? 'bg-gradient-to-r from-liclick-pink to-liclick-purple text-white shadow-glow'
                        : 'bg-white/[0.06] text-white/72 hover:bg-white/12'
                    }`}
                    onClick={() => updateGenerationSettings({ aspectRatio: ratio })}
                  >
                    {ratio === 'auto' ? t('auto') : ratio}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid gap-1.5">
              <span className="text-xs font-semibold text-white/64">{t('imageSize')}</span>
              <div className="grid grid-cols-4 gap-2">
                {imageSizes.map((size) => (
                  <button
                    key={size}
                    type="button"
                    className={`h-9 rounded-md text-xs font-semibold transition ${
                      imageSize === size
                        ? 'bg-gradient-to-r from-liclick-pink to-liclick-purple text-white shadow-glow'
                        : 'bg-white/[0.06] text-white/72 hover:bg-white/12'
                    }`}
                    onClick={() => updateGenerationSettings({ imageSize: size })}
                  >
                    {size === 'auto' ? t('auto') : size}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid gap-1.5">
              <span className="text-xs font-semibold text-white/64">{t('count')}</span>
              <div className="grid grid-cols-[44px_1fr_44px] overflow-hidden rounded-md border border-white/12">
                <button
                  type="button"
                  className="h-10 bg-white/[0.06] text-lg text-white/72 hover:bg-white/12"
                  onClick={() => updateGenerationSettings({ count: Math.max(1, count - 1) })}
                >
                  -
                </button>
                <div className="grid h-10 place-items-center bg-white/[0.04] text-sm font-semibold text-white">
                  {count}
                </div>
                <button
                  type="button"
                  className="h-10 bg-white/[0.06] text-lg text-white/72 hover:bg-white/12"
                  onClick={() => updateGenerationSettings({ count: Math.min(4, count + 1) })}
                >
                  +
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>,
      portalRoot,
    )}
    </>
  );
}
