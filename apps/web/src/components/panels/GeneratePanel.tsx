import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Image, ImagePlus, Plus, Settings, Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Panel } from '@/components/ui/Panel';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { captureCurrentView } from '@/engine/capture/captureCurrentView';
import { ReferenceImagePicker } from '@/components/panels/ReferenceImagePicker';
import { devLogin, startFeishuLogin } from '@/services/authApiClient';
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
import type { Generation } from '@/types/generation';
import type { Layer } from '@/types/layer';
import type { ReferenceImage } from '@/types/project';
import {
  isWorkspaceAssetUrl,
  saveDataUrlAsset,
  saveProject as saveWorkspaceProject,
  saveRemoteUrlAsset,
  urlToDataUrl,
  type AssetCategory,
} from '@/services/workspaceApiClient';

type GenerateTab = 'single' | 'multiview';
type GenerateMode = 'visible' | 'upscale';

const resolutionToSize = {
  '1K': 1024,
  '2K': 2048,
  '4K': 4096,
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
const defaultImageGenerationSettings = {
  model: 'gpt-image-2' as LiclickImageModel,
  aspectRatio: 'auto' as LiclickAspectRatio,
  imageSize: 'auto' as LiclickImageSize,
  count: 1,
  prompt: '',
  mode: 'visible' as GenerateMode,
  upscaleStrength: 0,
};

function getImageSize(url: string) {
  return new Promise<{ width: number; height: number }>((resolve) => {
    const image = new window.Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => resolve({ width: 0, height: 0 });
    image.src = url;
  });
}

export function GeneratePanel() {
  const t = useT();
  const [tab, setTab] = useState<GenerateTab>('single');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const currentProject = useProjectStore((state) =>
    state.projects.find((project) => project.id === state.currentProjectId),
  );
  const updateCurrentProject = useProjectStore((state) => state.updateCurrentProject);
  const setWorkspaceState = useProjectStore((state) => state.setWorkspaceState);
  const generationSettings = {
    ...defaultImageGenerationSettings,
    ...currentProject?.settings.imageGeneration,
  };
  const prompt = generationSettings.prompt ?? '';
  const generateMode = generationSettings.mode ?? 'visible';
  const imageModel = generationSettings.model as LiclickImageModel;
  const aspectRatio = generationSettings.aspectRatio as LiclickAspectRatio;
  const imageSize = generationSettings.imageSize as LiclickImageSize;
  const count = generationSettings.count;
  const upscaleStrength = generationSettings.upscaleStrength ?? 0;
  const selectedReferenceIds = useReferenceStore((state) => state.selectedReferenceIds);
  const references = useReferenceStore((state) => state.references);
  const addReferences = useReferenceStore((state) => state.addReferences);
  const { generations, currentGeneration, lastCapture, isGenerating, start, finish, addGeneration, setLastCapture } =
    useGenerationStore();
  const addProjectGeneration = useProjectStore((state) => state.addGeneration);
  const setProjectLayers = useProjectStore((state) => state.setProjectLayers);
  const setProjectReferences = useProjectStore((state) => state.setProjectReferences);
  const addProjectedLayerFromGeneration = useLayerStore((state) => state.addProjectedLayerFromGeneration);
  const selectedObjectId = useSceneStore((state) => state.selectedObjectId);
  const objects = useSceneStore((state) => state.objects);
  const importedModel = useSceneStore((state) => state.importedModel);
  const resolution = useSettingsStore((state) => state.resolution);
  const pushToast = useToastStore((state) => state.pushToast);
  const authStatus = useAuthStore((state) => state.status);
  const providerStatus = useAuthStore((state) => state.providerStatus);
  const setAuthenticated = useAuthStore((state) => state.setAuthenticated);
  const submitLockRef = useRef(false);
  const portalRoot = typeof document === 'undefined' ? undefined : document.body;
  const activeProjectGeneration = generations.find((generation) => {
    const projectId = typeof generation.metadata.projectId === 'string' ? generation.metadata.projectId : undefined;
    const belongsToProject = !currentProject?.id || !projectId || projectId === currentProject.id;
    return belongsToProject && !generation.resultUrl && (generation.status === 'queued' || generation.status === 'running');
  });
  const previewGeneration = activeProjectGeneration ?? currentGeneration;
  const currentTaskId = typeof previewGeneration?.metadata.taskId === 'string' ? previewGeneration.metadata.taskId : undefined;
  const previewIsGenerating =
    isGenerating ||
    Boolean(activeProjectGeneration) ||
    Boolean(
      currentGeneration &&
        !currentGeneration.resultUrl &&
        (currentGeneration.status === 'queued' || currentGeneration.status === 'running'),
    );
  const previewFailed = previewGeneration?.status === 'failed';

  useEffect(() => {
    if (!settingsOpen) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSettingsOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [settingsOpen]);

  useEffect(() => {
    if (!previewGeneration || previewGeneration.resultUrl) return undefined;
    if (previewGeneration.status !== 'queued' && previewGeneration.status !== 'running') return undefined;
    const generationToPoll = previewGeneration;
    const taskId = typeof generationToPoll.metadata.taskId === 'string' ? generationToPoll.metadata.taskId : undefined;
    const clientGenerationId =
      typeof generationToPoll.metadata.clientGenerationId === 'string'
        ? generationToPoll.metadata.clientGenerationId
        : undefined;
    const jobId = taskId ?? clientGenerationId ?? generationToPoll.id;
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
          addGeneration(generation);
          addProjectGeneration(generation);
          pushToast({
            tone: 'success',
            title: '图片生成完成',
            description: '刷新前的莉刻生成任务已恢复结果。',
            dedupeKey: `generation-restored:${generation.id}`,
          });
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
          addGeneration(generation);
          addProjectGeneration(generation);
        }
        if (result.status === 'failed') {
          const generation: Generation = {
            ...generationToPoll,
            status: 'failed',
            metadata: {
              ...generationToPoll.metadata,
              error: result.error ?? '莉刻图片生成任务失败。',
              completedAt: result.updatedAt ?? new Date().toISOString(),
            },
          };
          addGeneration(generation);
          addProjectGeneration(generation);
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
          if (!cancelled) timeoutId = window.setTimeout(pollJob, 2500);
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
  }, [addGeneration, addProjectGeneration, previewGeneration, pushToast]);

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

  async function requireAiLogin() {
    if (authStatus === 'authenticated') return true;
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
      const result = await startFeishuLogin();
      if (result.user) {
        setAuthenticated(result.user, result.authMode ?? 'feishu-oauth', providerStatus);
        return true;
      }
      if (result.redirectUrl) window.location.href = result.redirectUrl;
      else throw new Error('登录服务没有返回用户信息，请确认本机 Atlas/莉刻登录已完成。');
      return Boolean(result.user);
    } catch (error) {
      pushToast({
        tone: 'error',
        title: '飞书登录不可用',
        description: error instanceof Error ? error.message : 'Could not start login.',
        dedupeKey: 'ai-login-start-failed',
      });
      return false;
    }
  }

  async function ensureCapture() {
    if (!importedModel) throw new Error(t('importModelFirst'));
    const objectId = selectedObjectId ?? importedModel.objectId;
    if (lastCapture?.objectId === objectId) return lastCapture;

    const capture = await captureCurrentView({
      objectId,
      resolution: resolutionToSize[resolution],
    });
    setLastCapture(capture);
    return capture;
  }

  async function handleGenerate() {
    let pendingGeneration: Generation | undefined;
    try {
      if (submitLockRef.current || previewIsGenerating) {
        pushToast({
          tone: 'warning',
          title: '已有生图任务在运行',
          description: '当前工程的莉刻任务完成前不能再次生成。',
          dedupeKey: `generation-locked:${currentProject?.id ?? 'default'}`,
        });
        return;
      }
      submitLockRef.current = true;
      if (!prompt.trim()) {
        pushToast({
          tone: 'warning',
          title: '请输入描述',
          description: 'Prompt 会直接发送到莉刻图片生成。',
          dedupeKey: 'generate-empty-prompt',
        });
        return;
      }
      if (!(await requireAiLogin())) return;
      const generationId = `liclick-image-${crypto.randomUUID()}`;
      pendingGeneration = {
        id: generationId,
        mode: 'single',
        prompt: prompt.trim(),
        referenceIds: [...selectedReferenceIds],
        status: 'running',
        metadata: {
          provider: 'liclick-atlas',
          clientGenerationId: generationId,
          projectId: currentProject?.id,
          model: imageModel,
          visibleOnly: generateMode === 'visible',
          upscale: generateMode === 'upscale',
          resolution,
          startedAt: new Date().toISOString(),
        },
      };
      start(pendingGeneration);
      addProjectGeneration(pendingGeneration);
      const capture = await ensureCapture();
      const object = objects.find((item) => item.id === capture.objectId);
      pendingGeneration = {
        ...pendingGeneration,
        captureId: capture.id,
        metadata: {
          ...pendingGeneration.metadata,
          objectId: object?.id,
        },
      };
      start(pendingGeneration);
      addProjectGeneration(pendingGeneration);
      const generation = await createLiclickApiClient().generateTextureSingleView({
        clientGenerationId: generationId,
        projectId: currentProject?.id,
        mode: 'single',
        prompt: prompt.trim(),
        referenceIds: selectedReferenceIds,
        referenceImages: references.filter((reference) => selectedReferenceIds.includes(reference.id)),
        capture,
        object,
        resolution,
        textureMode: 'realistic',
        visibleOnly: generateMode === 'visible',
        upscale: generateMode === 'upscale',
        model: imageModel,
        aspectRatio,
        imageSize,
        count,
      });
      addGeneration(generation);
      addProjectGeneration(generation);
      if (generation.status === 'succeeded' && generation.resultUrl) {
        pushToast({
          tone: 'success',
          title: '图片生成完成',
          description: '莉刻返回的结果已放入预览区。',
        });
      } else {
        pushToast({
          tone: 'info',
          title: '莉刻任务已提交',
          description: '正在按任务 ID 轮询结果，完成前请等待。',
          dedupeKey: `generation-submitted:${generation.metadata.taskId ?? generation.id}`,
        });
      }
    } catch (error) {
      console.error('[Liclick 3D Texture] Generate failed:', error);
      if (pendingGeneration) {
        const failedGeneration: Generation = {
          ...pendingGeneration,
          status: 'failed',
          metadata: {
            ...pendingGeneration.metadata,
            error: error instanceof Error ? error.message : 'Could not generate a texture image.',
            completedAt: new Date().toISOString(),
          },
        };
        addGeneration(failedGeneration);
        addProjectGeneration(failedGeneration);
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

  async function persistGeneratedImage(category: AssetCategory, url: string, filename: string) {
    if (!currentProject || currentProject.workspaceMode !== 'local-server' || isWorkspaceAssetUrl(url)) return url;
    if (url.startsWith('http')) {
      const result = await saveRemoteUrlAsset({ projectId: currentProject.id, category, url, filename });
      return result.asset.url;
    }
    const dataUrl = url.startsWith('data:') ? url : await urlToDataUrl(url);
    const result = await saveDataUrlAsset({ projectId: currentProject.id, category, dataUrl, filename });
    return result.asset.url;
  }

  async function saveCriticalProjectState(overrides: { layers?: Layer[]; references?: ReferenceImage[] }) {
    const project = useProjectStore.getState().getCurrentProject() ?? currentProject;
    if (!project || project.workspaceMode !== 'local-server') return;
    const projectForSave = {
      ...project,
      objects: useSceneStore.getState().objects,
      layers: overrides.layers ?? useLayerStore.getState().layers,
      references: overrides.references ?? useReferenceStore.getState().references,
      generations: useGenerationStore.getState().generations,
      captures: useProjectStore.getState().getCurrentProject()?.captures ?? project.captures,
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

  async function handleAddProjectedLayer() {
    if (!currentGeneration?.resultUrl) return;
    let layer = addProjectedLayerFromGeneration(currentGeneration, lastCapture, selectedObjectId);
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
      title: 'Projected layer added',
      description: `${layer.name} is now previewed on the model.`,
    });
  }

  async function handleAddGenerationAsReference() {
    if (!currentGeneration?.resultUrl) return;
    const size = await getImageSize(currentGeneration.resultUrl);
    const referenceId = `reference-${crypto.randomUUID()}`;
    const name = currentGeneration.prompt.trim().slice(0, 48) || 'Generated reference';
    let reference: ReferenceImage = {
      id: referenceId,
      name,
      url: currentGeneration.resultUrl,
      width: size.width,
      height: size.height,
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

  return (
    <>
    <Panel title={t('generatePanel')}>
      <SegmentedControl
        value={tab}
        options={[
          { value: 'single', label: t('single') },
          { value: 'multiview', label: t('multiview'), disabled: true },
        ]}
        onChange={setTab}
        className="mb-2"
      />
      <div className="overflow-hidden rounded-md border border-white/10 bg-black/24">
        <div className="relative h-[240px] overflow-hidden bg-[#1b1b1b]">
          {currentGeneration?.resultUrl ? (
            <>
              <img src={currentGeneration.resultUrl} alt="" className="h-full w-full object-cover" />
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/76 to-transparent px-3 py-3">
                <div className="line-clamp-2 text-xs font-semibold leading-4 text-white">{currentGeneration.prompt}</div>
              </div>
            </>
          ) : (
            <div className="h-full w-full bg-[#1b1b1b]" />
          )}
          {currentGeneration?.resultUrl && (
            <div className="absolute inset-x-2 top-2 flex gap-2 rounded-md border border-black/20 bg-black/72 p-1.5 shadow-xl backdrop-blur-sm">
              <button
                type="button"
                className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-white/18 bg-liclick-pink text-white shadow-glow transition hover:brightness-110"
                title={t('addToReferences')}
                aria-label={t('addToReferences')}
                onClick={handleAddGenerationAsReference}
              >
                <ImagePlus className="h-4 w-4" />
              </button>
              <Button className="h-9 min-w-0 flex-1 truncate px-2 text-xs" variant="primary" onClick={handleAddProjectedLayer}>
                {t('addAsProjectedLayer')}
              </Button>
            </div>
          )}
          {previewIsGenerating && (
            <div className="absolute inset-0 grid place-items-center bg-black/62 text-white backdrop-blur-[2px]">
              <div className="grid justify-items-center gap-3">
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/22 border-t-liclick-pink" />
                <div className="text-sm font-semibold">{t('generating')}</div>
                <div className="max-w-[220px] text-center text-xs leading-5 text-white/64">
                  <div>{t('waitingLiclick')}</div>
                  {currentTaskId && <div className="font-mono text-[11px] text-white/72">{currentTaskId.slice(0, 8)}...</div>}
                </div>
              </div>
            </div>
          )}
          {previewFailed && !previewIsGenerating && (
            <div className="absolute inset-0 grid place-items-center bg-rose-950/28 px-4 text-center text-white">
              <div className="grid gap-1">
                <div className="text-sm font-semibold">Generate failed</div>
                <div className="text-xs text-white/66">You can adjust the prompt or references and try again.</div>
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
                  onChange={(event) => updateGenerationSettings({ prompt: event.target.value })}
                  className="h-[104px] w-full resize-none rounded-md border border-white/18 bg-black/34 p-2.5 text-[13px] leading-5 text-white outline-none transition focus:border-liclick-pink"
                />
              </label>

              <section className="grid gap-2">
                <div className="flex items-center justify-between gap-2 text-sm font-semibold text-white/88">
                  <span>{t('referenceImage')}</span>
                  {selectedReferenceIds.length > 0 && (
                    <span className="rounded-full border border-liclick-pink/40 bg-liclick-pink/16 px-2 py-0.5 text-[11px] font-semibold text-liclick-pink">
                      {selectedReferenceIds.length} {t('referenceSelected')}
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
                <ReferenceImagePicker compact inputId="generate-reference-upload" />
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

          <Button
            className="h-12 w-full text-base"
            variant="primary"
            disabled={previewIsGenerating}
            onClick={handleGenerate}
            icon={<Sparkles className="h-4 w-4" />}
          >
            {previewIsGenerating ? t('generating') : t('generateImage')}
          </Button>
        </div>
      </div>
    </Panel>
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
