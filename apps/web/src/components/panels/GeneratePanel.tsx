import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, Layers, LoaderCircle, Maximize2, Plus, Sparkles, Square, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Panel } from '@/components/ui/Panel';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { useWorkspaceLayoutStore } from '@/components/workspace/workspaceLayoutStore';
import {
  captureCurrentColorPreview,
  captureCurrentDepthPreview,
  captureCurrentLocalRepaintView,
  captureCurrentNormalPreview,
  captureCurrentView,
  snapshotCurrentCaptureCamera,
  withStableClayTargetPresentation,
} from '@/engine/capture/captureCurrentView';
import { requestContentAwareRepair } from '@/engine/contentAware';
import {
  createCaptureMaskedProjectionImage,
  createCaptureMaskedPreview,
  createGeneratedDisplayPreview,
  createSubjectFilledPreview,
} from '@/engine/localRepaint/resultPreviewUtils';
import { ensureLocalRepaintSessionLayer as ensurePersistentLocalRepaintSessionLayer } from '@/engine/localRepaint/sessionLayer';
import { generationBelongsToObject } from '@/engine/localRepaint/objectBinding';
import { prepareLocalRepaintGenerationInput } from '@/engine/localRepaint/generationInputWorker';
import {
  getObjectViewPresetDirection,
  type ObjectViewPreset,
} from '@/engine/scene/transformActions';
import { ReferenceGroupPicker } from '@/components/panels/ReferenceGroupPicker';
import {
  referenceGroupId,
  type ReferenceGroupGenerationState,
} from '@/components/panels/referenceGroup';
import { devLogin } from '@/services/authApiClient';
import { createModelviewApiClient } from '@/services/modelviewApiClient';
import { isCloudBuild } from '@/platform/runtimeCapabilities';
import { runFeishuLoginFlow } from '@/services/feishuLoginFlow';
import { resolveLiclickAuthStrategy } from '@/services/liclickAuthStrategy';
import {
  createLiclickApiClient,
  LiclickApiError,
  type GenerationJobListItem,
  type LiclickAspectRatio,
  type LiclickImageModel,
  type LiclickImageSize,
} from '@/services/liclickApiClient';
import { getUserFacingGenerationError } from '@/services/generationErrorMessage';
import { resolveLocalRepaintMaterialReference } from '@/services/localRepaintMaterialReference';
import {
  LOCAL_REPAINT_AUTO_DIAGNOSIS_POLICY,
  prepareLocalRepaintPromptPolishInputs,
} from '@/services/localRepaintPromptPolishInputs';
import {
  hasTrackedModuleAction,
  trackModuleAction,
  trackModuleActionOnce,
  type TelemetryModule,
} from '@/services/telemetryClient';
import { useAuthStore } from '@/stores/authStore';
import { useGenerationStore } from '@/stores/generationStore';
import { useT } from '@/stores/i18nStore';
import {
  SINGLE_VIEW_GENERATED_MINIMUM_PROJECTION_FACING,
  useLayerStore,
} from '@/stores/layerStore';
import { IMMEDIATE_PROJECT_SAVE_EVENT, useProjectStore } from '@/stores/projectStore';
import { useReferenceStore } from '@/stores/referenceStore';
import { useSceneStore } from '@/stores/sceneStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useToastStore } from '@/stores/toastStore';
import type { Capture } from '@/types/capture';
import type { CaptureNormalPreview, CaptureResolution } from '@/engine/capture/captureTypes';
import type { Generation } from '@/types/generation';
import type { Layer } from '@/types/layer';
import type { ReferenceImage } from '@/types/project';
import { getRegisteredObjectUrlBlob, revokeRegisteredObjectUrl } from '@/utils/blobUrlRegistry';
import { createId } from '@/utils/id';
import { downloadImageAsset } from '@/utils/downloadImage';
import { generationBelongsToProject, generationIdentityIds } from '@/utils/generationIdentity';
import {
  getGenerationStartedAt,
  mergeGenerationMetadataPreservingStartedAt,
} from '@/utils/generationTiming';
import {
  isWorkspaceAssetUrl,
  isIntegratedLoopbackWorkspaceAssetUrl,
  isLegacyWorkspaceAssetUrl,
  readWorkspaceAssetBlob,
  saveBlobAsset,
  saveDataUrlAsset,
  saveRemoteUrlAsset,
  updateLatestProject,
  urlToBlob,
  urlToDataUrl,
  type AssetCategory,
} from '@/services/workspaceApiClient';

type GenerateTab = 'multiview' | 'repaint';
type TextureViewMode = 'single' | 'multi';
type SingleViewProvider = 'gpt' | 'remote';
type TexturePreviewMode = TextureViewMode | 'repaint';
type GenerateChannel = GenerateTab | 'single';
type GenerateMode = 'visible' | 'upscale';
type TexturePipelineProgress = {
  active: boolean;
  progress: number;
  label: string;
};

function isTextureSnapshotProgressLabel(label: string) {
  // 兼容历史“多视角”与当前界面“多视图”两种进度文案。
  return /^(?:准备)?多视(?:图|角)快照(?:\s|$)/.test(label);
}
type CameraViewPresetId = 'preset-1' | 'preset-2';
type CameraViewPresetSelection = CameraViewPresetId | 'custom';
type CameraViewOption = {
  value: ObjectViewPreset;
  labelKey:
    | 'frontView'
    | 'frontTopView'
    | 'frontBottomView'
    | 'frontLeftView'
    | 'frontLeftTopView'
    | 'frontRightView'
    | 'frontRightBottomView'
    | 'backView'
    | 'backTopView'
    | 'backBottomView'
    | 'backLeftView'
    | 'backLeftBottomView'
    | 'backRightView'
    | 'backRightTopView'
    | 'leftView'
    | 'leftTopView'
    | 'leftBottomView'
    | 'rightView'
    | 'rightTopView'
    | 'rightBottomView'
    | 'topView'
    | 'bottomView';
};
type CameraViewItem = {
  id: string;
  value?: ObjectViewPreset;
  label: string;
  viewDirection: [number, number, number];
  viewUp?: [number, number, number];
};
type CameraViewPreviewMap = Partial<Record<string, CaptureNormalPreview>>;
type CameraViewPresetDefinition = {
  id: CameraViewPresetId;
  label: string;
  description: string;
  views: ObjectViewPreset[];
};
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

const LOCAL_REPAINT_INPUT_RESOLUTION = 2048;

const cameraViewOptions: Record<ObjectViewPreset, CameraViewOption> = {
  front: { value: 'front', labelKey: 'frontView' },
  'front-top': { value: 'front-top', labelKey: 'frontTopView' },
  'front-bottom': { value: 'front-bottom', labelKey: 'frontBottomView' },
  back: { value: 'back', labelKey: 'backView' },
  'back-top': { value: 'back-top', labelKey: 'backTopView' },
  'back-bottom': { value: 'back-bottom', labelKey: 'backBottomView' },
  left: { value: 'left', labelKey: 'leftView' },
  'left-top': { value: 'left-top', labelKey: 'leftTopView' },
  'left-bottom': { value: 'left-bottom', labelKey: 'leftBottomView' },
  right: { value: 'right', labelKey: 'rightView' },
  'right-top': { value: 'right-top', labelKey: 'rightTopView' },
  'right-bottom': { value: 'right-bottom', labelKey: 'rightBottomView' },
  top: { value: 'top', labelKey: 'topView' },
  bottom: { value: 'bottom', labelKey: 'bottomView' },
  'front-left': { value: 'front-left', labelKey: 'frontLeftView' },
  'front-left-top': { value: 'front-left-top', labelKey: 'frontLeftTopView' },
  'front-right': { value: 'front-right', labelKey: 'frontRightView' },
  'front-right-bottom': { value: 'front-right-bottom', labelKey: 'frontRightBottomView' },
  'back-left': { value: 'back-left', labelKey: 'backLeftView' },
  'back-left-bottom': { value: 'back-left-bottom', labelKey: 'backLeftBottomView' },
  'back-right': { value: 'back-right', labelKey: 'backRightView' },
  'back-right-top': { value: 'back-right-top', labelKey: 'backRightTopView' },
};

const cameraViewPresets: CameraViewPresetDefinition[] = [
  {
    id: 'preset-1',
    label: '预设 1 · 10 视角（默认）',
    description: '10 个视角：前、后、左、右、上、下、左前、右前、左后、右后',
    views: [
      'front',
      'back',
      'left',
      'right',
      'top',
      'bottom',
      'front-left',
      'front-right',
      'back-left',
      'back-right',
    ],
  },
  {
    id: 'preset-2',
    label: '预设 2 · 14 视角',
    description:
      '14 个视角：前、后、左、右、上、下、前上、后上、左上、右上、前下、后下、左下、右下 45°',
    views: [
      'front',
      'back',
      'left',
      'right',
      'top',
      'bottom',
      'front-top',
      'back-top',
      'left-top',
      'right-top',
      'front-bottom',
      'back-bottom',
      'left-bottom',
      'right-bottom',
    ],
  },
];

const customCameraViewPreset = {
  label: '自定义预设 · 6 视角',
  views: ['front', 'back', 'left', 'right', 'top', 'bottom'] as ObjectViewPreset[],
};

const cameraViewPresetOptions: Array<{
  id: CameraViewPresetSelection;
  title: string;
  detail: string;
}> = [
  { id: 'preset-1', title: '预设 1', detail: '10 视角 · 默认' },
  { id: 'preset-2', title: '预设 2', detail: '14 视角' },
  { id: 'custom', title: '自定义预设', detail: '6 个基础视角' },
];

function getCameraViewPresetDefinition(presetId: CameraViewPresetId) {
  return cameraViewPresets.find((preset) => preset.id === presetId) ?? cameraViewPresets[0];
}

function createCameraViewsForPreset(
  presetId: CameraViewPresetId,
  translate: (key: CameraViewOption['labelKey']) => string,
) {
  const preset = getCameraViewPresetDefinition(presetId);
  return preset.views.map((value) => {
    const option = cameraViewOptions[value];
    return createPresetCameraViewItem(option, translate(option.labelKey));
  });
}

function createCameraViewsFromValues(
  values: ObjectViewPreset[],
  translate: (key: CameraViewOption['labelKey']) => string,
) {
  return values.map((value) => {
    const option = cameraViewOptions[value];
    return createPresetCameraViewItem(option, translate(option.labelKey));
  });
}

function createPresetCameraViewItem(option: CameraViewOption, label: string): CameraViewItem {
  const viewDirection = getObjectViewPresetDirection(option.value).toArray() as [
    number,
    number,
    number,
  ];
  return {
    id: option.value,
    value: option.value,
    label,
    viewDirection,
    viewUp: option.value === 'top' ? [0, 0, -1] : option.value === 'bottom' ? [0, 0, 1] : [0, 1, 0],
  };
}

const pendingSubmissionTimeoutMs = 3 * 60 * 1000;
const generationPollIntervalMs = 5000;

function generationPollToastKey(jobId: string) {
  return `generation-poll-retrying:${jobId}`;
}
const defaultImageGenerationSettings = {
  model: 'gpt-image-2' as LiclickImageModel,
  aspectRatio: 'auto' as LiclickAspectRatio,
  imageSize: 'auto' as LiclickImageSize,
  count: 1,
  prompt: '',
  liclickPrompt: '',
  textureMapPrompt: '',
  localRepaintPrompt: '',
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

function CameraViewThumbnail({
  preview,
  loading,
}: {
  preview?: CaptureNormalPreview;
  loading: boolean;
}) {
  const normalUrl = preview?.normalUrl;
  return (
    <span className="relative grid h-full w-full place-items-center overflow-hidden rounded-[inherit] bg-[#303033]">
      {normalUrl ? (
        <img src={normalUrl} alt="" className="h-full w-full object-contain mix-blend-screen" />
      ) : (
        <span className="absolute inset-0 bg-[radial-gradient(circle_at_45%_34%,rgba(255,255,255,0.16),transparent_30%),linear-gradient(135deg,rgba(82,255,163,0.18),rgba(71,126,255,0.2))]" />
      )}
      {loading && (
        <span className="absolute inset-0 grid place-items-center bg-black/24">
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-white/18 border-t-white/72" />
        </span>
      )}
    </span>
  );
}

const previewProgressOverlayClassName =
  'absolute inset-0 grid place-items-center bg-[#1b1b1b] px-4 text-center text-white';

function GenerationProgressStatus({ generation }: { generation: Generation }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const startedAt = getGenerationStartedAt(generation);
  const elapsedSeconds = Number.isFinite(startedAt)
    ? Math.max(0, Math.floor((now - startedAt) / 1000))
    : 0;
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = String(elapsedSeconds % 60).padStart(2, '0');
  const submitted = isGenerationSubmittedToServer(generation);

  return (
    <div
      className="text-sm font-semibold leading-6 text-white/82"
      role="status"
      aria-live="polite"
      data-generation-progress="true"
    >
      {submitted ? '后台正在处理，完成后会自动返回' : '正在检查参考图并提交任务'}
      <span className="ml-2 tabular-nums text-white/62">
        {minutes}:{seconds}
      </span>
    </div>
  );
}

function LocalRepaintPreparationStatus({
  startedAt,
  detail,
}: {
  startedAt: number;
  detail: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const elapsedSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = String(elapsedSeconds % 60).padStart(2, '0');

  return (
    <div
      className="text-sm font-semibold leading-6 text-white/82"
      role="status"
      aria-live="polite"
      data-local-repaint-preparation="true"
    >
      {detail}
      <span className="ml-2 tabular-nums text-white/62">
        {minutes}:{seconds}
      </span>
    </div>
  );
}

const textureMapDefaultPrompt = `任务：只对参考图一做原位材质编辑，不重新生成模型或重新构图。

参考图一是不可修改的像素定位模板。输出须与图一同尺寸；模型像素包围框的左、上、右、下坐标，以及中心、宽高、外轮廓、内部孔洞和部件边界必须与图一逐像素对齐。严格保持图一的姿态、透视、遮挡和裁切；禁止平移、缩放、旋转、变形、补全、删减、重构或改变相机。

参考图二仅提供同一物体的 Base Color 材质。只把对应部件的颜色、纹理、磨损和表面已有文字或标识迁移到图一对应的可见表面；不得采用图二的构图、背景、多视图排版、物体大小或额外几何，不得跨部件或跨表面搬移图案。

除模型可见表面的材质外，图一其余像素保持不变，模型外部及透明区域原样保留。只输出一张与图一严格配准的完整图，不添加新物体、光影、高光、背景、边框或水印。`;

function buildTextureMapPrompt(userPrompt: string) {
  const trimmedPrompt = userPrompt.trim();
  return trimmedPrompt
    ? `${textureMapDefaultPrompt}\n\n用户补充材质要求：${trimmedPrompt}`
    : textureMapDefaultPrompt;
}

const multiviewDefaultPrompt = `以输入图片中的主要物体为唯一参考，生成一张用于3D建模的六视图展示图。

严格保持物体的造型、比例、结构、零件、颜色、材质和纹理一致。所有视图必须来自同一个结构固定的三维物体。不可见区域根据对称性和结构逻辑进行最少量补全，不要添加参考图中不存在的细节。

输出横向2×3布局：
第一排：正面、左前45°、顶部；
第二排：左侧、右侧、底部。

正交视图减少透视畸变，所有物体保持相同比例、状态和方向，完整居中且不裁切。使用纯黑背景和统一的柔和棚拍光照。

不要出现结构变化、零件错位、重复视角、背景元素、文字、边框、Logo或水印。`;

function buildMultiviewPrompt(userPrompt: string) {
  const trimmedPrompt = userPrompt.trim();
  return trimmedPrompt
    ? `${multiviewDefaultPrompt}\n\n用户补充要求：${trimmedPrompt}`
    : multiviewDefaultPrompt;
}

function isMultiviewReference(reference: ReferenceImage) {
  return reference.referenceRole === 'multi-view';
}

function isTextureMapGeneration(generation: Generation) {
  return generation.metadata.workflow === 'texture-map';
}

function isLocalRepaintGeneration(generation: Generation) {
  return generation.metadata.workflow === 'local-repaint';
}

function getGenerationChannel(generation: Generation): GenerateChannel {
  if (isTextureMapGeneration(generation)) return 'multiview';
  if (isLocalRepaintGeneration(generation)) return 'repaint';
  return 'single';
}

function generationMatchesTab(generation: Generation, tab: GenerateTab) {
  if (tab === 'multiview') return isTextureMapGeneration(generation);
  return isLocalRepaintGeneration(generation);
}

function isRunningGeneration(generation?: Generation) {
  return Boolean(
    generation &&
    !generation.resultUrl &&
    (generation.status === 'queued' || generation.status === 'running'),
  );
}

function isGenerationCancellation(error: unknown) {
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /用户已终止|任务已终止|已取消|取消生成/.test(message);
}

function throwIfTexturePipelineCancelled(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException('用户已终止多视图快照。', 'AbortError');
  }
}

function generationRecoverySignature(generation: Generation | undefined) {
  if (!generation) return undefined;
  const metadata = generation.metadata;
  return JSON.stringify({
    id: generation.id,
    prompt: generation.prompt,
    referenceIds: generation.referenceIds,
    captureId: generation.captureId,
    resultUrl: generation.resultUrl,
    status: generation.status,
    metadata: {
      clientGenerationId: metadata.clientGenerationId,
      serverJobId: metadata.serverJobId,
      projectId: metadata.projectId,
      workflow: metadata.workflow,
      taskId: metadata.taskId,
      model: metadata.model,
      resultUrls: metadata.resultUrls,
      startedAt: metadata.startedAt,
      completedAt: metadata.completedAt,
      error: metadata.error,
      serverSubmitted: metadata.serverSubmitted,
    },
  });
}

function isGenerationSubmittedToServer(generation: Generation) {
  return generation.metadata.serverSubmitted === true || Boolean(generation.metadata.taskId);
}

function createFailedGeneration(
  generation: Generation,
  message: string,
  extraMetadata: Record<string, unknown> = {},
) {
  const userMessage = getUserFacingGenerationError(message);
  return {
    ...generation,
    status: 'failed' as const,
    metadata: {
      ...generation.metadata,
      error: userMessage,
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
  if (model === 'gpt-image-2' && aspectRatio === 'auto' && requestImageSize !== 'auto')
    return '1:1';
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

function getImportedModelMatrixWorld(objectId?: string) {
  const sceneState = useSceneStore.getState();
  const model = objectId
    ? sceneState.importedModels.find((item) => item.objectId === objectId)
    : sceneState.importedModel;
  if (!model) return undefined;
  model.group.updateMatrixWorld(true);
  return model.group.matrixWorld.toArray();
}

type GeneratePanelProps = {
  localImageGenerationRequestKey?: number;
  onRequestLocalImageGeneration?: () => void;
  onLocalImageGenerationSettled?: (result: LocalImageGenerationSettledResult) => void;
  cancelActiveGenerationRequestKey?: number;
  interactionLocked?: boolean;
  onInteractionLocked?: () => void;
  onTaskRunningChange?: (state: GeneratePanelTaskState) => void;
};

export type GeneratePanelTaskState = {
  running: boolean;
  snapshotPreparing: boolean;
};

export type LocalImageGenerationSettledResult =
  | { succeeded: true; generationId: string }
  | { succeeded: false; generationId?: never };

export function GeneratePanel({
  localImageGenerationRequestKey = 0,
  onRequestLocalImageGeneration,
  onLocalImageGenerationSettled,
  cancelActiveGenerationRequestKey = 0,
  interactionLocked = false,
  onInteractionLocked,
  onTaskRunningChange,
}: GeneratePanelProps) {
  const t = useT();
  const [tab, setTab] = useState<GenerateTab>('multiview');
  const [textureViewMode, setTextureViewMode] = useState<TextureViewMode>('multi');
  const [singleViewProvider, setSingleViewProvider] = useState<SingleViewProvider>('gpt');
  const [texturePreviewMode, setTexturePreviewMode] = useState<TexturePreviewMode>('multi');
  const [localRepaintPrompt, setLocalRepaintPrompt] = useState('');
  const [promptPolishing, setPromptPolishing] = useState(false);
  const promptPolishRequestRef = useRef(0);
  const promptValueRef = useRef({ key: '', value: '' });
  const localRepaintResolvedPromptCacheRef = useRef(
    new Map<string, { prompt: string; source: 'user-request' | 'auto-diagnosis' }>(),
  );
  const [previewImageOpen, setPreviewImageOpen] = useState(false);
  const [subjectFilledPreview, setSubjectFilledPreview] = useState<{
    sourceUrl: string;
    maskUrl?: string;
    depthUrl?: string;
    previewUrl: string;
  }>();
  const [selectedCameraViewPreset, setSelectedCameraViewPreset] =
    useState<CameraViewPresetSelection>('preset-1');
  const [cameraViews, setCameraViews] = useState<CameraViewItem[]>(() =>
    createCameraViewsForPreset('preset-1', t),
  );
  const [activeCameraViewId, setActiveCameraViewId] = useState('front');
  const [referenceGroupGenerationState, setReferenceGroupGenerationState] =
    useState<ReferenceGroupGenerationState>();
  const [texturePipelineProgress, setTexturePipelineProgress] = useState<TexturePipelineProgress>();
  const [cameraViewPreviews, setCameraViewPreviews] = useState<CameraViewPreviewMap>({});
  const [capturingCameraViews, setCapturingCameraViews] = useState<Set<string>>(() => new Set());
  const cameraViewPreviewsRef = useRef<CameraViewPreviewMap>({});
  const capturingCameraViewsRef = useRef<Set<string>>(new Set());
  const [pendingLocalImageGenerationRequestKey, setPendingLocalImageGenerationRequestKey] =
    useState(0);
  const [submissionActive, setSubmissionActive] = useState(false);
  const [localRepaintPreparation, setLocalRepaintPreparation] = useState<{
    startedAt: number;
    detail: string;
  }>();
  const handledLocalImageGenerationRequestKeyRef = useRef(0);
  const handledCancelActiveGenerationRequestKeyRef = useRef(0);
  const lastCompletedLocalRepaintGenerationIdRef = useRef<string>();
  const handleLocalRepaintGenerateRef = useRef<() => Promise<boolean>>(async () => false);

  const updateTexturePipelineProgress = useCallback((progress: number, label: string) => {
    setTexturePipelineProgress((current) => ({
      active: true,
      progress: Math.max(current?.active ? current.progress : 0, Math.min(100, progress)),
      label,
    }));
  }, []);

  useEffect(() => {
    if (
      !localImageGenerationRequestKey ||
      localImageGenerationRequestKey === handledLocalImageGenerationRequestKeyRef.current
    )
      return;
    setTab('repaint');
    setTexturePreviewMode('repaint');
    setLocalRepaintPreparation({
      startedAt: Date.now(),
      detail: '正在准备当前视角',
    });
    setPendingLocalImageGenerationRequestKey(localImageGenerationRequestKey);
  }, [localImageGenerationRequestKey]);

  useEffect(() => {
    if (
      tab !== 'repaint' ||
      !pendingLocalImageGenerationRequestKey ||
      pendingLocalImageGenerationRequestKey === handledLocalImageGenerationRequestKeyRef.current
    )
      return;
    handledLocalImageGenerationRequestKeyRef.current = pendingLocalImageGenerationRequestKey;
    setPendingLocalImageGenerationRequestKey(0);
    void handleLocalRepaintGenerateRef.current().then(
      (succeeded) => {
        const generationId = lastCompletedLocalRepaintGenerationIdRef.current;
        onLocalImageGenerationSettled?.(
          succeeded && generationId ? { succeeded: true, generationId } : { succeeded: false },
        );
      },
      () => onLocalImageGenerationSettled?.({ succeeded: false }),
    );
  }, [onLocalImageGenerationSettled, pendingLocalImageGenerationRequestKey, tab]);

  const [generateNotices, setGenerateNotices] = useState<
    Partial<Record<GenerateTab, GenerateNotice>>
  >({});
  const generateNotice = generateNotices[tab];
  const setGenerateNotice = useCallback(
    (notice: GenerateNotice | undefined) => {
      setGenerateNotices((current) => {
        const next = { ...current };
        if (notice) next[tab] = notice;
        else delete next[tab];
        return next;
      });
    },
    [tab],
  );
  const [cancelConfirmGeneration, setCancelConfirmGeneration] = useState<Generation | undefined>();
  const [cancelTextureSnapshotConfirmOpen, setCancelTextureSnapshotConfirmOpen] = useState(false);
  const [texturePipelineCancelling, setTexturePipelineCancelling] = useState(false);
  const currentProject = useProjectStore((state) =>
    state.projects.find((project) => project.id === state.currentProjectId),
  );
  const currentProjectId = currentProject?.id;
  const isTextureMapTab = tab === 'multiview';
  const isLocalRepaintTab = tab === 'repaint';
  const displayedTexturePreviewMode: TexturePreviewMode = isLocalRepaintTab
    ? 'repaint'
    : texturePreviewMode;
  const updateCurrentProject = useProjectStore((state) => state.updateCurrentProject);
  const updateProjectById = useProjectStore((state) => state.updateProjectById);
  const generationSettings = {
    ...defaultImageGenerationSettings,
    ...currentProject?.settings.imageGeneration,
  };
  const liclickPrompt = generationSettings.liclickPrompt ?? generationSettings.prompt ?? '';
  const textureMapPrompt = generationSettings.textureMapPrompt ?? '';
  const prompt = isTextureMapTab
    ? textureMapPrompt
    : isLocalRepaintTab
      ? localRepaintPrompt
      : liclickPrompt;
  const promptPolishKey = `${currentProjectId ?? 'none'}:${isLocalRepaintTab ? 'local-repaint' : `${textureViewMode}:${singleViewProvider}`}`;
  promptValueRef.current = { key: promptPolishKey, value: prompt };
  const imageModel = isTextureMapTab
    ? ('gpt-image-2' as LiclickImageModel)
    : (generationSettings.model as LiclickImageModel);
  const aspectRatio = generationSettings.aspectRatio as LiclickAspectRatio;
  const imageSize = generationSettings.imageSize as LiclickImageSize;
  const selectedReferenceIds = useReferenceStore((state) => state.selectedReferenceIds);
  const references = useReferenceStore((state) => state.references);
  const setSelectedReferences = useReferenceStore((state) => state.setSelectedReferences);
  const generations = useGenerationStore((state) => state.generations);
  const lastCapture = useGenerationStore((state) => state.lastCapture);
  const start = useGenerationStore((state) => state.start);
  const finish = useGenerationStore((state) => state.finish);
  const addGeneration = useGenerationStore((state) => state.addGeneration);
  const setLastCapture = useGenerationStore((state) => state.setLastCapture);
  const addProjectGenerationByProjectId = useProjectStore(
    (state) => state.addGenerationByProjectId,
  );
  const addProjectGeneration = useCallback(
    (generation: Generation) => {
      const generationProjectId =
        typeof generation.metadata.projectId === 'string'
          ? generation.metadata.projectId
          : currentProjectId;
      if (generationProjectId) addProjectGenerationByProjectId(generationProjectId, generation);
    },
    [addProjectGenerationByProjectId, currentProjectId],
  );
  const setProjectLayers = useProjectStore((state) => state.setProjectLayers);
  const setProjectReferences = useProjectStore((state) => state.setProjectReferences);
  const addProjectedLayerFromGeneration = useLayerStore(
    (state) => state.addProjectedLayerFromGeneration,
  );
  const selectedObjectId = useSceneStore((state) => state.selectedObjectId);
  const objects = useSceneStore((state) => state.objects);
  const importedModels = useSceneStore((state) => state.importedModels);
  const importedModel = useSceneStore((state) => state.importedModel);
  const captureModel = useMemo(
    () =>
      (selectedObjectId
        ? importedModels.find((model) => model.objectId === selectedObjectId)
        : undefined) ?? importedModel,
    [importedModel, importedModels, selectedObjectId],
  );
  const captureObjectId = captureModel?.objectId;
  const latestLocalRepaintGeneration = useMemo(() => {
    const projectCandidates = generations.filter((generation) => {
      if (
        generation.status !== 'succeeded' ||
        !generation.resultUrl ||
        !isLocalRepaintGeneration(generation)
      )
        return false;
      const generationProjectId =
        typeof generation.metadata.projectId === 'string'
          ? generation.metadata.projectId
          : undefined;
      return !currentProjectId || !generationProjectId || generationProjectId === currentProjectId;
    });
    const candidates = projectCandidates.filter((generation) =>
      generationBelongsToObject(generation, captureObjectId, currentProject?.captures ?? []),
    );
    return candidates.reduce<Generation | undefined>((latestGeneration, generation) => {
      if (!latestGeneration) return generation;
      const recencyTimestamp = (item: Generation) => {
        const completedAt = item.metadata.completedAt;
        const completedTimestamp =
          typeof completedAt === 'string' ? Date.parse(completedAt) : Number.NaN;
        const startedTimestamp = getGenerationStartedAt(item);
        return Number.isFinite(completedTimestamp)
          ? completedTimestamp
          : Number.isFinite(startedTimestamp)
            ? startedTimestamp
            : Number.NEGATIVE_INFINITY;
      };
      return recencyTimestamp(generation) > recencyTimestamp(latestGeneration)
        ? generation
        : latestGeneration;
    }, undefined);
  }, [captureObjectId, currentProject?.captures, currentProjectId, generations]);
  const latestLocalRepaintGenerationId = latestLocalRepaintGeneration?.id;
  const ensureLocalRepaintSessionLayer = useCallback(
    (
      generationId = latestLocalRepaintGenerationId,
      options?: {
        preserveActiveProjection?: boolean;
        preserveActiveLayer?: boolean;
      },
    ) => {
      if (!currentProjectId || !captureObjectId) return undefined;
      return ensurePersistentLocalRepaintSessionLayer({
        objectId: captureObjectId,
        generationId,
        ...options,
      }).layer;
    },
    [captureObjectId, currentProjectId, latestLocalRepaintGenerationId],
  );
  useEffect(() => {
    if (!isLocalRepaintTab) return;
    ensureLocalRepaintSessionLayer(undefined, {
      preserveActiveProjection: true,
      preserveActiveLayer: true,
    });
  }, [ensureLocalRepaintSessionLayer, isLocalRepaintTab]);
  const viewport = useSceneStore((state) => state.viewport);
  const activeReferences = references;
  const activeReferenceIds = useMemo(
    () => new Set(references.map((reference) => reference.id)),
    [references],
  );
  const activeSelectedReferenceIds = useMemo(
    () => selectedReferenceIds.filter((id) => activeReferenceIds.has(id)),
    [activeReferenceIds, selectedReferenceIds],
  );
  const selectedReferenceGroupId = useMemo(() => {
    const selectedReference = activeReferences.find((reference) =>
      activeSelectedReferenceIds.includes(reference.id),
    );
    return selectedReference ? referenceGroupId(selectedReference) : undefined;
  }, [activeReferences, activeSelectedReferenceIds]);
  const selectedSingleReference = useMemo(
    () =>
      activeReferences.find(
        (reference) =>
          selectedReferenceGroupId === referenceGroupId(reference) &&
          !isMultiviewReference(reference),
      ),
    [activeReferences, selectedReferenceGroupId],
  );
  const selectedMultiviewReference = useMemo(
    () =>
      activeReferences.find(
        (reference) =>
          selectedReferenceGroupId === referenceGroupId(reference) &&
          isMultiviewReference(reference),
      ),
    [activeReferences, selectedReferenceGroupId],
  );
  const resolution = useSettingsStore((state) => state.resolution);
  const pushToast = useToastStore((state) => state.pushToast);
  const dismissToastByDedupeKey = useToastStore((state) => state.dismissToastByDedupeKey);
  const authStatus = useAuthStore((state) => state.status);
  const providerStatus = useAuthStore((state) => state.providerStatus);
  const setAuthenticated = useAuthStore((state) => state.setAuthenticated);
  // A project has one mutation pipeline. While any generation channel owns
  // this lock, every other authoring action stays read-only.
  const submitLocksRef = useRef(new Set<GenerateChannel>());
  const cancelledGenerationIdsRef = useRef(new Set<string>());
  const cancelledTextureBatchIdsRef = useRef(new Set<string>());
  const generationPollFailureCountsRef = useRef(new Map<string, number>());
  const generationAbortControllersRef = useRef(new Map<string, AbortController>());
  const texturePipelineAbortControllerRef = useRef<AbortController>();
  const projectedLayerCommitQueueRef = useRef<Promise<void>>(Promise.resolve());
  const criticalProjectSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pairedGenerationPersistenceRef = useRef(new Set<string>());
  const persistPairedMultiviewReferenceRef =
    useRef<(singleReference: ReferenceImage, generation: Generation) => Promise<ReferenceImage>>();
  const portalRoot = typeof document === 'undefined' ? undefined : document.body;
  const dockDensity = useWorkspaceLayoutStore((state) => state.dockDensity);
  const generatePanelExpanded = useWorkspaceLayoutStore(
    (state) =>
      state.mode === 'texture' &&
      state.panels.some((panel) => panel.id === 'generate' && !panel.collapsed && panel.visible),
  );
  const tabGenerations = generations.filter((generation) => {
    const projectId =
      typeof generation.metadata.projectId === 'string' ? generation.metadata.projectId : undefined;
    const belongsToProject = !currentProject?.id || !projectId || projectId === currentProject.id;
    return belongsToProject && generationMatchesTab(generation, tab);
  });
  const activeProjectGeneration = tabGenerations.find((generation) =>
    isRunningGeneration(generation),
  );
  const activeAnyProjectGeneration = generations.find((generation) => {
    const projectId =
      typeof generation.metadata.projectId === 'string' ? generation.metadata.projectId : undefined;
    const belongsToProject = !currentProject?.id || !projectId || projectId === currentProject.id;
    return belongsToProject && isRunningGeneration(generation);
  });
  const activeReferenceGeneration = generations.find((generation) => {
    const projectId =
      typeof generation.metadata.projectId === 'string' ? generation.metadata.projectId : undefined;
    const belongsToProject = !currentProject?.id || !projectId || projectId === currentProject.id;
    return (
      belongsToProject &&
      generation.metadata.referenceRole === 'multi-view' &&
      isRunningGeneration(generation)
    );
  });
  const activeWorkflowGeneration = activeReferenceGeneration ?? activeAnyProjectGeneration;
  const activeReferenceGroupId =
    typeof activeReferenceGeneration?.metadata.referenceGroupId === 'string'
      ? activeReferenceGeneration.metadata.referenceGroupId
      : undefined;
  const displayedReferenceGroupGenerationState =
    referenceGroupGenerationState ??
    (activeReferenceGroupId
      ? ({ groupId: activeReferenceGroupId, status: 'generating' } as const)
      : undefined);
  const panelTaskRunning =
    submissionActive ||
    texturePipelineProgress?.active === true ||
    Boolean(activeWorkflowGeneration) ||
    displayedReferenceGroupGenerationState?.status === 'generating';
  const snapshotPreparing = Boolean(
    texturePipelineProgress?.active &&
    isTextureSnapshotProgressLabel(texturePipelineProgress.label),
  );
  const workflowConfigurationLocked = interactionLocked || snapshotPreparing;
  const workflowSubmissionLocked = interactionLocked || panelTaskRunning;
  const notifyWorkflowOperationLocked = useCallback(() => {
    setGenerateNotice({
      tone: 'info',
      message: snapshotPreparing
        ? '正在准备多视角快照，快照完成后会恢复这些设置。'
        : panelTaskRunning
          ? '当前生成任务仍在运行，可以继续普通编辑，但暂不能重复提交生成。'
          : '当前独占任务正在运行，请等待任务完成。',
    });
    if (onInteractionLocked) {
      onInteractionLocked();
      return;
    }
    pushToast({
      tone: 'info',
      title: '任务正在运行',
      description: snapshotPreparing
        ? '快照准备期间暂时锁定模型和生图参数。'
        : '可以继续普通编辑，但暂不能重复提交生成任务。',
      dedupeKey: 'editor-task-preview-only',
    });
  }, [onInteractionLocked, panelTaskRunning, pushToast, setGenerateNotice, snapshotPreparing]);

  useEffect(() => {
    onTaskRunningChange?.({ running: panelTaskRunning, snapshotPreparing });
  }, [onTaskRunningChange, panelTaskRunning, snapshotPreparing]);

  useEffect(
    () => () => {
      onTaskRunningChange?.({ running: false, snapshotPreparing: false });
    },
    [onTaskRunningChange],
  );
  const previewGeneration = activeProjectGeneration ?? tabGenerations[0];
  const previewIsGenerating = isRunningGeneration(previewGeneration);
  // A toolbar repaint request owns the synchronous submit lock before its
  // Generation row exists. Reflect that preparation window in the panel CTA
  // so the dock spinner and the left panel never disagree about task state.
  const generateActionRunning = previewIsGenerating || (tab === 'repaint' && submissionActive);
  const displayedPreviewGeneration =
    isTextureMapTab && texturePreviewMode === 'repaint'
      ? latestLocalRepaintGeneration
      : previewGeneration;
  const displayedPreviewIsGenerating = isRunningGeneration(displayedPreviewGeneration);
  const displayedPreviewFailed = displayedPreviewGeneration?.status === 'failed';
  const displayedPreviewCancelled = displayedPreviewGeneration?.metadata.cancelled === true;
  const canCancelGeneration = Boolean(
    activeWorkflowGeneration ||
    (snapshotPreparing &&
      texturePipelineAbortControllerRef.current &&
      !texturePipelineAbortControllerRef.current.signal.aborted),
  );

  useEffect(() => {
    if (
      cancelActiveGenerationRequestKey <= 0 ||
      cancelActiveGenerationRequestKey === handledCancelActiveGenerationRequestKeyRef.current
    ) {
      return;
    }
    if (activeWorkflowGeneration) {
      handledCancelActiveGenerationRequestKeyRef.current = cancelActiveGenerationRequestKey;
      setCancelConfirmGeneration(activeWorkflowGeneration);
      return;
    }
    if (snapshotPreparing && texturePipelineAbortControllerRef.current) {
      handledCancelActiveGenerationRequestKeyRef.current = cancelActiveGenerationRequestKey;
      setCancelTextureSnapshotConfirmOpen(true);
    }
  }, [activeWorkflowGeneration, cancelActiveGenerationRequestKey, snapshotPreparing]);
  const previewRawResultUrl = displayedPreviewGeneration?.resultUrl;
  const previewCapture = displayedPreviewGeneration?.captureId
    ? lastCapture?.id === displayedPreviewGeneration.captureId
      ? lastCapture
      : currentProject?.captures.find(
          (capture) => capture.id === displayedPreviewGeneration.captureId,
        )
    : displayedPreviewGeneration &&
        isLocalRepaintGeneration(displayedPreviewGeneration) &&
        lastCapture &&
        generationBelongsToObject(
          displayedPreviewGeneration,
          lastCapture.objectId,
          currentProject?.captures ?? [],
        )
      ? lastCapture
      : undefined;
  const capturePreviewMaskUrl =
    displayedPreviewGeneration &&
    (isLocalRepaintGeneration(displayedPreviewGeneration) ||
      isTextureMapGeneration(displayedPreviewGeneration))
      ? previewCapture?.maskUrl
      : undefined;
  const previewProcessingMode = displayedPreviewGeneration
    ? isLocalRepaintGeneration(displayedPreviewGeneration)
      ? 'generated-display'
      : isTextureMapGeneration(displayedPreviewGeneration)
        ? capturePreviewMaskUrl
          ? 'capture-mask'
          : undefined
        : undefined
    : undefined;
  // A local-repaint result is a normal generated image, not the editor's
  // selection mask.  Keeping that mask in the preview cache key made an old
  // result jump to the newest brush position and re-ran a large hidden image
  // composition whenever the user painted again.
  const previewProcessingMaskUrl =
    previewProcessingMode === 'capture-mask' ? capturePreviewMaskUrl : undefined;
  const previewProcessingDepthUrl =
    previewProcessingMode === 'generated-display' ? previewCapture?.depthUrl : undefined;
  const previewResultUrl =
    previewRawResultUrl &&
    previewProcessingMode &&
    subjectFilledPreview?.sourceUrl === previewRawResultUrl &&
    subjectFilledPreview.maskUrl === previewProcessingMaskUrl &&
    subjectFilledPreview.depthUrl === previewProcessingDepthUrl
      ? subjectFilledPreview.previewUrl
      : previewRawResultUrl;

  useEffect(() => {
    const sourceUrl = previewRawResultUrl;
    if (!sourceUrl || !previewProcessingMode) {
      setSubjectFilledPreview(undefined);
      return undefined;
    }
    let cancelled = false;
    const previewPromise =
      previewProcessingMode === 'capture-mask'
        ? createCaptureMaskedPreview(sourceUrl, capturePreviewMaskUrl!)
        : previewProcessingMode === 'generated-display'
          ? createGeneratedDisplayPreview(sourceUrl, previewProcessingDepthUrl).then(
              (preview) => preview.fittedUrl,
            )
          : createSubjectFilledPreview(sourceUrl, 'neutral');
    void previewPromise
      .then((previewUrl) => {
        if (!cancelled)
          setSubjectFilledPreview({
            sourceUrl,
            maskUrl: previewProcessingMaskUrl,
            depthUrl: previewProcessingDepthUrl,
            previewUrl,
          });
      })
      .catch((error) => {
        if (cancelled) return;
        console.warn('[Liclick 3D Texture] Could not prepare generated image preview.', error);
        setSubjectFilledPreview({
          sourceUrl,
          maskUrl: previewProcessingMaskUrl,
          depthUrl: previewProcessingDepthUrl,
          previewUrl: sourceUrl,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [
    capturePreviewMaskUrl,
    previewProcessingDepthUrl,
    previewProcessingMaskUrl,
    previewProcessingMode,
    previewRawResultUrl,
  ]);

  const syncGeneration = useCallback(
    (generation: Generation) => {
      if (isGenerationSubmittedToServer(generation)) {
        const telemetryModule: TelemetryModule = isLocalRepaintGeneration(generation)
          ? 'local_repaint'
          : 'texture_painting';
        const jobId = getGenerationJobId(generation);
        trackModuleActionOnce(telemetryModule, 'start', jobId);
        if (hasTrackedModuleAction(telemetryModule, 'start', jobId)) {
          if (generation.status === 'succeeded' && generation.resultUrl) {
            trackModuleActionOnce(telemetryModule, 'complete', jobId);
          } else if (generation.status === 'failed' && generation.metadata.cancelled !== true) {
            trackModuleActionOnce(telemetryModule, 'fail', jobId);
          }
        }
      }
      const generationProjectId =
        typeof generation.metadata.projectId === 'string'
          ? generation.metadata.projectId
          : currentProjectId;
      if (
        !generationProjectId ||
        useProjectStore.getState().currentProjectId === generationProjectId
      ) {
        addGeneration(generation);
      }
      addProjectGeneration(generation);
    },
    [addGeneration, addProjectGeneration, currentProjectId],
  );

  useEffect(() => {
    if (!currentProjectId || authStatus !== 'authenticated') return undefined;
    const recoveryProjectId = currentProjectId;
    let cancelled = false;
    let retryTimeout: number | undefined;
    let inFlight = false;
    const persistenceAttemptedAt = new Map<string, number>();
    const client = createLiclickApiClient();

    function matchesJob(generation: Generation, job: GenerationJobListItem) {
      const jobIds = new Set(
        [job.id, job.clientGenerationId, job.taskId].filter(
          (value): value is string => typeof value === 'string' && value.length > 0,
        ),
      );
      return generationIdentityIds(generation).some((id) => jobIds.has(id));
    }

    function reconcileJob(job: GenerationJobListItem) {
      const generationState = useGenerationStore.getState().generations;
      const liveProject = useProjectStore
        .getState()
        .projects.find((project) => project.id === recoveryProjectId);
      const projectGeneration = liveProject?.generations.find((generation) =>
        matchesJob(generation, job),
      );
      const storeGeneration = generationState.find((generation) => matchesJob(generation, job));
      if (
        projectGeneration?.metadata.cancelled === true ||
        storeGeneration?.metadata.cancelled === true
      )
        return { changed: false, needsPersist: false };

      const existing = projectGeneration ?? storeGeneration;
      const fallback = storeGeneration ?? projectGeneration;
      const existingMetadata = {
        ...(projectGeneration?.metadata ?? {}),
        ...(storeGeneration?.metadata ?? {}),
      };
      const workspaceResultUrl = [projectGeneration?.resultUrl, storeGeneration?.resultUrl].find(
        (url): url is string => typeof url === 'string' && isWorkspaceAssetUrl(url),
      );
      const resultUrl =
        workspaceResultUrl ?? existing?.resultUrl ?? fallback?.resultUrl ?? job.resultUrl;
      const status = resultUrl ? ('succeeded' as const) : job.status;
      const generation: Generation = {
        id: existing?.id ?? fallback?.id ?? job.clientGenerationId ?? job.id,
        mode: existing?.mode ?? fallback?.mode ?? 'single',
        prompt: existing?.prompt || fallback?.prompt || job.prompt,
        negativePrompt: existing?.negativePrompt ?? fallback?.negativePrompt,
        referenceIds: existing?.referenceIds.length
          ? existing.referenceIds
          : fallback?.referenceIds.length
            ? fallback.referenceIds
            : job.referenceIds,
        captureId: existing?.captureId ?? fallback?.captureId,
        resultUrl,
        status,
        metadata: {
          ...existingMetadata,
          provider: existingMetadata.provider ?? 'liclick-atlas',
          clientGenerationId:
            existingMetadata.clientGenerationId ?? job.clientGenerationId ?? job.id,
          serverJobId: job.id,
          projectId: job.projectId,
          workflow: job.workflow ?? existingMetadata.workflow ?? 'liclick',
          taskId: job.taskId ?? existingMetadata.taskId,
          model: job.model ?? existingMetadata.model,
          resultUrls: job.resultUrls ?? existingMetadata.resultUrls,
          extraParams: job.extraParams ?? existingMetadata.extraParams,
          uploadedReferences: job.uploadedReferences ?? existingMetadata.uploadedReferences,
          aspectRatio: job.params?.aspectRatio ?? existingMetadata.aspectRatio,
          imageSize: job.params?.imageSize ?? existingMetadata.imageSize,
          count: job.params?.count ?? existingMetadata.count,
          startedAt: job.startedAt ?? existingMetadata.startedAt,
          completedAt:
            status === 'succeeded' || status === 'failed'
              ? (job.updatedAt ?? existingMetadata.completedAt)
              : existingMetadata.completedAt,
          error: status === 'failed' ? (job.error ?? existingMetadata.error) : undefined,
          serverMessage: undefined,
          serverSubmitted: true,
        },
      };
      const nextSignature = generationRecoverySignature(generation);
      const needsPersist =
        Boolean(generation.resultUrl) && !isWorkspaceAssetUrl(generation.resultUrl);
      if (
        generationRecoverySignature(projectGeneration) === nextSignature &&
        generationRecoverySignature(storeGeneration) === nextSignature
      )
        return { changed: false, needsPersist };
      syncGeneration(generation);
      return { changed: true, needsPersist };
    }

    function scheduleReconcile(delay = generationPollIntervalMs) {
      if (cancelled) return;
      if (retryTimeout !== undefined) window.clearTimeout(retryTimeout);
      retryTimeout = window.setTimeout(() => {
        retryTimeout = undefined;
        void reconcileJobs();
      }, delay);
    }

    async function reconcileJobs() {
      if (cancelled || inFlight) return;
      inFlight = true;
      let retry = false;
      try {
        const jobs = await client.listGenerationJobs(recoveryProjectId);
        if (cancelled) return;
        let didChange = false;
        let shouldPersist = false;
        for (const job of [...jobs].reverse()) {
          const reconciliation = reconcileJob(job);
          didChange = reconciliation.changed || didChange;
          if (reconciliation.needsPersist && job.resultUrl) {
            const persistenceKey = `${job.id}:${job.resultUrl}`;
            const lastAttempt = persistenceAttemptedAt.get(persistenceKey) ?? 0;
            if (Date.now() - lastAttempt >= 5 * 60 * 1000) {
              persistenceAttemptedAt.set(persistenceKey, Date.now());
              shouldPersist = true;
            }
          }
        }
        if (didChange || shouldPersist) {
          window.dispatchEvent(new Event(IMMEDIATE_PROJECT_SAVE_EVENT));
        }
        retry = jobs.some((job) => job.status === 'running' || job.status === 'queued');
      } catch (error) {
        if (cancelled) return;
        // Older local components do not expose project-level recovery. The
        // regular single-job poll remains available in that case.
        retry = !(error instanceof LiclickApiError) || error.status === 429 || error.status >= 500;
      } finally {
        inFlight = false;
        if (!cancelled && retry) scheduleReconcile();
      }
    }

    function wakeReconciliation() {
      if (document.visibilityState !== 'visible') return;
      if (retryTimeout !== undefined) window.clearTimeout(retryTimeout);
      retryTimeout = undefined;
      void reconcileJobs();
    }

    void reconcileJobs();
    window.addEventListener('focus', wakeReconciliation);
    window.addEventListener('online', wakeReconciliation);
    document.addEventListener('visibilitychange', wakeReconciliation);
    return () => {
      cancelled = true;
      if (retryTimeout !== undefined) window.clearTimeout(retryTimeout);
      window.removeEventListener('focus', wakeReconciliation);
      window.removeEventListener('online', wakeReconciliation);
      document.removeEventListener('visibilitychange', wakeReconciliation);
    };
  }, [authStatus, currentProjectId, syncGeneration]);

  const markGenerationFailed = useCallback(
    (
      generationToFail: Generation,
      message: string,
      extraMetadata: Record<string, unknown> = {},
    ) => {
      const userMessage = getUserFacingGenerationError(message);
      syncGeneration(createFailedGeneration(generationToFail, userMessage, extraMetadata));
      finish();
      setGenerateNotice({
        tone: 'error',
        message: userMessage,
      });
      console.error('[Liclick 3D Texture] Background generation failed:', userMessage);
    },
    [finish, setGenerateNotice, syncGeneration],
  );

  const failUnsubmittedGeneration = useCallback(
    (generation: Generation) => {
      const message = '生图任务没有成功提交到莉刻后台，已自动解除任务锁，请重新生成。';
      markGenerationFailed(generation, message, {
        submissionTimedOut: true,
        serverSubmitted: false,
      });

      // A ModelView request can remain pending even when no remote worker ever
      // accepted it. Merely failing the generation record leaves the original
      // promise, the panel submit lock and EditorPage's request bridge alive.
      // Abort and release all three ownership layers together.
      generationAbortControllersRef.current.get(generation.id)?.abort();
      generationAbortControllersRef.current.delete(generation.id);
      submitLocksRef.current.delete(getGenerationChannel(generation));
      setSubmissionActive(submitLocksRef.current.size > 0);
      if (isLocalRepaintGeneration(generation)) {
        onLocalImageGenerationSettled?.({ succeeded: false });
      }
      window.dispatchEvent(new Event(IMMEDIATE_PROJECT_SAVE_EVENT));
    },
    [markGenerationFailed, onLocalImageGenerationSettled],
  );

  const captureTextureMapCameraView = useCallback(
    async (
      view?: CameraViewItem,
      options: { setAsLastCapture?: boolean; resolution?: CaptureResolution } = {},
    ) => {
      if (!captureObjectId) throw new Error(t('importModelFirst'));
      const capture = await captureCurrentView({
        objectId: captureObjectId,
        resolution: options.resolution ?? resolutionToSize[resolution],
        framing: 'fit-object',
        colorMode: 'clay-target',
        // Leave a stable edge-safe frame for GPT/control-image upload. The
        // capture camera still keeps the preview direction and roll.
        fillRatio: 0.88,
        viewDirection: view?.viewDirection,
        viewUp: view?.viewUp,
      });
      if (options.setAsLastCapture !== false) setLastCapture(capture);
      return capture;
    },
    [captureObjectId, resolution, setLastCapture, t],
  );

  useEffect(() => {
    if (tab === 'multiview' && activeSelectedReferenceIds.length > 1) {
      setSelectedReferences([activeSelectedReferenceIds[0]]);
    }
  }, [activeSelectedReferenceIds, setSelectedReferences, tab]);

  useEffect(() => {
    cameraViewPreviewsRef.current = cameraViewPreviews;
  }, [cameraViewPreviews]);

  useEffect(() => {
    if (!currentProjectId) return;
    const currentLayers = useLayerStore.getState().layers;
    useLayerStore.getState().setLayers(currentLayers);
    const normalizedLayers = useLayerStore.getState().layers;
    if (normalizedLayers.some((layer, index) => layer.name !== currentLayers[index]?.name)) {
      setProjectLayers(normalizedLayers);
    }
  }, [currentProjectId, setProjectLayers]);

  useEffect(() => {
    capturingCameraViewsRef.current = capturingCameraViews;
  }, [capturingCameraViews]);

  useEffect(() => {
    cameraViewPreviewsRef.current = {};
    capturingCameraViewsRef.current = new Set();
    setCameraViewPreviews({});
    setCapturingCameraViews(new Set());
  }, [captureObjectId, resolution]);

  useEffect(() => {
    // On a hard refresh the project/model state is restored before the Three.js
    // viewport is mounted. Waiting for the reactive viewport avoids running the
    // one-shot thumbnail capture too early and leaving every preset tile on its
    // placeholder until the user changes presets manually.
    if (!isTextureMapTab || !captureObjectId || !viewport) return undefined;
    const currentCaptureObjectId = captureObjectId;
    const missingViews = cameraViews.filter(
      (view) =>
        !cameraViewPreviewsRef.current[view.id] && !capturingCameraViewsRef.current.has(view.id),
    );
    if (missingViews.length === 0) return undefined;

    let cancelled = false;
    capturingCameraViewsRef.current = new Set([
      ...capturingCameraViewsRef.current,
      ...missingViews.map((view) => view.id),
    ]);
    setCapturingCameraViews(
      (current) => new Set([...current, ...missingViews.map((view) => view.id)]),
    );

    async function captureMissingViews() {
      try {
        for (const view of missingViews) {
          const preview = await captureCurrentNormalPreview({
            objectId: currentCaptureObjectId,
            resolution: 512,
            framing: 'fit-object',
            fillRatio: 0.9,
            viewDirection: view.viewDirection,
            viewUp: view.viewUp,
          });
          if (cancelled) return;
          cameraViewPreviewsRef.current = {
            ...cameraViewPreviewsRef.current,
            [view.id]: preview,
          };
          setCameraViewPreviews((current) => ({ ...current, [view.id]: preview }));
          capturingCameraViewsRef.current.delete(view.id);
          setCapturingCameraViews((current) => {
            const next = new Set(current);
            next.delete(view.id);
            return next;
          });
        }
      } catch (error) {
        if (!cancelled) {
          console.warn(
            '[Liclick 3D Texture] Could not capture multiview normal thumbnails:',
            error,
          );
          setGenerateNotice({
            tone: 'warning',
            message: error instanceof Error ? error.message : '无法生成多视图法线预览。',
          });
          pushToast({
            tone: 'warning',
            title: '多视图预览生成失败',
            description: error instanceof Error ? error.message : '无法生成多视图法线预览。',
            dedupeKey: 'multiview-preview-failed',
          });
        }
      } finally {
        if (!cancelled) {
          missingViews.forEach((view) => capturingCameraViewsRef.current.delete(view.id));
          setCapturingCameraViews((current) => {
            const next = new Set(current);
            missingViews.forEach((view) => next.delete(view.id));
            return next;
          });
        }
      }
    }

    void captureMissingViews();
    return () => {
      cancelled = true;
      missingViews.forEach((view) => capturingCameraViewsRef.current.delete(view.id));
      setCapturingCameraViews((current) => {
        const next = new Set(current);
        missingViews.forEach((view) => next.delete(view.id));
        return next;
      });
    };
  }, [cameraViews, captureObjectId, isTextureMapTab, pushToast, setGenerateNotice, viewport]);

  useEffect(() => {
    const generationToPoll = activeReferenceGeneration ?? previewGeneration;
    if (!generationToPoll || generationToPoll.resultUrl) return undefined;
    if (generationToPoll.status !== 'queued' && generationToPoll.status !== 'running')
      return undefined;
    if (cancelledGenerationIdsRef.current.has(generationToPoll.id)) return undefined;
    if (!isGenerationSubmittedToServer(generationToPoll)) {
      const startedAt = getGenerationStartedAt(generationToPoll);
      const remaining = Number.isFinite(startedAt)
        ? pendingSubmissionTimeoutMs - (Date.now() - startedAt)
        : 0;
      if (remaining > 0) {
        const submissionTimeoutId = window.setTimeout(() => {
          const latest = useGenerationStore
            .getState()
            .generations.find((generation) => generation.id === generationToPoll.id);
          if (latest && isRunningGeneration(latest) && !isGenerationSubmittedToServer(latest)) {
            failUnsubmittedGeneration(latest);
          }
        }, remaining);
        return () => window.clearTimeout(submissionTimeoutId);
      }
      failUnsubmittedGeneration(generationToPoll);
      return undefined;
    }
    const taskId =
      typeof generationToPoll.metadata.taskId === 'string'
        ? generationToPoll.metadata.taskId
        : undefined;
    const clientGenerationId =
      typeof generationToPoll.metadata.clientGenerationId === 'string'
        ? generationToPoll.metadata.clientGenerationId
        : undefined;
    const serverJobId =
      typeof generationToPoll.metadata.serverJobId === 'string'
        ? generationToPoll.metadata.serverJobId
        : undefined;
    const jobId = serverJobId ?? taskId ?? clientGenerationId ?? generationToPoll.id;
    if (cancelledGenerationIdsRef.current.has(jobId)) return undefined;
    let cancelled = false;
    let timeoutId: number | undefined;
    let requestAbortController: AbortController | undefined;
    const client = createLiclickApiClient();
    const pollToastKey = generationPollToastKey(jobId);

    function clearPollRetryFeedback(showRecovered = false) {
      const failureCount = generationPollFailureCountsRef.current.get(jobId) ?? 0;
      generationPollFailureCountsRef.current.delete(jobId);
      dismissToastByDedupeKey(pollToastKey);
      if (showRecovered && failureCount >= 2)
        console.info('[Liclick 3D Texture] Background generation connection recovered.');
    }

    async function pollJob() {
      const controller = new AbortController();
      requestAbortController = controller;
      try {
        const result = await client.getGenerationJob(jobId, { signal: controller.signal });
        if (cancelled || controller.signal.aborted) return;
        if (result.message) {
          generationPollFailureCountsRef.current.set(jobId, 2);
          setGenerateNotice({ tone: 'warning', message: result.message });
          console.warn('[Liclick 3D Texture] Background generation retrying:', result.message);
        } else {
          clearPollRetryFeedback(true);
        }
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
          window.dispatchEvent(new Event(IMMEDIATE_PROJECT_SAVE_EVENT));
          console.info('[Liclick 3D Texture] Restored generation result:', generation.id);
          return;
        }
        if (result.status === 'succeeded' && !result.resultUrl) {
          markGenerationFailed(
            generationToPoll,
            '莉刻后台任务已结束，但没有返回图片 URL，已停止等待。',
          );
          return;
        }
        if (result.status === 'running' || result.status === 'queued') {
          const nextTaskId = result.taskId ?? generationToPoll.metadata.taskId;
          const nextModel = result.model ?? generationToPoll.metadata.model;
          const metadataChanged =
            generationToPoll.status !== 'running' ||
            nextTaskId !== generationToPoll.metadata.taskId ||
            nextModel !== generationToPoll.metadata.model ||
            (!generationToPoll.metadata.extraParams && Boolean(result.extraParams)) ||
            (!generationToPoll.metadata.uploadedReferences && Boolean(result.uploadedReferences));
          // Do not write a new generation object for an unchanged "running"
          // response. Updating on every poll restarts this effect immediately,
          // turning the intended interval into a request/render loop.
          if (metadataChanged) {
            syncGeneration({
              ...generationToPoll,
              status: 'running',
              metadata: {
                ...generationToPoll.metadata,
                taskId: nextTaskId,
                model: nextModel,
                extraParams: result.extraParams ?? generationToPoll.metadata.extraParams,
                uploadedReferences:
                  result.uploadedReferences ?? generationToPoll.metadata.uploadedReferences,
              },
            });
          }
        }
        if (result.status === 'failed') {
          markGenerationFailed(generationToPoll, result.error ?? '莉刻图片生成任务失败。');
          return;
        }
      } catch (error) {
        if (cancelled || controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : '';
        if (/Generation job not found|生成任务已失效|没有找到.*任务/i.test(message)) {
          clearPollRetryFeedback();
          if (!cancelled)
            markGenerationFailed(
              generationToPoll,
              '莉刻后台没有找到这个生图任务，已停止本地等待，请重新生成。',
            );
          return;
        }
        const failureCount = (generationPollFailureCountsRef.current.get(jobId) ?? 0) + 1;
        generationPollFailureCountsRef.current.set(jobId, failureCount);
        if (failureCount >= 2) {
          const retryMessage = '与本地生成服务的连接暂时不稳定，后台任务没有丢失，正在自动重试。';
          setGenerateNotice({ tone: 'warning', message: retryMessage });
          console.warn('[Liclick 3D Texture] Background generation reconnecting:', retryMessage);
        }
      } finally {
        if (requestAbortController === controller) requestAbortController = undefined;
      }
      if (!cancelled) {
        timeoutId = window.setTimeout(() => {
          timeoutId = undefined;
          void pollJob();
        }, generationPollIntervalMs);
      }
    }

    function wakePolling() {
      if (cancelled || document.visibilityState !== 'visible') return;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      requestAbortController?.abort();
      timeoutId = window.setTimeout(() => {
        timeoutId = undefined;
        void pollJob();
      }, 0);
    }

    void pollJob();
    window.addEventListener('focus', wakePolling);
    window.addEventListener('online', wakePolling);
    document.addEventListener('visibilitychange', wakePolling);
    return () => {
      cancelled = true;
      requestAbortController?.abort();
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      window.removeEventListener('focus', wakePolling);
      window.removeEventListener('online', wakePolling);
      document.removeEventListener('visibilitychange', wakePolling);
    };
  }, [
    activeReferenceGeneration,
    dismissToastByDedupeKey,
    failUnsubmittedGeneration,
    markGenerationFailed,
    previewGeneration,
    pushToast,
    setGenerateNotice,
    syncGeneration,
  ]);

  useEffect(() => {
    const completedReferenceGeneration = generations.find((generation) => {
      if (
        generation.status !== 'succeeded' ||
        !generation.resultUrl ||
        generation.metadata.referenceRole !== 'multi-view'
      ) {
        return false;
      }
      const projectId =
        typeof generation.metadata.projectId === 'string'
          ? generation.metadata.projectId
          : undefined;
      const sourceReferenceId =
        typeof generation.metadata.sourceReferenceId === 'string'
          ? generation.metadata.sourceReferenceId
          : undefined;
      return (
        (!currentProject?.id || !projectId || projectId === currentProject.id) &&
        Boolean(
          sourceReferenceId &&
          references.some(
            (reference) => reference.id === sourceReferenceId && !isMultiviewReference(reference),
          ),
        ) &&
        !references.some((reference) => reference.generationId === generation.id) &&
        !pairedGenerationPersistenceRef.current.has(generation.id)
      );
    });
    if (!completedReferenceGeneration) return;
    const sourceReferenceId =
      typeof completedReferenceGeneration.metadata.sourceReferenceId === 'string'
        ? completedReferenceGeneration.metadata.sourceReferenceId
        : undefined;
    const sourceReference = references.find(
      (reference) => reference.id === sourceReferenceId && !isMultiviewReference(reference),
    );
    if (!sourceReference) return;
    const persistPairedMultiviewReference = persistPairedMultiviewReferenceRef.current;
    if (!persistPairedMultiviewReference) return;
    pairedGenerationPersistenceRef.current.add(completedReferenceGeneration.id);
    void persistPairedMultiviewReference(sourceReference, completedReferenceGeneration)
      .then(() => {
        setReferenceGroupGenerationState(undefined);
        console.info(
          '[Liclick 3D Texture] Restored multiview result:',
          completedReferenceGeneration.id,
        );
      })
      .catch((error) => {
        const message = getUserFacingGenerationError(error, '多视图结果写回失败，请重试。');
        setReferenceGroupGenerationState({
          groupId: referenceGroupId(sourceReference),
          status: 'failed',
          error: message,
        });
      });
  }, [currentProject?.id, generations, pushToast, references]);

  function updateGenerationSettings(patch: Partial<typeof defaultImageGenerationSettings>) {
    if (workflowConfigurationLocked) {
      notifyWorkflowOperationLocked();
      return;
    }
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

  function writePromptValue(key: string, value: string) {
    promptValueRef.current = { key, value };
    if (key.endsWith(':local-repaint')) {
      setLocalRepaintPrompt(value);
      return;
    }
    const state = useProjectStore.getState();
    const project = state.projects.find((item) => item.id === state.currentProjectId);
    if (!project) return;
    state.updateProjectById(project.id, {
      settings: {
        ...project.settings,
        imageGeneration: {
          ...defaultImageGenerationSettings,
          ...project.settings.imageGeneration,
          textureMapPrompt: value,
        },
      },
    });
  }

  async function handlePromptPolish() {
    if (promptPolishing || workflowConfigurationLocked) return;
    const snapshot = { key: promptPolishKey, value: prompt };
    if (!isLocalRepaintTab && !snapshot.value.trim()) {
      pushToast({ tone: 'warning', title: '请先输入需要润色的提示词' });
      return;
    }
    const requestId = ++promptPolishRequestRef.current;
    setPromptPolishing(true);
    try {
      const promptReference = isLocalRepaintTab
        ? activeReferences.find((reference) => activeSelectedReferenceIds.includes(reference.id))
        : undefined;
      if (isLocalRepaintTab && !promptReference) {
        throw new Error('请先选择一张材质参考图，再进行智能润色。');
      }
      if (isLocalRepaintTab && !captureObjectId) throw new Error(t('importModelFirst'));
      const visualInputs =
        isLocalRepaintTab && promptReference && captureObjectId
          ? await prepareLocalRepaintPromptPolishInputs({
              objectId: captureObjectId,
              reference: promptReference,
            })
          : undefined;
      const polishedPrompt = await createLiclickApiClient().polishPrompt({
        prompt: snapshot.value,
        context: isLocalRepaintTab ? 'local-repaint' : 'general',
        modelName:
          textureViewMode === 'single' && singleViewProvider === 'remote'
            ? '远端单视图模型'
            : imageModel,
        objectName: objects.find((object) => object.id === captureObjectId)?.name,
        referenceNames: promptReference
          ? [visualInputs?.referenceImage.name ?? promptReference.name]
          : activeReferences
              .filter((reference) => activeSelectedReferenceIds.includes(reference.id))
              .map((reference) => reference.name),
        hasMask: Boolean(visualInputs),
        currentEffectImage: visualInputs?.currentEffectImage,
        maskImage: visualInputs?.maskImage,
        referenceImage: visualInputs?.referenceImage,
      });
      const currentReferenceState = useReferenceStore.getState();
      const currentSelectedReference = currentReferenceState.references.find((reference) =>
        currentReferenceState.selectedReferenceIds.includes(reference.id),
      );
      const visualContextChanged = Boolean(
        visualInputs &&
        (useSceneStore.getState().paintMaskRevision !== visualInputs.paintMaskRevision ||
          !promptReference ||
          !currentSelectedReference ||
          currentSelectedReference.id !== promptReference.id),
      );
      if (
        requestId !== promptPolishRequestRef.current ||
        promptValueRef.current.key !== snapshot.key ||
        promptValueRef.current.value !== snapshot.value ||
        visualContextChanged
      ) {
        pushToast({
          tone: 'warning',
          title: '润色上下文已发生变化，未自动覆盖',
          description: '提示词、蒙版或参考图已更新，请再次点击智能润色。',
        });
        return;
      }
      writePromptValue(snapshot.key, polishedPrompt);
      pushToast({
        tone: 'success',
        title: '智能润色已完成',
        action: {
          label: '恢复原文',
          onClick: () => {
            if (
              promptValueRef.current.key === snapshot.key &&
              promptValueRef.current.value === polishedPrompt
            ) {
              writePromptValue(snapshot.key, snapshot.value);
            }
          },
        },
      });
    } catch (error) {
      pushToast({
        tone: 'error',
        title: '智能润色失败',
        description: getUserFacingGenerationError(error, '智能润色暂时不可用，请稍后重试。'),
      });
    } finally {
      if (requestId === promptPolishRequestRef.current) setPromptPolishing(false);
    }
  }

  function handleCameraViewSelect(view: CameraViewItem) {
    if (workflowConfigurationLocked) {
      notifyWorkflowOperationLocked();
      return;
    }
    if (!captureObjectId) {
      pushToast({ tone: 'warning', title: t('importModelFirst') });
      return;
    }
    setActiveCameraViewId(view.id);
  }

  function handleCameraViewPresetSelect(selection: CameraViewPresetSelection) {
    if (workflowConfigurationLocked) {
      notifyWorkflowOperationLocked();
      return;
    }
    const nextViews =
      selection === 'custom'
        ? createCameraViewsFromValues(customCameraViewPreset.views, t)
        : createCameraViewsForPreset(selection, t);
    cameraViewPreviewsRef.current = {};
    capturingCameraViewsRef.current = new Set();
    setCameraViewPreviews({});
    setCapturingCameraViews(new Set());
    setSelectedCameraViewPreset(selection);
    setCameraViews(nextViews);
    setActiveCameraViewId(nextViews[0]?.id ?? '');
  }

  function handleDeleteCameraView(viewId: string) {
    if (workflowConfigurationLocked) {
      notifyWorkflowOperationLocked();
      return;
    }
    setSelectedCameraViewPreset('custom');
    setCameraViews((current) => current.filter((view) => view.id !== viewId));
    setCameraViewPreviews((current) => {
      const next = { ...current };
      delete next[viewId];
      return next;
    });
    if (activeCameraViewId === viewId) {
      const fallback = cameraViews.find((view) => view.id !== viewId);
      setActiveCameraViewId(fallback?.id ?? '');
    }
  }

  function handleAddCurrentCameraView() {
    if (workflowConfigurationLocked) {
      notifyWorkflowOperationLocked();
      return;
    }
    if (!captureObjectId) {
      pushToast({ tone: 'warning', title: t('importModelFirst') });
      return;
    }
    const viewport = useSceneStore.getState().viewport;
    if (!viewport) {
      pushToast({ tone: 'warning', title: t('viewportUnavailable') });
      return;
    }
    const target = viewport.controls?.target;
    const x = viewport.camera.position.x - (target?.x ?? 0);
    const y = viewport.camera.position.y - (target?.y ?? 0);
    const z = viewport.camera.position.z - (target?.z ?? 0);
    const length = Math.hypot(x, y, z) || 1;
    const id = createId('camera-view');
    const nextView: CameraViewItem = {
      id,
      label: `自定义视角 ${cameraViews.filter((view) => !view.value).length + 1}`,
      viewDirection: [x / length, y / length, z / length],
      viewUp: [viewport.camera.up.x, viewport.camera.up.y, viewport.camera.up.z],
    };
    setSelectedCameraViewPreset('custom');
    setCameraViews((current) => [...current, nextView]);
    setActiveCameraViewId(id);
    pushToast({ tone: 'success', title: '已添加当前 MVP 视角' });
  }

  function getCurrentTextureCameraView(): CameraViewItem {
    if (!captureObjectId) throw new Error(t('importModelFirst'));
    const viewport = useSceneStore.getState().viewport;
    if (!viewport) throw new Error(t('viewportUnavailable'));
    const target = viewport.controls?.target;
    const x = viewport.camera.position.x - (target?.x ?? 0);
    const y = viewport.camera.position.y - (target?.y ?? 0);
    const z = viewport.camera.position.z - (target?.z ?? 0);
    const length = Math.hypot(x, y, z) || 1;
    return {
      id: createId('single-camera-view'),
      label: '当前视角',
      viewDirection: [x / length, y / length, z / length],
      viewUp: [viewport.camera.up.x, viewport.camera.up.y, viewport.camera.up.z],
    };
  }

  function getGenerationJobId(generation: Generation) {
    const taskId =
      typeof generation.metadata.taskId === 'string' ? generation.metadata.taskId : undefined;
    const serverJobId =
      typeof generation.metadata.serverJobId === 'string'
        ? generation.metadata.serverJobId
        : undefined;
    const clientGenerationId =
      typeof generation.metadata.clientGenerationId === 'string'
        ? generation.metadata.clientGenerationId
        : undefined;
    return serverJobId ?? taskId ?? clientGenerationId ?? generation.id;
  }

  function isCancelledGeneration(generation: Generation) {
    const jobId = getGenerationJobId(generation);
    return (
      generationIdentityIds(generation).some((id) => cancelledGenerationIdsRef.current.has(id)) ||
      cancelledGenerationIdsRef.current.has(jobId)
    );
  }

  function cancelCurrentGeneration() {
    if (snapshotPreparing && texturePipelineAbortControllerRef.current) {
      setCancelTextureSnapshotConfirmOpen(true);
      return;
    }
    const generationToCancel = activeWorkflowGeneration;
    if (!generationToCancel) return;
    setCancelConfirmGeneration(generationToCancel);
  }

  function confirmCancelTextureSnapshot() {
    const controller = texturePipelineAbortControllerRef.current;
    setCancelTextureSnapshotConfirmOpen(false);
    if (!controller || controller.signal.aborted) return;
    setTexturePipelineCancelling(true);
    setTexturePipelineProgress((current) =>
      current ? { ...current, label: '正在终止多视图快照' } : current,
    );
    setGenerateNotice({ tone: 'info', message: '正在终止多视图快照，不会提交后续生图任务。' });
    controller.abort('user-cancelled-multiview-snapshot');
  }

  function confirmCancelCurrentGeneration() {
    const generationToCancel = cancelConfirmGeneration ?? activeWorkflowGeneration;
    if (!generationToCancel) return;
    setCancelConfirmGeneration(undefined);
    if (!isRunningGeneration(generationToCancel)) return;
    const isTextureMap = isTextureMapGeneration(generationToCancel);
    const isLocalRepaint = isLocalRepaintGeneration(generationToCancel);
    const textureBatchId =
      typeof generationToCancel.metadata.textureBatchId === 'string'
        ? generationToCancel.metadata.textureBatchId
        : undefined;
    if (textureBatchId) cancelledTextureBatchIdsRef.current.add(textureBatchId);

    const liveGenerations = useGenerationStore.getState().generations;
    const generationsToCancel =
      isTextureMap || isLocalRepaint
        ? liveGenerations.filter((generation) => {
            if (!isRunningGeneration(generation)) return false;
            if (isTextureMap && !isTextureMapGeneration(generation)) return false;
            if (isLocalRepaint && !isLocalRepaintGeneration(generation)) return false;
            const generationProjectId =
              typeof generation.metadata.projectId === 'string'
                ? generation.metadata.projectId
                : undefined;
            const sameProject =
              !currentProjectId || !generationProjectId || generationProjectId === currentProjectId;
            const sameBatch =
              !textureBatchId || generation.metadata.textureBatchId === textureBatchId;
            return sameProject && sameBatch;
          })
        : [generationToCancel];
    if (!generationsToCancel.some((generation) => generation.id === generationToCancel.id)) {
      generationsToCancel.push(generationToCancel);
    }

    const cancelRequests: Promise<unknown>[] = [];
    generationsToCancel.forEach((generation) => {
      const jobId = getGenerationJobId(generation);
      generationIdentityIds(generation).forEach((id) => cancelledGenerationIdsRef.current.add(id));
      cancelledGenerationIdsRef.current.add(jobId);
      generationAbortControllersRef.current.get(generation.id)?.abort();
      generationAbortControllersRef.current.delete(generation.id);
      const isLocalRepaint = isLocalRepaintGeneration(generation);
      const cancelledGeneration: Generation = {
        ...generation,
        status: 'failed',
        metadata: {
          ...generation.metadata,
          cancelled: true,
          error: isTextureMap
            ? '用户已终止纹理贴图生成任务。'
            : isLocalRepaint
              ? '用户已终止局部重绘生成任务。'
              : '用户已终止莉刻生图任务。',
          completedAt: new Date().toISOString(),
        },
      };
      syncGeneration(cancelledGeneration);

      if (
        generation.metadata.provider === 'modelview-seedvr2' ||
        generation.metadata.provider === 'modelview-int8' ||
        generation.metadata.provider === 'modelview-single-view'
      )
        return;
      // The retired local ComfyUI provider has no server-side job in the
      // zero-install cloud runtime. Historical entries are cancelled locally;
      // every current remote generation job belongs to LiClick/Atlas.
      if (generation.metadata.provider !== 'comfyui-local') {
        cancelRequests.push(createLiclickApiClient().cancelGenerationJob(jobId));
      }
    });

    const cancelsTexturePipeline = isTextureMap || texturePipelineProgress?.active === true;
    if (!isTextureMap) {
      submitLocksRef.current.delete(getGenerationChannel(generationToCancel));
      setSubmissionActive(submitLocksRef.current.size > 0);
    }
    finish();
    if (cancelsTexturePipeline) setTexturePipelineProgress(undefined);
    setGenerateNotice(undefined);
    window.dispatchEvent(new Event(IMMEDIATE_PROJECT_SAVE_EVENT));
    void Promise.allSettled(cancelRequests).then((results) => {
      results.forEach((result) => {
        if (result.status === 'rejected') {
          console.warn(
            '[Liclick 3D Texture] Could not cancel remote generation job:',
            result.reason,
          );
        }
      });
    });
  }

  async function requireFeishuLogin() {
    if (useAuthStore.getState().status === 'authenticated') return true;
    setGenerateNotice({
      tone: 'warning',
      message: '此功能需要先完成飞书身份验证，正在启动登录流程...',
    });
    try {
      const activeProviderStatus =
        providerStatus ?? (await useAuthStore.getState().refreshProviderStatus());
      if (resolveLiclickAuthStrategy(activeProviderStatus) === 'unresolved') {
        throw new Error('当前登录方式尚未配置完成，请检查本地启动配置后重试。');
      }
      pushToast({
        tone: 'warning',
        title: '需要飞书登录',
        description: '平台登录完成身份验证，生图任务由云端生产服务处理。',
        dedupeKey: 'ai-login-required',
      });
      if (activeProviderStatus.devLoginEnabled && !activeProviderStatus.feishuOAuthEnabled) {
        const result = await devLogin({
          displayName: 'Liclick Dev User',
          email: 'dev@liclick.local',
        });
        setAuthenticated(result.user, 'dev-mock', activeProviderStatus);
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
        setAuthenticated(
          result.user,
          result.authMode ?? 'feishu-oauth',
          result.providerStatus ?? activeProviderStatus,
        );
        setGenerateNotice({
          tone: 'info',
          message: '飞书身份验证已完成。',
        });
        return true;
      }
      throw new Error('登录服务没有返回用户信息，请确认飞书授权已完成。');
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

  async function requirePersonalLiclickAccount() {
    if (!(await requireFeishuLogin())) {
      throw new Error('未完成飞书登录，无法使用莉刻生图服务。');
    }
    let activeProviderStatus = useAuthStore.getState().providerStatus;
    try {
      // Atlas credentials can expire independently from the browser session.
      // Always refresh the provider state before generation so an authenticated
      // page does not submit a job with a missing/stale Atlas token cache.
      activeProviderStatus = await useAuthStore.getState().refreshProviderStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法确认当前登录方式。';
      setGenerateNotice({ tone: 'error', message });
      pushToast({
        tone: 'error',
        title: '登录方式不可用',
        description: message,
        dedupeKey: 'liclick-auth-strategy-unavailable',
      });
      throw new Error(message);
    }
    const authStrategy = resolveLiclickAuthStrategy(activeProviderStatus);
    if (authStrategy !== 'atlas-workspace') {
      const message = '当前登录方式尚未配置完成，请刷新页面或重新登录后再试。';
      setGenerateNotice({ tone: 'error', message });
      pushToast({
        tone: 'error',
        title: '登录方式不可用',
        description: message,
        dedupeKey: 'liclick-auth-strategy-unresolved',
      });
      throw new Error(message);
    }
    return true;
  }

  async function getTextureMapMultiviewCaptures(views: CameraViewItem[], signal?: AbortSignal) {
    if (!captureObjectId) throw new Error(t('importModelFirst'));
    return withStableClayTargetPresentation(captureObjectId, async () => {
      const captures: Partial<Record<string, Capture>> = {};
      for (let index = 0; index < views.length; index += 1) {
        throwIfTexturePipelineCancelled(signal);
        const view = views[index];
        if (!view) continue;
        if (captures[view.id]) continue;
        setCapturingCameraViews((current) => new Set([...current, view.id]));
        try {
          const capture = await captureTextureMapCameraView(view, { setAsLastCapture: false });
          throwIfTexturePipelineCancelled(signal);
          captures[view.id] = capture;
          updateTexturePipelineProgress(
            20 + ((index + 1) / Math.max(1, views.length)) * 18,
            `多视角快照 ${index + 1}/${views.length}`,
          );
        } finally {
          setCapturingCameraViews((current) => {
            const next = new Set(current);
            next.delete(view.id);
            return next;
          });
        }
      }
      throwIfTexturePipelineCancelled(signal);
      return views
        .map((view) => ({
          viewId: view.id,
          cameraView: view.value ?? 'custom',
          label: view.label,
          capture: captures[view.id],
        }))
        .filter(
          (
            item,
          ): item is {
            viewId: string;
            cameraView: ObjectViewPreset | 'custom';
            label: string;
            capture: Capture;
          } => Boolean(item.capture),
        );
    });
  }

  async function waitForLiclickGeneration(generation: Generation) {
    if (generation.resultUrl) return generation;
    const client = createLiclickApiClient();
    const jobId = getGenerationJobId(generation);
    const startedAt = Date.now();
    while (Date.now() - startedAt < 30 * 60 * 1000) {
      if (isCancelledGeneration(generation)) throw new Error('用户已终止纹理贴图生成任务。');
      const result = await client.getGenerationJob(jobId);
      if (result.status === 'failed') {
        throw new Error(
          getUserFacingGenerationError(result.error, '纹理贴图生成失败，请稍后重试。'),
        );
      }
      if (result.status === 'succeeded' && result.resultUrl) {
        return {
          ...generation,
          resultUrl: result.resultUrl,
          status: 'succeeded' as const,
          metadata: {
            ...generation.metadata,
            taskId: result.taskId ?? generation.metadata.taskId,
            resultUrls: result.resultUrls,
            completedAt: result.updatedAt ?? new Date().toISOString(),
          },
        };
      }
      await new Promise((resolve) => window.setTimeout(resolve, 3500));
    }
    throw new Error('等待多视角纹理贴图生成超时。');
  }

  async function handleTextureMapMultiviewGenerate(
    materialReference: ReferenceImage,
    requestedViews: CameraViewItem[] = cameraViews,
    requestedViewMode: TextureViewMode = 'multi',
    signal?: AbortSignal,
  ) {
    throwIfTexturePipelineCancelled(signal);
    if (!captureObjectId) throw new Error(t('importModelFirst'));
    if (requestedViews.length === 0) throw new Error('请先添加至少一个模型视角。');
    const isMultiviewRequest = requestedViewMode === 'multi';
    const usesRemoteSingleView = !isMultiviewRequest && singleViewProvider === 'remote';
    if (usesRemoteSingleView) {
      if (!(await requireFeishuLogin())) {
        throw new Error('未完成飞书登录，无法使用远端单视图生成服务。');
      }
    } else {
      await requirePersonalLiclickAccount();
    }
    throwIfTexturePipelineCancelled(signal);
    const objectId = captureObjectId;
    const object = objects.find((item) => item.id === objectId);
    const texturePrompt = usesRemoteSingleView ? prompt.trim() : buildTextureMapPrompt(prompt);
    const objectMatrixWorld = getImportedModelMatrixWorld(objectId);
    updateTexturePipelineProgress(20, '准备多视角快照');
    const capturedViews = await getTextureMapMultiviewCaptures(requestedViews, signal);
    throwIfTexturePipelineCancelled(signal);
    if (capturedViews.length === 0) {
      throw new Error(isMultiviewRequest ? '无法捕获多视图模型方向。' : '无法捕获当前单视图。');
    }
    if (!currentProject) throw new Error('当前工程尚未加载完成。');
    // Persist the entire camera batch before any remote job starts. Adding the
    // captures one-by-one leaves them vulnerable to an overlapping editor save
    // snapshot; a missing capture also makes its completed image impossible to
    // reproject correctly after refresh.
    const currentCaptures =
      useProjectStore.getState().projects.find((project) => project.id === currentProject.id)
        ?.captures ?? currentProject.captures;
    const capturedIds = new Set(capturedViews.map(({ capture }) => capture.id));
    const persistedCaptures = await persistCaptureAssets(
      [
        ...capturedViews.map(({ capture }) => capture),
        ...currentCaptures.filter((capture) => !capturedIds.has(capture.id)),
      ],
      currentProject.id,
    );
    throwIfTexturePipelineCancelled(signal);
    updateProjectById(currentProject.id, { captures: persistedCaptures });
    const persistedCapturesById = new Map(
      persistedCaptures.map((capture) => [capture.id, capture]),
    );
    const viewCaptures = capturedViews.map((view) => ({
      ...view,
      capture: persistedCapturesById.get(view.capture.id) ?? view.capture,
    }));
    updateTexturePipelineProgress(40, '提交纹理任务');
    throwIfTexturePipelineCancelled(signal);
    setGenerateNotice({
      tone: 'info',
      message: isMultiviewRequest
        ? `正在提交 ${viewCaptures.length} 个多视图纹理贴图任务。`
        : '正在提交当前单视图纹理贴图任务。',
    });

    const client = createLiclickApiClient();
    const modelviewClient = usesRemoteSingleView ? createModelviewApiClient() : undefined;
    const textureBatchId = createId('texture-map-batch');
    const textureBatchWasCancelled = () => cancelledTextureBatchIdsRef.current.has(textureBatchId);
    const pendingGenerations = viewCaptures.map(({ viewId, cameraView, label, capture }) => {
      const generationId = createId(`texture-map-${viewId}`);
      const modelViewReference: ReferenceImage = {
        id: `${capture.id}-model-view-${viewId}`,
        name: `Current model view - ${label}`,
        url: capture.colorUrl,
        width: capture.width,
        height: capture.height,
        objectId: capture.objectId,
        isPrimary: false,
      };
      const pendingGeneration: Generation = {
        id: generationId,
        mode: isMultiviewRequest ? 'multiview' : 'single',
        prompt: texturePrompt,
        referenceIds: [modelViewReference.id, materialReference.id],
        captureId: capture.id,
        status: 'running',
        metadata: {
          provider: usesRemoteSingleView ? 'modelview-single-view' : 'liclick-atlas',
          workflow: 'texture-map',
          textureBatchId,
          clientGenerationId: generationId,
          projectId: currentProject?.id,
          model: imageModel,
          objectId: object?.id,
          objectMatrixWorld,
          materialReferenceId: materialReference.id,
          modelViewReferenceId: modelViewReference.id,
          multiview: isMultiviewRequest,
          singleViewProvider: usesRemoteSingleView ? 'remote' : 'gpt',
          autoProjectExpected: true,
          cameraView,
          cameraViewId: viewId,
          cameraViewLabel: label,
          resolution,
          serverSubmitted: false,
          startedAt: new Date().toISOString(),
          alphaMode: 'pending-guided-foreground-matte',
        },
      };
      return {
        viewId,
        cameraView,
        label,
        capture,
        generationId,
        modelViewReference,
        pendingGeneration,
      };
    });

    pendingGenerations.forEach(({ pendingGeneration }) => {
      start(pendingGeneration);
      addProjectGeneration(pendingGeneration);
    });
    try {
      await saveCriticalProjectState({ captures: persistedCaptures });
    } catch (error) {
      if (textureBatchWasCancelled()) {
        finish();
        throw new Error('用户已终止纹理贴图生成任务。');
      }
      const message = getUserFacingGenerationError(
        error,
        isMultiviewRequest
          ? '多视图相机数据保存失败，任务尚未提交，请稍后重试。'
          : '当前单视图数据保存失败，任务尚未提交，请稍后重试。',
      );
      pendingGenerations.forEach(({ pendingGeneration }) => {
        syncGeneration(createFailedGeneration(pendingGeneration, message));
      });
      finish();
      throw error;
    }

    const results = await Promise.allSettled(
      pendingGenerations.map(async ({ capture, generationId, modelViewReference }) => {
        if (usesRemoteSingleView && modelviewClient) {
          const [whiteModelDataUrl, materialDataUrl] = await Promise.all([
            urlToDataUrl(capture.colorUrl),
            urlToDataUrl(materialReference.url),
          ]);
          throwIfTexturePipelineCancelled(signal);
          return modelviewClient.generateSingleView(
            {
              clientGenerationId: generationId,
              projectId: currentProject?.id,
              prompt: texturePrompt || undefined,
              captureId: capture.id,
              objectId: object?.id,
              image: {
                path: `${capture.id}-white-model.png`,
                dataUrl: whiteModelDataUrl,
              },
              materialImage: {
                path: `${materialReference.id}-multiview-material.png`,
                dataUrl: materialDataUrl,
              },
              materialReferenceId: materialReference.id,
              materialReferenceGroupId: referenceGroupId(materialReference),
              materialReferenceName: materialReference.name,
              materialReferenceRole: materialReference.referenceRole,
              modelViewReferenceId: modelViewReference.id,
            },
            { signal },
          );
        }
        return client.generateTextureSingleView({
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
          aspectRatio: resolveRequestAspectRatio(
            imageModel,
            aspectRatio,
            resolveRequestImageSize(imageSize),
          ),
          imageSize: resolveRequestImageSize(imageSize),
          count: 1,
        });
      }),
    );
    if (!textureBatchWasCancelled()) updateTexturePipelineProgress(46, '生成纹理贴图');

    const completedGenerations: Generation[] = [];
    let projectedGenerationCount = 0;
    const submittedGenerations: Generation[] = [];
    results.forEach((result, index) => {
      const pending = pendingGenerations[index];
      if (!pending) return;
      if (result.status === 'fulfilled') {
        const submittedGeneration: Generation = {
          ...result.value,
          mode: isMultiviewRequest ? 'multiview' : 'single',
          metadata: {
            ...mergeGenerationMetadataPreservingStartedAt(
              pending.pendingGeneration.metadata,
              result.value.metadata,
            ),
            workflow: 'texture-map',
            textureBatchId,
            objectMatrixWorld,
            materialReferenceId: materialReference.id,
            modelViewReferenceId: pending.modelViewReference.id,
            multiview: isMultiviewRequest,
            autoProjectExpected: true,
            cameraView: pending.cameraView,
            cameraViewId: pending.viewId,
            cameraViewLabel: pending.label,
            serverSubmitted: true,
            serverJobId: result.value.metadata.serverJobId ?? result.value.id,
            alphaMode: 'pending-guided-foreground-matte',
          },
        };
        if (
          textureBatchWasCancelled() ||
          isCancelledGeneration(pending.pendingGeneration) ||
          isCancelledGeneration(submittedGeneration)
        ) {
          generationIdentityIds(submittedGeneration).forEach((id) =>
            cancelledGenerationIdsRef.current.add(id),
          );
          const cancelledSubmittedGeneration: Generation = {
            ...submittedGeneration,
            status: 'failed',
            metadata: {
              ...submittedGeneration.metadata,
              cancelled: true,
              error: '用户已终止纹理贴图生成任务。',
              completedAt: new Date().toISOString(),
            },
          };
          syncGeneration(cancelledSubmittedGeneration);
          if (!usesRemoteSingleView) {
            void client
              .cancelGenerationJob(getGenerationJobId(cancelledSubmittedGeneration))
              .catch((error) =>
                console.warn(
                  '[Liclick 3D Texture] Could not cancel late-submitted texture job:',
                  error,
                ),
              );
          }
          return false;
        }
        submittedGenerations.push(submittedGeneration);
        syncGeneration(submittedGeneration);
        return false;
      }
      if (textureBatchWasCancelled() || isCancelledGeneration(pending.pendingGeneration)) return;
      syncGeneration(
        createFailedGeneration(
          pending.pendingGeneration,
          result.reason instanceof Error
            ? result.reason.message
            : `${pending.label} 视角提交失败。`,
          {
            cameraView: pending.cameraView,
            cameraViewId: pending.viewId,
            cameraViewLabel: pending.label,
          },
        ),
      );
    });
    await saveGenerationStateBestEffort();

    // Generation/network/persistence may finish one view at a time, but a
    // different projected-layer count requires a different shader and texture
    // array. Keep the last valid viewport material resident throughout the
    // batch and publish the complete stack once. Layer rows and durable project
    // saves still progress normally.
    useLayerStore.getState().beginProjectedPreviewBatch();
    try {
      let completedTextureViewCount = 0;
      const completionResults = await Promise.allSettled(
        submittedGenerations.map(async (generation) => {
          try {
            if (textureBatchWasCancelled() || isCancelledGeneration(generation)) {
              throw new Error('用户已终止纹理贴图生成任务。');
            }
            const completed = await waitForLiclickGeneration(generation);
            syncGeneration(completed);
            const completedProjectId =
              typeof completed.metadata.projectId === 'string'
                ? completed.metadata.projectId
                : currentProject?.id;
            if (
              completedProjectId &&
              useProjectStore.getState().currentProjectId !== completedProjectId
            ) {
              return { generation: completed, projected: false };
            }
            const exactCapture = pendingGenerations.find(
              (pending) =>
                pending.generationId === completed.id || pending.capture.id === completed.captureId,
            )?.capture;
            try {
              const projectedLayer = await addGenerationAsProjectedLayer(completed, {
                automatic: true,
                capture: exactCapture,
              });
              if (!projectedLayer) {
                return { generation: completed, projected: false };
              }
              const completedWithProjection: Generation = {
                ...completed,
                metadata: {
                  ...completed.metadata,
                  autoProjectExpected: true,
                  projectedLayerId: projectedLayer.id,
                  projectionCommittedAt: new Date().toISOString(),
                  projectionError: undefined,
                },
              };
              syncGeneration(completedWithProjection);
              return { generation: completedWithProjection, projected: true };
            } catch (error) {
              const message =
                error instanceof Error ? error.message : '生成已完成，但自动投影失败。';
              const completedWithProjectionError: Generation = {
                ...completed,
                metadata: { ...completed.metadata, projectionError: message },
              };
              syncGeneration(completedWithProjectionError);
              console.warn(
                `[Liclick 3D Texture] ${String(completed.metadata.cameraViewLabel ?? '当前')} view generated but projection is pending:`,
                message,
              );
              return { generation: completedWithProjectionError, projected: false };
            }
          } finally {
            completedTextureViewCount += 1;
            if (!textureBatchWasCancelled()) {
              updateTexturePipelineProgress(
                46 + (completedTextureViewCount / Math.max(1, submittedGenerations.length)) * 40,
                `纹理生成与投影 ${completedTextureViewCount}/${submittedGenerations.length}`,
              );
            }
          }
        }),
      );
      completionResults.forEach((result, index) => {
        const submitted = submittedGenerations[index];
        if (!submitted) return;
        if (result.status === 'fulfilled') {
          completedGenerations.push(result.value.generation);
          if (result.value.projected) projectedGenerationCount += 1;
        } else {
          if (textureBatchWasCancelled() || isCancelledGeneration(submitted)) return;
          syncGeneration(
            createFailedGeneration(
              submitted,
              result.reason instanceof Error
                ? result.reason.message
                : isMultiviewRequest
                  ? '多视角纹理贴图任务失败。'
                  : '当前单视图纹理贴图任务失败。',
            ),
          );
        }
      });

      // Validate the batch against the actual layer store, not only fulfilled
      // promises. A concurrent editor save may have refreshed the store while a
      // view was persisting; retry every completed generation that still has no
      // durable projected layer before declaring the batch complete.
      for (let index = 0; index < completedGenerations.length; index += 1) {
        const generation = completedGenerations[index];
        if (!generation?.resultUrl || generation.status !== 'succeeded') continue;
        const existingLayer = useLayerStore
          .getState()
          .layers.find((layer) => layer.generationId === generation.id);
        if (existingLayer) continue;
        const exactCapture = pendingGenerations.find(
          (pending) =>
            pending.generationId === generation.id || pending.capture.id === generation.captureId,
        )?.capture;
        try {
          const recoveredLayer = await addGenerationAsProjectedLayer(generation, {
            automatic: true,
            capture: exactCapture,
          });
          if (!recoveredLayer) continue;
          const recoveredGeneration: Generation = {
            ...generation,
            metadata: {
              ...generation.metadata,
              autoProjectExpected: true,
              projectedLayerId: recoveredLayer.id,
              projectionCommittedAt: new Date().toISOString(),
              projectionError: undefined,
            },
          };
          completedGenerations[index] = recoveredGeneration;
          syncGeneration(recoveredGeneration);
        } catch (error) {
          console.error('[Liclick 3D Texture] Could not recover missing projected view:', error);
        }
      }
    } finally {
      useLayerStore.getState().endProjectedPreviewBatch();
    }
    const completedGenerationIds = new Set(completedGenerations.map((generation) => generation.id));
    projectedGenerationCount = useLayerStore
      .getState()
      .layers.filter(
        (layer) => layer.generationId && completedGenerationIds.has(layer.generationId),
      ).length;
    await saveGenerationStateBestEffort();

    if (textureBatchWasCancelled()) {
      setGenerateNotice(undefined);
      setTexturePipelineProgress(undefined);
      finish();
      return;
    }

    if (isMultiviewRequest && projectedGenerationCount > 0) {
      updateTexturePipelineProgress(90, '内容识别补缝');
      setGenerateNotice({
        tone: 'info',
        message: '纹理贴图已投影，正在自动执行内容识别修补。',
      });
      try {
        await requestContentAwareRepair({
          source: 'multiview-texture',
          projectId: currentProject.id,
          objectId,
          batchId: completedGenerations.map((generation) => generation.id).join(':'),
          silentForeground: true,
        });
        updateTexturePipelineProgress(100, '补缝完成');
      } catch (error) {
        updateTexturePipelineProgress(100, '纹理完成，补缝未完成');
        console.warn('[Liclick 3D Texture] Automatic content repair did not complete:', error);
      }
    } else {
      updateTexturePipelineProgress(100, '纹理生成完成');
    }

    if (completedGenerations.length > 0) {
      setGenerateNotice(undefined);
      pushToast({
        tone: 'success',
        title: t('textureMapGenerated'),
        description: isMultiviewRequest
          ? `已生成 ${completedGenerations.length}/${pendingGenerations.length} 个多视图纹理贴图，自动投影 ${projectedGenerationCount}/${completedGenerations.length} 个。`
          : `单视图纹理贴图已生成并自动投影 ${projectedGenerationCount}/${completedGenerations.length} 个。`,
      });
    } else {
      setGenerateNotice({
        tone: 'error',
        message: isMultiviewRequest
          ? '多视图纹理贴图任务提交失败。'
          : '单视图纹理贴图任务提交失败。',
      });
    }
  }

  async function handleLocalRepaintGenerate() {
    lastCompletedLocalRepaintGenerationIdRef.current = undefined;
    let pendingGeneration: Generation | undefined;
    let requestAbortController: AbortController | undefined;
    let promptAnalysisCurrentEffectUrl: string | undefined;
    try {
      if (workflowSubmissionLocked || submitLocksRef.current.size > 0 || previewIsGenerating) {
        notifyWorkflowOperationLocked();
        return false;
      }
      if (!currentProject || !captureObjectId) throw new Error(t('importModelFirst'));
      const initialMaskState = useSceneStore.getState();
      if (!initialMaskState.paintMaskHasContent) {
        setGenerateNotice({
          tone: 'warning',
          message: '请先绘制蒙版，再进行局部生图。',
        });
        pushToast({
          tone: 'warning',
          title: '请先绘制蒙版',
          description: '请标记需要生成的区域，再点击局部生图。',
          dedupeKey: 'local-repaint-mask-required',
        });
        return false;
      }
      // Freeze the authored view synchronously at the click boundary. Login,
      // mask encoding and cold GPU preparation may take several seconds; the
      // user can keep orbiting without changing any of the three model inputs.
      const captureAspect = 1;
      const captureCameraSnapshot = snapshotCurrentCaptureCamera(captureAspect);
      const captureObjectMatrixWorld = getImportedModelMatrixWorld(captureObjectId);
      const objectId = captureObjectId;
      const referenceStateAtSubmission = useReferenceStore.getState();
      const referencesAtSubmission = referenceStateAtSubmission.references;
      const textureMapCandidates = useGenerationStore
        .getState()
        .generations.filter((generation) => {
          if (!isTextureMapGeneration(generation)) return false;
          const generationProjectId = generation.metadata.projectId;
          if (typeof generationProjectId === 'string' && generationProjectId !== currentProject.id)
            return false;
          const generationObjectId = generation.metadata.objectId;
          if (
            typeof generationObjectId === 'string'
              ? generationObjectId !== objectId
              : !generationBelongsToObject(generation, objectId, currentProject.captures)
          )
            return false;
          const referenceId = generation.metadata.materialReferenceId;
          return (
            typeof referenceId === 'string' &&
            referencesAtSubmission.some(
              (reference) => reference.id === referenceId && isMultiviewReference(reference),
            )
          );
        })
        .sort((left, right) => {
          const recency = (generation: Generation) => {
            const completedAt = generation.metadata.completedAt;
            const completedTimestamp =
              typeof completedAt === 'string' ? Date.parse(completedAt) : Number.NaN;
            const startedTimestamp = getGenerationStartedAt(generation);
            return Number.isFinite(completedTimestamp)
              ? completedTimestamp
              : Number.isFinite(startedTimestamp)
                ? startedTimestamp
                : Number.NEGATIVE_INFINITY;
          };
          return recency(right) - recency(left);
        });
      const historicalReferenceId = textureMapCandidates[0]?.metadata.materialReferenceId;
      let materialReference = resolveLocalRepaintMaterialReference({
        references: referencesAtSubmission,
        selectedReferenceIds: referenceStateAtSubmission.selectedReferenceIds,
        historicalReferenceId:
          typeof historicalReferenceId === 'string' ? historicalReferenceId : undefined,
      });
      if (!materialReference) {
        setGenerateNotice({
          tone: 'warning',
          message: '请先在纹理贴图中选择一张单视图或多视图材质参考图。',
        });
        pushToast({
          tone: 'warning',
          title: '缺少材质参考图',
          description: '局部生图优先使用当前选择；未选择时才复用最近一次纹理任务的材质参考。',
          dedupeKey: 'generate-local-repaint-material-reference-required',
        });
        return false;
      }
      submitLocksRef.current.add('repaint');
      setSubmissionActive(true);
      setLocalRepaintPreparation((current) => ({
        startedAt: current?.startedAt ?? Date.now(),
        detail: '正在准备当前视角',
      }));
      // Keep the previous completed repaint on its resident GPU path while the
      // next request prepares detached browser snapshots.
      useSceneStore.getState().setLocalRepaintGenerationPresentationActive(true);
      if (authStatus !== 'authenticated' && !(await requireFeishuLogin())) return false;
      if (!isMultiviewReference(materialReference)) {
        setLocalRepaintPreparation((current) => ({
          startedAt: current?.startedAt ?? Date.now(),
          detail: '正在准备多视图材质参考',
        }));
        setGenerateNotice({
          tone: 'info',
          message: '第 1/2 步：已选择单视图，正在自动生成多视图参考。',
        });
        materialReference = await generatePairedMultiviewReference(materialReference);
        setGenerateNotice({
          tone: 'info',
          message: '第 2/2 步：多视图参考已就绪，正在准备局部生图。',
        });
      }
      setLocalRepaintPreparation((current) => ({
        startedAt: current?.startedAt ?? Date.now(),
        detail: '正在保存当前项目状态',
      }));
      // Snapshot the current project immediately, but keep that Project Command
      // off the request's critical path. The remote request below is fully
      // described by detached captures and immutable input assets; waiting for
      // Revision CAS here only delayed compute submission without making those
      // inputs safer. Final writeback still uses the serialized critical-save
      // queue and the normal immediate-save recovery path.
      const criticalProjectSavePromise = saveCriticalProjectState({
        references: useReferenceStore.getState().references,
      });
      void criticalProjectSavePromise.then(
        () => {
          document.body.dataset.localRepaintBackgroundProjectSave = 'succeeded';
        },
        (error) => {
          document.body.dataset.localRepaintBackgroundProjectSave = 'failed';
          console.warn(
            '[Liclick 3D Texture] Background project snapshot failed; scheduling normal save recovery.',
            error,
          );
          window.dispatchEvent(new Event(IMMEDIATE_PROJECT_SAVE_EVENT));
        },
      );
      setGenerateNotice({
        tone: 'info',
        message: '正在准备当前蒙版与视角。',
      });
      // Commit the button state and progress text before any GPU capture work.
      // This guarantees an immediate visual response even on a cold renderer.
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      // ModelView receives one square 2K composite: authored BaseColor outside
      // the user's selection and the aligned clay geometry preview inside it.
      // Qwen receives the clean authored view instead, plus the original
      // authored mask and full multiview reference, so neither placeholder
      // shading nor the remote-only blending margin biases its diagnosis.
      document.body.dataset.perfLocalRepaintPhase = 'button2-mask-capture';
      setLocalRepaintPreparation((current) => ({
        startedAt: current?.startedAt ?? Date.now(),
        detail: '正在准备当前蒙版',
      }));
      const maskCaptureStartedAt = performance.now();
      const currentPaintMaskDataUrl =
        (await useSceneStore.getState().paintMaskCapture?.({
          aspect: captureAspect,
          camera: captureCameraSnapshot.camera,
          resolution: LOCAL_REPAINT_INPUT_RESOLUTION,
        })) ?? useSceneStore.getState().paintMaskDataUrl;
      document.body.dataset.localRepaintButton2MaskCaptureMs = (
        performance.now() - maskCaptureStartedAt
      ).toFixed(1);
      if (!currentPaintMaskDataUrl) throw new Error('无法读取已绘制的局部重绘蒙版。');
      useSceneStore.getState().setPaintMaskDataUrl(currentPaintMaskDataUrl, true);
      // The server validates exact dimensions and the red-channel content before
      // forwarding the mask. Avoid a duplicate browser decode on the hot path.
      document.body.dataset.perfLocalRepaintPhase = 'button2-view-capture';
      setLocalRepaintPreparation((current) => ({
        startedAt: current?.startedAt ?? Date.now(),
        detail: '正在准备当前效果图',
      }));
      const viewCaptureStartedAt = performance.now();
      let capture = await captureCurrentLocalRepaintView(
        {
          objectId,
          resolution: LOCAL_REPAINT_INPUT_RESOLUTION,
          framing: 'current',
          colorMode: 'flat-target',
          aspect: captureAspect,
          cameraSnapshot: captureCameraSnapshot,
        },
        currentPaintMaskDataUrl,
        { archive: false },
      );
      const flatCurrentEffectUrl = capture.colorUrl;
      promptAnalysisCurrentEffectUrl = flatCurrentEffectUrl;
      let clayPreviewUrl: string | undefined;
      let preparedGenerationInput: Awaited<
        ReturnType<typeof prepareLocalRepaintGenerationInput>
      >;
      try {
        const clayPreview = await captureCurrentColorPreview({
          objectId,
          resolution: LOCAL_REPAINT_INPUT_RESOLUTION,
          framing: 'current',
          colorMode: 'clay-target',
          aspect: captureAspect,
          cameraSnapshot: captureCameraSnapshot,
        });
        clayPreviewUrl = clayPreview.colorUrl;
        setLocalRepaintPreparation((current) => ({
          startedAt: current?.startedAt ?? Date.now(),
          detail: '正在融合当前效果与蒙版预览',
        }));
        preparedGenerationInput = await prepareLocalRepaintGenerationInput({
          currentEffectUrl: flatCurrentEffectUrl,
          clayPreviewUrl,
          authoredMaskUrl: currentPaintMaskDataUrl,
        });
      } finally {
        revokeRegisteredObjectUrl(clayPreviewUrl);
      }
      capture = {
        ...capture,
        colorUrl: preparedGenerationInput.compositeUrl,
        // Capture/paintback keeps the authored selection. The expanded mask is
        // a remote-sampling input only and must never become the interactive
        // local-repaint brush authorization mask.
        maskUrl: currentPaintMaskDataUrl,
      };
      useProjectStore.getState().addCapture(capture);
      document.body.dataset.localRepaintButton2ViewCaptureMs = (
        performance.now() - viewCaptureStartedAt
      ).toFixed(1);
      const currentPaintMaskRevision = useSceneStore.getState().paintMaskRevision;
      const generationId = createId('local-repaint');
      const persistedAuthoredMaskUrlPromise = persistGeneratedImage(
        'generations',
        currentPaintMaskDataUrl,
        `${generationId}-authored-mask.png`,
        undefined,
        currentProject.id,
      ).catch((error) => {
        console.warn('[Liclick 3D Texture] Could not persist authored repaint mask:', error);
        return currentPaintMaskDataUrl;
      });
      const persistedSubmittedMaskUrlPromise = persistGeneratedImage(
        'generations',
        preparedGenerationInput.submittedMaskUrl,
        `${generationId}-submitted-mask.png`,
        undefined,
        currentProject.id,
      ).catch((error) => {
        console.warn('[Liclick 3D Texture] Could not persist submitted repaint mask:', error);
        return preparedGenerationInput.submittedMaskUrl;
      });

      const rawUserPrompt = localRepaintPrompt.trim();
      const surfaceSignature = useLayerStore
        .getState()
        .layers.filter((layer) => !layer.objectId || layer.objectId === objectId)
        .map((layer) => [
          layer.id,
          layer.contentRevision ?? 0,
          layer.visible ? 1 : 0,
          layer.opacity,
        ]);
      const promptFingerprint = JSON.stringify({
        prompt: rawUserPrompt,
        ...(rawUserPrompt ? {} : { autoDiagnosisPolicy: LOCAL_REPAINT_AUTO_DIAGNOSIS_POLICY }),
        projectId: currentProject.id,
        objectId,
        referenceId: materialReference.id,
        paintMaskRevision: currentPaintMaskRevision,
        camera: capture.camera,
        objectMatrixWorld: captureObjectMatrixWorld,
        surfaceSignature,
        sourceComposition: 'flat-clay-mask-v1',
      });
      let resolvedPrompt = localRepaintResolvedPromptCacheRef.current.get(promptFingerprint);
      if (!resolvedPrompt) {
        const persistedResolution = useGenerationStore
          .getState()
          .generations.find(
            (candidate) =>
              candidate.metadata.promptFingerprint === promptFingerprint &&
              candidate.prompt.trim().length > 0,
          );
        if (persistedResolution) {
          resolvedPrompt = {
            prompt: persistedResolution.prompt,
            source:
              persistedResolution.metadata.promptSource === 'auto-diagnosis'
                ? 'auto-diagnosis'
                : 'user-request',
          };
          localRepaintResolvedPromptCacheRef.current.set(promptFingerprint, resolvedPrompt);
        }
      }
      if (!resolvedPrompt) {
        setLocalRepaintPreparation((current) => ({
          startedAt: current?.startedAt ?? Date.now(),
          detail: rawUserPrompt ? '正在优化局部重绘提示词' : '正在分析蒙版区域问题',
        }));
        setGenerateNotice({
          tone: 'info',
          message: rawUserPrompt
            ? '正在结合蒙版与六视图优化提示词。'
            : '正在分析蒙版区域问题并生成提示词。',
        });
        const visualInputs = await prepareLocalRepaintPromptPolishInputs({
          objectId,
          reference: materialReference,
          cameraSnapshot: captureCameraSnapshot,
          currentEffectUrl: promptAnalysisCurrentEffectUrl,
          maskUrl: currentPaintMaskDataUrl,
          paintMaskRevision: currentPaintMaskRevision,
        });
        const optimizedPrompt = await createLiclickApiClient().polishPrompt({
          prompt: rawUserPrompt,
          context: 'local-repaint',
          modelName: 'FLUX.2 Klein',
          objectName: objects.find((object) => object.id === objectId)?.name,
          referenceNames: [visualInputs.referenceImage.name || materialReference.name],
          hasMask: true,
          currentEffectImage: visualInputs.currentEffectImage,
          maskImage: visualInputs.maskImage,
          referenceImage: visualInputs.referenceImage,
        });
        if (useSceneStore.getState().paintMaskRevision !== currentPaintMaskRevision) {
          throw new Error('蒙版在分析期间发生变化，请重新生成。');
        }
        resolvedPrompt = {
          prompt: optimizedPrompt,
          source: rawUserPrompt ? 'user-request' : 'auto-diagnosis',
        };
        const promptCache = localRepaintResolvedPromptCacheRef.current;
        if (promptCache.size >= 6) {
          const oldestKey = promptCache.keys().next().value;
          if (oldestKey) promptCache.delete(oldestKey);
        }
        promptCache.set(promptFingerprint, resolvedPrompt);
      }
      const effectivePrompt = resolvedPrompt.prompt;
      pendingGeneration = {
        id: generationId,
        mode: 'inpaint',
        prompt: effectivePrompt,
        referenceIds: [materialReference.id],
        captureId: capture.id,
        status: 'running',
        metadata: {
          provider: 'modelview-int8',
          workflow: 'local-repaint',
          modelviewWorkflow: '2026.08.28-cd48a78-truev3-gguf-mask-4input-rseed-r1',
          clientGenerationId: generationId,
          projectId: currentProject.id,
          objectId,
          materialReferenceId: materialReference.id,
          paintMaskRevision: currentPaintMaskRevision,
          paintMaskSource: 'user',
          authoredMaskUrl: currentPaintMaskDataUrl,
          submittedMaskUrl: preparedGenerationInput.submittedMaskUrl,
          promptSource: resolvedPrompt.source,
          promptFingerprint,
          userPrompt: rawUserPrompt,
          sourceColorMode: 'flat-clay-mask-v1',
          sourceComposition: 'flat-clay-mask-v1',
          maskExpansionRadius: preparedGenerationInput.dilationRadius,
          maskFeatherRadius: preparedGenerationInput.featherRadius,
          resultComposition: 'direct-v1',
          objectMatrixWorld: captureObjectMatrixWorld,
          captureCamera: capture.camera,
          serverSubmitted: false,
          startedAt: new Date().toISOString(),
        },
      };
      start(pendingGeneration);
      addProjectGeneration(pendingGeneration);
      setLocalRepaintPreparation(undefined);
      // Publish the capture only after its running generation exists. Publishing
      // it earlier lets the preview selector pair this new mask with the
      // previous completed result for the same object, which triggers a hidden
      // 2K IMG decode/mask composition in the button-2 hot path.
      setLastCapture(capture);
      setGenerateNotice({
        tone: 'info',
        message: '正在提交当前效果图、材质参考图、蒙版和提示词。',
      });
      requestAbortController = new AbortController();
      generationAbortControllersRef.current.set(generationId, requestAbortController);
      const [currentEffectDataUrl, materialReferenceDataUrl, maskDataUrl] = await Promise.all([
        urlToDataUrl(capture.colorUrl),
        urlToDataUrl(materialReference.url),
        urlToDataUrl(preparedGenerationInput.submittedMaskUrl),
      ]);
      const generationPromise = createModelviewApiClient().generateInpaint(
        {
          clientGenerationId: generationId,
          projectId: currentProject.id,
          captureId: capture.id,
          objectId,
          materialReferenceId: materialReference.id,
          materialReferenceGroupId: referenceGroupId(materialReference),
          materialReferenceName: materialReference.name,
          materialReferenceRole: isMultiviewReference(materialReference)
            ? 'multi-view'
            : 'single-view',
          prompt: effectivePrompt,
          image: { path: 'current-effect.png', dataUrl: currentEffectDataUrl },
          materialImage: {
            path: `${generationId}-${materialReference.id}-material-reference.png`,
            dataUrl: materialReferenceDataUrl,
          },
          mask: { path: `${generationId}-mask.png`, dataUrl: maskDataUrl },
        },
        { signal: requestAbortController.signal },
      );
      // The depth guard is local-only. Capture it at 1K from the exact frozen
      // camera while the remote request is already running, then attach it to
      // the archived capture before the result can be painted back.
      const depthPreviewPromise = captureCurrentDepthPreview({
        objectId,
        resolution: 1024,
        framing: 'current',
        aspect: captureAspect,
        cameraSnapshot: captureCameraSnapshot,
      }).catch((error) => {
        console.warn('[Liclick 3D Texture] Local repaint depth guard was not captured:', error);
        return undefined;
      });
      const [generation, depthPreview] = await Promise.all([
        generationPromise,
        depthPreviewPromise,
      ]);
      if (depthPreview) {
        capture = {
          ...capture,
          depthUrl: depthPreview.depthUrl,
          depthEncoding: depthPreview.depthEncoding,
          warnings: [...capture.warnings, ...depthPreview.warnings],
        };
        const captureProject = useProjectStore
          .getState()
          .projects.find((project) => project.id === currentProject.id);
        const currentCaptures = captureProject?.captures ?? [];
        updateProjectById(currentProject.id, {
          captures: currentCaptures.some((item) => item.id === capture.id)
            ? currentCaptures.map((item) => (item.id === capture.id ? capture : item))
            : [capture, ...currentCaptures],
        });
        setLastCapture(capture);
      }
      if (isCancelledGeneration(pendingGeneration)) return false;
      const completedGeneration: Generation = {
        ...generation,
        // Keep one canonical client id from start through completion. Some
        // legacy ModelView responses used the remote id here, leaving the
        // persisted client-id record permanently `running` beside the result.
        id: pendingGeneration.id,
        resultUrl: generation.resultUrl,
        captureId: generation.captureId ?? capture.id,
        metadata: {
          ...pendingGeneration.metadata,
          ...generation.metadata,
          objectMatrixWorld: captureObjectMatrixWorld,
          captureCamera: capture.camera,
          maskUrl: currentPaintMaskDataUrl,
          rawResultUrl: generation.resultUrl,
          resultComposition: 'direct-v1',
          paintMaskRevision: currentPaintMaskRevision,
          sourceColorMode: 'flat-clay-mask-v1',
          sourceComposition: 'flat-clay-mask-v1',
          completedAt: generation.metadata.completedAt ?? new Date().toISOString(),
        },
      };
      syncGeneration(completedGeneration);
      // metadata.maskUrl owns the exact snapshot used by this task. Keep the
      // single live mask intact until the user edits or explicitly clears it.
      lastCompletedLocalRepaintGenerationIdRef.current = completedGeneration.id;
      if (completedGeneration.resultUrl) {
        ensureLocalRepaintSessionLayer(completedGeneration.id, {
          preserveActiveProjection: true,
          preserveActiveLayer: true,
        });
      }
      setGenerateNotice(undefined);
      setTexturePreviewMode('repaint');
      setTab('repaint');
      pushToast({
        tone: 'success',
        title: '局部生图已生成',
        description: '结果已显示在局部重绘中。',
      });
      const persistedResultUrlPromise = completedGeneration.resultUrl
        ? persistGeneratedImage(
            'generations',
            completedGeneration.resultUrl,
            `${generationId}-direct-v1.png`,
            undefined,
            currentProject.id,
          ).catch((error) => {
            console.warn('[Liclick 3D Texture] Could not localize repaint result:', error);
            return completedGeneration.resultUrl;
          })
        : Promise.resolve(undefined);
      void Promise.all([
        persistedResultUrlPromise,
        persistedAuthoredMaskUrlPromise,
        persistedSubmittedMaskUrlPromise,
      ])
        .then(async ([persistedResultUrl, persistedAuthoredMaskUrl, persistedSubmittedMaskUrl]) => {
          const latestCompletedRecord =
            useGenerationStore
              .getState()
              .generations.find((candidate) => candidate.id === completedGeneration.id) ??
            completedGeneration;
          const durableGeneration: Generation = {
            ...latestCompletedRecord,
            resultUrl: persistedResultUrl ?? completedGeneration.resultUrl,
            metadata: {
              ...completedGeneration.metadata,
              ...latestCompletedRecord.metadata,
              maskUrl: persistedAuthoredMaskUrl,
              authoredMaskUrl: persistedAuthoredMaskUrl,
              submittedMaskUrl: persistedSubmittedMaskUrl,
              rawResultUrl: persistedResultUrl ?? completedGeneration.resultUrl,
              resultComposition: 'direct-v1',
            },
          };
          syncGeneration(durableGeneration);
          // The capture is the canonical camera/depth binding for this
          // generation. An overlapping editor autosave can legitimately
          // complete after capture creation; pass the authoritative record
          // explicitly so a stale snapshot cannot leave generation.captureId
          // pointing at a missing capture on the next repaint cycle.
          const latestCaptureProject = useProjectStore
            .getState()
            .projects.find((project) => project.id === currentProject.id);
          const authoritativeCapture = {
            ...capture,
            maskUrl: persistedAuthoredMaskUrl,
          };
          const authoritativeCaptures = [
            authoritativeCapture,
            ...(latestCaptureProject?.captures ?? []).filter(
              (candidate) => candidate.id !== capture.id,
            ),
          ];
          await saveCriticalProjectState({ captures: authoritativeCaptures });
        })
        .catch((error) => {
          // The completed server result remains usable in memory. The normal
          // project save/recovery path will retry persistence without reviving
          // the foreground generation spinner.
          console.warn('[Liclick 3D Texture] Could not persist repaint completion:', error);
          if (useProjectStore.getState().currentProjectId === currentProject.id) {
            window.dispatchEvent(new Event(IMMEDIATE_PROJECT_SAVE_EVENT));
          }
        });
      return true;
    } catch (error) {
      if (pendingGeneration && isCancelledGeneration(pendingGeneration)) return false;
      const rawMessage = error instanceof Error ? error.message : String(error);
      console.error('[ModelView INT8 Material Repaint] generation failed:', error);
      const timedOutGeneration = pendingGeneration
        ? useGenerationStore
            .getState()
            .generations.find((generation) => generation.id === pendingGeneration?.id)
        : undefined;
      if (
        timedOutGeneration?.status === 'failed' &&
        timedOutGeneration.metadata.submissionTimedOut === true
      ) {
        const timeoutMessage =
          typeof timedOutGeneration.metadata.error === 'string'
            ? timedOutGeneration.metadata.error
            : '生图任务未成功进入后台，已解除任务锁。';
        setGenerateNotice({ tone: 'error', message: timeoutMessage });
        return false;
      }
      const message = getUserFacingGenerationError(error, '局部重绘生成失败，请稍后重试。');
      if (pendingGeneration) {
        syncGeneration(
          createFailedGeneration(pendingGeneration, message, {
            rawError: rawMessage,
          }),
        );
      }
      setGenerateNotice({ tone: 'error', message });
      pushToast({ tone: 'error', title: t('localRepaintFailed'), description: message });
      return false;
    } finally {
      if (document.body.dataset.perfLocalRepaintPhase?.startsWith('button2-')) {
        delete document.body.dataset.perfLocalRepaintPhase;
      }
      if (
        pendingGeneration &&
        generationAbortControllersRef.current.get(pendingGeneration.id) === requestAbortController
      ) {
        generationAbortControllersRef.current.delete(pendingGeneration.id);
      }
      submitLocksRef.current.delete('repaint');
      setSubmissionActive(submitLocksRef.current.size > 0);
      setLocalRepaintPreparation(undefined);
      useSceneStore.getState().setLocalRepaintGenerationPresentationActive(false);
      revokeRegisteredObjectUrl(promptAnalysisCurrentEffectUrl);
      finish();
    }
  }

  handleLocalRepaintGenerateRef.current = handleLocalRepaintGenerate;

  async function persistPairedMultiviewReference(
    singleReference: ReferenceImage,
    generation: Generation,
  ) {
    if (!generation.resultUrl) throw new Error('多视图任务完成，但没有返回可用图片。');
    const groupId = referenceGroupId(singleReference);
    const referenceId = createId('reference');
    const size = await getImageSize(generation.resultUrl);
    const persistedUrl = await persistGeneratedImage(
      'references',
      generation.resultUrl,
      `${referenceId}.png`,
    );
    const multiviewReference: ReferenceImage = {
      id: referenceId,
      name: `${singleReference.name} · 多视图`,
      url: persistedUrl,
      width: size.width,
      height: size.height,
      isPrimary: false,
      referenceGroupId: groupId,
      referenceRole: 'multi-view',
      derivedFromReferenceId: singleReference.id,
      referenceSource: 'generated',
      generationId: generation.id,
    };
    const latestReferences = useReferenceStore.getState().references;
    const nextReferences = [
      multiviewReference,
      ...latestReferences.filter(
        (reference) =>
          !(isMultiviewReference(reference) && referenceGroupId(reference) === groupId),
      ),
    ];
    useReferenceStore.getState().setReferences(nextReferences);
    // A single-view reference is only the input to this job. Once its paired
    // multi-view result exists, make that result the active reference and move
    // the panel to multi-view in the same render so the user never sees the
    // completed result land under the wrong tab.
    useReferenceStore.getState().setSelectedReferences([multiviewReference.id]);
    setTexturePreviewMode('multi');
    setTextureViewMode('multi');
    setTab('multiview');
    setProjectReferences(nextReferences);
    await saveCriticalProjectState({ references: nextReferences });
    return multiviewReference;
  }
  persistPairedMultiviewReferenceRef.current = persistPairedMultiviewReference;

  async function generatePairedMultiviewReference(singleReference: ReferenceImage) {
    const groupId = referenceGroupId(singleReference);
    let pendingGeneration: Generation | undefined;
    setReferenceGroupGenerationState({ groupId, status: 'generating' });
    try {
      await requirePersonalLiclickAccount();
      const submittedPrompt = buildMultiviewPrompt(liclickPrompt);
      const generationId = createId('reference-multiview');
      pendingGeneration = {
        id: generationId,
        mode: 'single',
        prompt: submittedPrompt,
        referenceIds: [singleReference.id],
        status: 'running',
        metadata: {
          provider: 'liclick-atlas',
          workflow: 'liclick',
          clientGenerationId: generationId,
          projectId: currentProject?.id,
          model: imageModel,
          resolution,
          referenceGroupId: groupId,
          sourceReferenceId: singleReference.id,
          referenceRole: 'multi-view',
          serverSubmitted: false,
          startedAt: new Date().toISOString(),
        },
      };
      start(pendingGeneration);
      addProjectGeneration(pendingGeneration);
      await saveCriticalProjectState({ references: useReferenceStore.getState().references });
      const submitted = await createLiclickApiClient().generateTextureSingleView({
        clientGenerationId: generationId,
        projectId: currentProject?.id,
        workflow: 'liclick',
        mode: 'single',
        prompt: submittedPrompt,
        referenceIds: [singleReference.id],
        referenceImages: [singleReference],
        resolution,
        textureMode: 'realistic',
        visibleOnly: true,
        upscale: false,
        model: imageModel,
        aspectRatio: resolveRequestAspectRatio(
          imageModel,
          aspectRatio,
          resolveRequestImageSize(imageSize),
        ),
        imageSize: resolveRequestImageSize(imageSize),
        count: 1,
      });
      const alignedGeneration: Generation = {
        ...pendingGeneration,
        ...submitted,
        metadata: {
          ...pendingGeneration.metadata,
          ...submitted.metadata,
          workflow: 'liclick',
          referenceGroupId: groupId,
          sourceReferenceId: singleReference.id,
          referenceRole: 'multi-view',
          serverSubmitted: true,
          serverJobId: submitted.metadata.serverJobId ?? submitted.id,
        },
      };
      if (isCancelledGeneration(pendingGeneration) || isCancelledGeneration(alignedGeneration)) {
        generationIdentityIds(alignedGeneration).forEach((id) =>
          cancelledGenerationIdsRef.current.add(id),
        );
        syncGeneration({
          ...alignedGeneration,
          status: 'failed',
          metadata: {
            ...alignedGeneration.metadata,
            cancelled: true,
            error: '用户已终止纹理贴图生成任务。',
            completedAt: new Date().toISOString(),
          },
        });
        void createLiclickApiClient()
          .cancelGenerationJob(getGenerationJobId(alignedGeneration))
          .catch((error) =>
            console.warn(
              '[Liclick 3D Texture] Could not cancel late-submitted multiview job:',
              error,
            ),
          );
        throw new Error('用户已终止纹理贴图生成任务。');
      }
      syncGeneration(alignedGeneration);
      const completedGeneration = await waitForLiclickGeneration(alignedGeneration);
      pairedGenerationPersistenceRef.current.add(completedGeneration.id);
      syncGeneration(completedGeneration);
      const multiviewReference = await persistPairedMultiviewReference(
        singleReference,
        completedGeneration,
      );
      await saveGenerationStateBestEffort();
      setReferenceGroupGenerationState(undefined);
      finish();
      return multiviewReference;
    } catch (error) {
      if (pendingGeneration && isCancelledGeneration(pendingGeneration)) {
        setReferenceGroupGenerationState(undefined);
        await saveGenerationStateBestEffort();
        finish();
        throw error;
      }
      const message = getUserFacingGenerationError(error, '多视图生成失败，请稍后重试。');
      if (pendingGeneration) syncGeneration(createFailedGeneration(pendingGeneration, message));
      setReferenceGroupGenerationState({ groupId, status: 'failed', error: message });
      await saveGenerationStateBestEffort();
      finish();
      throw error;
    }
  }

  async function handleGeneratePairedMultiview(singleReference: ReferenceImage) {
    if (workflowSubmissionLocked || submitLocksRef.current.size > 0) {
      notifyWorkflowOperationLocked();
      return;
    }
    submitLocksRef.current.add('single');
    setSubmissionActive(true);
    setGenerateNotice({ tone: 'info', message: '正在根据单视图生成并保存配对多视图。' });
    try {
      await generatePairedMultiviewReference(singleReference);
      setGenerateNotice(undefined);
      pushToast({
        tone: 'success',
        title: '多视图已补全',
        description: '结果已写回当前参考图，可直接生成纹理贴图。',
      });
    } catch (error) {
      if (isGenerationCancellation(error)) {
        setGenerateNotice(undefined);
        return;
      }
      const message = getUserFacingGenerationError(error, '多视图生成失败，请稍后重试。');
      setGenerateNotice({ tone: 'error', message });
      pushToast({ tone: 'error', title: '多视图生成失败', description: message });
    } finally {
      submitLocksRef.current.delete('single');
      setSubmissionActive(submitLocksRef.current.size > 0);
    }
  }

  async function handleGenerate() {
    // Route by the preview the user can actually see. This also protects the
    // click between two batched state updates: a repaint preview must never
    // fall through to the multi-view texture pipeline.
    if (displayedTexturePreviewMode === 'repaint') {
      if (onRequestLocalImageGeneration) {
        onRequestLocalImageGeneration();
        return;
      }
      await handleLocalRepaintGenerate();
      return;
    }
    await handleTextureMapGenerate(
      textureViewMode === 'multi' ? cameraViews : undefined,
      textureViewMode,
    );
  }

  async function handleTextureMapGenerate(
    requestedViews: CameraViewItem[] | undefined = undefined,
    requestedViewMode: TextureViewMode = textureViewMode,
  ) {
    let pipelineAbortController: AbortController | undefined;
    try {
      if (workflowSubmissionLocked || submitLocksRef.current.size > 0 || previewIsGenerating) {
        notifyWorkflowOperationLocked();
        return;
      }
      if (!selectedSingleReference && !selectedMultiviewReference) {
        setGenerateNotice({
          tone: 'warning',
          message: '请至少上传并选择一张单视图或多视图参考图。',
        });
        pushToast({
          tone: 'warning',
          title: t('textureMap'),
          description: '单视图和多视图任选其一；只有单视图时系统会自动补全多视图。',
          dedupeKey: 'texture-map-reference-required',
        });
        return;
      }
      submitLocksRef.current.add('multiview');
      setSubmissionActive(true);
      pipelineAbortController = new AbortController();
      texturePipelineAbortControllerRef.current = pipelineAbortController;
      setTexturePipelineCancelling(false);
      setTexturePipelineProgress({ active: true, progress: 3, label: '检查参考图' });
      let materialReference = selectedMultiviewReference;
      if (!materialReference) {
        if (!selectedSingleReference) throw new Error('当前参考图没有可用的单视图或多视图。');
        setGenerateNotice({
          tone: 'info',
          message: '第 1/2 步：当前参考图缺少多视图，正在自动生成并写回。',
        });
        updateTexturePipelineProgress(6, '生成多视图参考');
        materialReference = await generatePairedMultiviewReference(selectedSingleReference);
        updateTexturePipelineProgress(18, '多视图参考已就绪');
      } else {
        updateTexturePipelineProgress(18, '多视图参考已就绪');
      }
      setGenerateNotice({
        tone: 'info',
        message:
          requestedViewMode === 'multi'
            ? '第 2/2 步：多视图已就绪，正在生成纹理贴图。'
            : '多视图已就绪，正在生成当前单视角纹理贴图。',
      });
      const resolvedViews =
        requestedViews ??
        (requestedViewMode === 'single' ? [getCurrentTextureCameraView()] : cameraViews);
      await handleTextureMapMultiviewGenerate(
        materialReference,
        resolvedViews,
        requestedViewMode,
        pipelineAbortController.signal,
      );
    } catch (error) {
      if (isGenerationCancellation(error)) {
        setGenerateNotice(undefined);
        setTexturePipelineProgress(undefined);
        finish();
        return;
      }
      console.error('[Liclick 3D Texture] Texture map generation failed:', error);
      const message = getUserFacingGenerationError(error, '纹理贴图生成失败，请稍后重试。');
      setGenerateNotice({
        tone: 'error',
        message,
      });
      await saveGenerationStateBestEffort();
      finish();
      setTexturePipelineProgress(undefined);
    } finally {
      if (texturePipelineAbortControllerRef.current === pipelineAbortController) {
        texturePipelineAbortControllerRef.current = undefined;
      }
      setCancelTextureSnapshotConfirmOpen(false);
      setTexturePipelineCancelling(false);
      submitLocksRef.current.delete('multiview');
      setSubmissionActive(submitLocksRef.current.size > 0);
      setTexturePipelineProgress((current) =>
        current?.progress === 100 ? { ...current, active: false } : current,
      );
    }
  }

  async function persistGeneratedImage(
    category: AssetCategory,
    url: string,
    filename: string,
    blob?: Blob,
    targetProjectId = currentProject?.id,
  ) {
    const targetProject = useProjectStore
      .getState()
      .projects.find((project) => project.id === targetProjectId);
    if (
      !targetProject ||
      targetProject.workspaceMode !== 'local-server' ||
      (isWorkspaceAssetUrl(url) &&
        (!isCloudBuild ||
          !isLegacyWorkspaceAssetUrl(url) ||
          isIntegratedLoopbackWorkspaceAssetUrl(url)))
    )
      return url;
    if (isCloudBuild && isLegacyWorkspaceAssetUrl(url)) {
      const result = await saveBlobAsset({
        projectId: targetProject.id,
        category,
        blob: await readWorkspaceAssetBlob(url),
        filename,
      });
      return result.asset.url;
    }
    if (blob) {
      const result = await saveBlobAsset({
        projectId: targetProject.id,
        category,
        blob,
        filename,
      });
      return result.asset.url;
    }
    if (url.startsWith('http')) {
      try {
        const result = await saveRemoteUrlAsset({
          projectId: targetProject.id,
          category,
          url,
          filename,
        });
        return result.asset.url;
      } catch {
        const result = await saveBlobAsset({
          projectId: targetProject.id,
          category,
          blob: await urlToBlob(url),
          filename,
        });
        return result.asset.url;
      }
    }
    if (url.startsWith('blob:')) {
      const registeredBlob = getRegisteredObjectUrlBlob(url);
      if (registeredBlob) {
        const result = await saveBlobAsset({
          projectId: targetProject.id,
          category,
          blob: registeredBlob,
          filename,
        });
        return result.asset.url;
      }
    }
    const dataUrl = url.startsWith('data:') ? url : await urlToDataUrl(url);
    const result = await saveDataUrlAsset({
      projectId: targetProject.id,
      category,
      dataUrl,
      filename,
    });
    return result.asset.url;
  }

  async function persistCaptureAssets(captures: Capture[], targetProjectId: string) {
    const targetProject = useProjectStore
      .getState()
      .projects.find((project) => project.id === targetProjectId);
    if (!targetProject || targetProject.workspaceMode !== 'local-server') return captures;
    let changed = false;
    const persistedCaptures = await Promise.all(
      captures.map(async (capture) => {
        // The four capture planes are independent immutable assets. Persisting
        // them in series charged every upload to the button-2 save barrier.
        const [colorUrl, maskUrl, depthUrl, normalUrl] = await Promise.all([
          persistGeneratedImage(
            'captures',
            capture.colorUrl,
            `${capture.id}-color.png`,
            undefined,
            targetProjectId,
          ),
          persistGeneratedImage(
            'captures',
            capture.maskUrl,
            `${capture.id}-mask.png`,
            undefined,
            targetProjectId,
          ),
          capture.depthUrl
            ? persistGeneratedImage(
                'captures',
                capture.depthUrl,
                `${capture.id}-depth.png`,
                undefined,
                targetProjectId,
              )
            : Promise.resolve(undefined),
          capture.normalUrl
            ? persistGeneratedImage(
                'captures',
                capture.normalUrl,
                `${capture.id}-normal.png`,
                undefined,
                targetProjectId,
              )
            : Promise.resolve(undefined),
        ]);
        changed ||=
          colorUrl !== capture.colorUrl ||
          maskUrl !== capture.maskUrl ||
          depthUrl !== capture.depthUrl ||
          normalUrl !== capture.normalUrl;
        return { ...capture, colorUrl, maskUrl, depthUrl, normalUrl };
      }),
    );
    if (changed) updateProjectById(targetProjectId, { captures: persistedCaptures });
    return persistedCaptures;
  }

  async function persistReferenceAssets(
    referencesToPersist: ReferenceImage[],
    targetProjectId: string,
  ) {
    const targetProject = useProjectStore
      .getState()
      .projects.find((project) => project.id === targetProjectId);
    if (!targetProject || targetProject.workspaceMode !== 'local-server') {
      return referencesToPersist;
    }
    let changed = false;
    const persistedReferences = await Promise.all(
      referencesToPersist.map(async (reference) => {
        const url = await persistGeneratedImage(
          'references',
          reference.url,
          `${reference.id}.png`,
          undefined,
          targetProjectId,
        );
        changed ||= url !== reference.url;
        return url === reference.url ? reference : { ...reference, url };
      }),
    );
    if (changed) {
      if (useProjectStore.getState().currentProjectId === targetProjectId) {
        useReferenceStore.getState().setReferences(persistedReferences);
      }
      updateProjectById(targetProjectId, { references: persistedReferences });
    }
    return persistedReferences;
  }

  async function saveCriticalProjectStateNow(overrides: {
    layers?: Layer[];
    references?: ReferenceImage[];
    captures?: Capture[];
  }) {
    const targetProjectId = currentProject?.id;
    if (!targetProjectId) return;
    const projectState = useProjectStore.getState();
    const project = projectState.projects.find((item) => item.id === targetProjectId);
    if (!project || project.workspaceMode !== 'local-server') return;
    const isTargetProjectActive = projectState.currentProjectId === targetProjectId;
    // Captures and references do not depend on one another. Persisting them in
    // series charged both asset walks to the button-2 critical path and could
    // make the "save current project" barrier take twice as long.
    const [captures, references] = await Promise.all([
      persistCaptureAssets(overrides.captures ?? project.captures, targetProjectId),
      persistReferenceAssets(
        overrides.references ??
          (isTargetProjectActive ? useReferenceStore.getState().references : project.references),
        targetProjectId,
      ),
    ]);
    const objects = isTargetProjectActive ? useSceneStore.getState().objects : project.objects;
    const layers =
      overrides.layers ??
      (isTargetProjectActive ? useLayerStore.getState().layers : project.layers);
    const targetGenerations = useGenerationStore
      .getState()
      .generations.filter((generation) => generationBelongsToProject(generation, targetProjectId));
    const generations = isTargetProjectActive ? targetGenerations : project.generations;

    // A generation submission often races editor auto-save, upload completion,
    // UV handoff or a cloud job. Always merge texture-owned state into the
    // authoritative server document. Replacing it with the React snapshot that
    // opened the page can repeatedly fail revision checks and, if accepted,
    // could roll back unrelated UV/bake/pipeline state.
    const result = await updateLatestProject(
      targetProjectId,
      (latest) => ({
        ...latest,
        name: project.name,
        thumbnail: project.thumbnail,
        objects,
        layers,
        references,
        generations,
        captures,
        bakedTextures: project.bakedTextures,
        currentMode: project.currentMode,
        activeObjectId: project.activeObjectId,
        activeLayerId: project.activeLayerId,
        deletedObjectIds: project.deletedObjectIds,
        settings: project.settings,
        updatedAt: new Date().toISOString(),
        dirty: false,
        workspaceMode: 'local-server' as const,
      }),
      5,
    );
    const savedProjectSnapshot = result.project;
    const latestProject = useProjectStore
      .getState()
      .projects.find((project) => project.id === targetProjectId);
    const sameIds = (left: Array<{ id: string }> | undefined, right: Array<{ id: string }>) =>
      (left ?? [])
        .map((item) => item.id)
        .sort()
        .join('|') ===
      right
        .map((item) => item.id)
        .sort()
        .join('|');
    const savedLatestSnapshot = Boolean(
      latestProject?.id === savedProjectSnapshot.id &&
      Date.parse(latestProject.updatedAt) <= Date.parse(savedProjectSnapshot.updatedAt) &&
      sameIds(latestProject.layers, savedProjectSnapshot.layers) &&
      sameIds(latestProject.captures, savedProjectSnapshot.captures) &&
      sameIds(latestProject.generations, savedProjectSnapshot.generations) &&
      sameIds(latestProject.references, savedProjectSnapshot.references),
    );
    updateProjectById(targetProjectId, {
      workspaceMode: 'local-server',
      workspaceName: result.slug,
      lastSavedAt: result.project.lastSavedAt,
      dirty: !savedLatestSnapshot,
      assetManifest: result.project.assetManifest,
      revision: result.project.revision,
    });
    if (
      !savedLatestSnapshot &&
      typeof window !== 'undefined' &&
      useProjectStore.getState().currentProjectId === targetProjectId
    ) {
      window.dispatchEvent(new Event(IMMEDIATE_PROJECT_SAVE_EVENT));
    }
  }

  async function saveCriticalProjectState(overrides: {
    layers?: Layer[];
    references?: ReferenceImage[];
    captures?: Capture[];
  }) {
    const operation = criticalProjectSaveQueueRef.current
      .catch(() => undefined)
      .then(() => saveCriticalProjectStateNow(overrides));
    criticalProjectSaveQueueRef.current = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async function saveGenerationStateBestEffort() {
    try {
      await saveCriticalProjectState({});
    } catch (error) {
      console.error('[Liclick 3D Texture] Could not persist generation state:', error);
      if (useProjectStore.getState().currentProjectId === currentProject?.id) {
        window.dispatchEvent(new Event(IMMEDIATE_PROJECT_SAVE_EVENT));
      }
    }
  }

  async function stageGenerationAsProjectedLayer(
    generation: Generation,
    options: { automatic?: boolean; capture?: Capture } = {},
  ) {
    if (!generation.resultUrl || !isTextureMapGeneration(generation)) return undefined;
    const targetProjectId =
      typeof generation.metadata.projectId === 'string'
        ? generation.metadata.projectId
        : currentProject?.id;
    if (targetProjectId && useProjectStore.getState().currentProjectId !== targetProjectId) {
      return undefined;
    }
    const existing = useLayerStore
      .getState()
      .layers.find((layer) => layer.generationId === generation.id);
    if (existing && options.automatic) {
      return { layer: existing, shouldPersist: false as const };
    }
    const projectCaptures =
      useProjectStore.getState().projects.find((project) => project.id === targetProjectId)
        ?.captures ??
      currentProject?.captures ??
      [];
    const generationCapture =
      options.capture?.id === generation.captureId
        ? options.capture
        : lastCapture?.id === generation.captureId
          ? lastCapture
          : projectCaptures.find((capture) => capture.id === generation.captureId);
    if (!generationCapture) {
      throw new Error(
        `${String(generation.metadata.cameraViewLabel ?? '当前')}视角缺少对应相机捕获，已停止投影以避免贴到错误方向。`,
      );
    }
    const readableResultUrl = generation.resultUrl.startsWith('http')
      ? await urlToDataUrl(generation.resultUrl)
      : generation.resultUrl;
    const singleViewTexture =
      generation.mode === 'single' &&
      generation.metadata.workflow === 'texture-map' &&
      generation.metadata.multiview !== true;
    const hasVisibleTextureBase =
      singleViewTexture &&
      useLayerStore.getState().layers.some((layer) => {
        if (
          !layer.visible ||
          !layer.imageUrl ||
          layer.generationId === generation.id ||
          layer.replacementTargetLayerId
        )
          return false;
        if (
          layer.type !== 'uv' &&
          (layer.type !== 'projected' ||
            layer.projectionCompositeMode === 'single-view-priority-v1')
        )
          return false;
        return (
          !generationCapture.objectId ||
          !layer.objectId ||
          layer.objectId === generationCapture.objectId
        );
      });
    let projectedResultUrl = readableResultUrl;
    let projectionUsesSourceAlpha = false;
    if (singleViewTexture && generationCapture.maskUrl) {
      try {
        // The panel preview is tightly cropped and cannot be projected without
        // changing camera UVs. Prepare the same cleaned edge colours in the
        // original capture frame, then bleed them outside the separate mask so
        // linear/mipmap sampling cannot pull the provider's dark backdrop into
        // the model silhouette.
        projectedResultUrl = await createCaptureMaskedProjectionImage(
          readableResultUrl,
          generationCapture.maskUrl,
          { edgeBlend: hasVisibleTextureBase },
        );
        projectionUsesSourceAlpha = hasVisibleTextureBase;
      } catch (error) {
        console.warn(
          '[Liclick 3D Texture] Could not decontaminate projected image edges; using the original result.',
          error,
        );
      }
    }
    // Image download can outlive the editor route. Never apply the
    // old project's layer to whichever project became current in the meantime.
    if (targetProjectId && useProjectStore.getState().currentProjectId !== targetProjectId) {
      return undefined;
    }
    const layerId = existing?.id ?? createId('projected-layer');
    return {
      generation,
      existingLayer: existing,
      layerId,
      generationCapture,
      projectedResultUrl,
      projectionUsesSourceAlpha,
      targetProjectId,
      shouldPersist: true as const,
    };
  }

  async function persistGenerationAsProjectedLayer(
    prepared: {
      generation: Generation;
      existingLayer?: Layer;
      layerId: string;
      generationCapture: Capture;
      projectedResultUrl: string;
      projectionUsesSourceAlpha: boolean;
      targetProjectId?: string;
      shouldPersist: true;
    },
    options: { automatic?: boolean; capture?: Capture } = {},
  ) {
    const {
      generation,
      existingLayer,
      generationCapture,
      layerId,
      projectedResultUrl,
      projectionUsesSourceAlpha,
      targetProjectId,
    } = prepared;
    let persistedGenerationCapture = generationCapture;
    if (currentProject?.workspaceMode === 'local-server') {
      const currentCaptures =
        useProjectStore.getState().projects.find((project) => project.id === currentProject.id)
          ?.captures ?? currentProject.captures;
      const captures = await persistCaptureAssets(
        [
          generationCapture,
          ...currentCaptures.filter((capture) => capture.id !== generationCapture.id),
        ],
        currentProject.id,
      );
      persistedGenerationCapture =
        captures.find((capture) => capture.id === generationCapture.id) ?? generationCapture;
    }
    let imageUrl: string;
    let maskUrl: string | undefined;
    let depthUrl: string | undefined;
    try {
      [imageUrl, maskUrl, depthUrl] = await Promise.all([
        persistGeneratedImage('layers', projectedResultUrl, `${layerId}.png`),
        persistedGenerationCapture?.maskUrl
          ? persistGeneratedImage(
              'layers',
              persistedGenerationCapture.maskUrl,
              `${layerId}-mask.png`,
            )
          : Promise.resolve(undefined),
        persistedGenerationCapture?.depthUrl
          ? persistGeneratedImage(
              'layers',
              persistedGenerationCapture.depthUrl,
              `${layerId}-depth.png`,
            )
          : Promise.resolve(undefined),
      ]);
    } catch (error) {
      console.error('[Liclick 3D Texture] Could not persist projected layer assets:', error);
      if (!options.automatic) {
        pushToast({
          tone: 'warning',
          title: '图层保存失败',
          description: error instanceof Error ? error.message : '请确认工作区服务在线后再试。',
          dedupeKey: `layer-save-failed:${layerId}`,
        });
      }
      throw error;
    }
    if (targetProjectId && useProjectStore.getState().currentProjectId !== targetProjectId) {
      return undefined;
    }
    const currentExisting = useLayerStore
      .getState()
      .layers.find((layer) => layer.id === layerId || layer.generationId === generation.id);
    // A manual replacement may target a layer that the user deleted while its
    // files were saving. New automatic layers have not entered the store yet,
    // so they can be committed safely only after every asset is durable.
    if (existingLayer && !currentExisting) return undefined;
    let layer: Layer;
    if (currentExisting) {
      const singleViewTexture =
        generation.mode === 'single' &&
        generation.metadata.workflow === 'texture-map' &&
        generation.metadata.multiview !== true;
      layer = {
        ...currentExisting,
        imageUrl,
        maskUrl,
        maskSpace: maskUrl ? 'projection' : undefined,
        depthUrl,
        camera: persistedGenerationCapture.camera,
        ignoreSourceAlpha: singleViewTexture
          ? !projectionUsesSourceAlpha
          : currentExisting.ignoreSourceAlpha,
        minimumProjectionFacing: singleViewTexture
          ? SINGLE_VIEW_GENERATED_MINIMUM_PROJECTION_FACING
          : currentExisting.minimumProjectionFacing,
        projectionVisibilityPolicy: singleViewTexture ? 'surface-locked-v1' : 'standard',
        contentRevision: (currentExisting.contentRevision ?? 0) + 1,
        isBaked: false,
        needsRebake: true,
      };
      useLayerStore.getState().updateLayer(currentExisting.id, layer);
    } else {
      layer = addProjectedLayerFromGeneration(
        {
          ...generation,
          resultUrl: imageUrl,
          metadata: {
            ...generation.metadata,
            alphaMode: 'geometry-mask-separated',
            projectionEdgeBlendMode: projectionUsesSourceAlpha ? 'distance-field-v1' : undefined,
          },
        },
        {
          ...persistedGenerationCapture,
          maskUrl: maskUrl ?? persistedGenerationCapture.maskUrl,
          depthUrl: depthUrl ?? persistedGenerationCapture.depthUrl,
        },
        persistedGenerationCapture.objectId,
        layerId,
      );
    }
    const nextLayers = useLayerStore.getState().layers;
    setProjectLayers(nextLayers);
    try {
      await saveCriticalProjectState({ layers: nextLayers });
    } catch (error) {
      console.error('[Liclick 3D Texture] Could not persist projected layer:', error);
      if (!options.automatic) {
        pushToast({
          tone: 'warning',
          title: '图层已添加，但工程保存失败',
          description: error instanceof Error ? error.message : '请确认工作区服务在线后再试。',
          dedupeKey: `layer-save-failed:${layer.id}`,
        });
      }
      throw error;
    }
    if (!options.automatic) {
      pushToast({
        tone: 'success',
        title: t('autoBakeLayerAdded'),
        description: `${layer.name} ${t('projectedLayerPreviewOnlyHelp')}`,
      });
    }
    return layer;
  }

  async function addGenerationAsProjectedLayer(
    generation: Generation,
    options: { automatic?: boolean; capture?: Capture } = {},
  ) {
    // Remote multi-view jobs may finish together. Keep staging and persistence
    // in one transaction: if the next view enters the layer store while the
    // previous view is saving, that save snapshot contains a not-yet-persisted
    // blob layer and can be rejected or overwrite part of the six-view batch.
    const operation = projectedLayerCommitQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const prepared = await stageGenerationAsProjectedLayer(generation, options);
        if (!prepared || !prepared.shouldPersist) return prepared?.layer;
        return persistGenerationAsProjectedLayer(prepared, options);
      });
    projectedLayerCommitQueueRef.current = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async function handleAddProjectedLayer() {
    if (workflowConfigurationLocked) {
      notifyWorkflowOperationLocked();
      return;
    }
    if (!displayedPreviewGeneration) return;
    await addGenerationAsProjectedLayer(displayedPreviewGeneration);
  }

  async function handleDownloadGenerationImage() {
    if (!displayedPreviewGeneration?.resultUrl) return;
    const kind = isTextureMapGeneration(displayedPreviewGeneration)
      ? 'texture_map'
      : 'liclick_generation';
    const downloaded = await downloadImageAsset(
      previewResultUrl ?? displayedPreviewGeneration.resultUrl,
      `liclick_${kind}_${displayedPreviewGeneration.id}`,
    );
    if (!downloaded) return;
    trackModuleAction(
      isLocalRepaintGeneration(displayedPreviewGeneration) ? 'local_repaint' : 'texture_painting',
      'download',
    );
  }

  const generateAction = (
    <div
      data-texture-onboarding="generate-texture"
      data-onboarding-complete={
        previewGeneration?.status === 'succeeded' &&
        Boolean(previewGeneration.resultUrl) &&
        isTextureMapGeneration(previewGeneration)
          ? 'true'
          : 'false'
      }
      className={`bg-[#0c0c15]/98 p-2 shadow-[0_-16px_42px_rgba(0,0,0,0.68)] backdrop-blur-xl ${
        canCancelGeneration ? 'grid grid-cols-[1fr_52px] gap-2' : ''
      }`}
    >
      <Button
        className={`relative h-12 w-full overflow-hidden text-base ${
          texturePipelineProgress?.active && tab === 'multiview' ? 'disabled:opacity-100' : ''
        }`}
        variant="primary"
        disabled={
          !workflowSubmissionLocked &&
          ((tab === 'multiview' && texturePipelineProgress?.active) ||
            previewIsGenerating ||
            displayedReferenceGroupGenerationState?.status === 'generating')
        }
        aria-disabled={workflowSubmissionLocked}
        onClick={() => {
          if (workflowSubmissionLocked) {
            notifyWorkflowOperationLocked();
            return;
          }
          void handleGenerate();
        }}
        icon={
          generateActionRunning ? (
            <LoaderCircle className="relative z-10 h-4 w-4 animate-spin" />
          ) : (
            <Sparkles className="relative z-10 h-4 w-4" />
          )
        }
        style={
          texturePipelineProgress?.active && tab === 'multiview'
            ? {
                backgroundColor: '#25182f',
                backgroundImage:
                  'linear-gradient(90deg, rgba(242,76,193,0.96), rgba(132,81,255,0.98)), linear-gradient(90deg, #25182f, #322044)',
                backgroundPosition: 'left top, left top',
                backgroundRepeat: 'no-repeat',
                backgroundSize: `${texturePipelineProgress.progress}% 100%, 100% 100%`,
                transition: 'background-size 500ms ease, filter 200ms ease',
              }
            : undefined
        }
      >
        <span className="relative z-10">
          {texturePipelineProgress?.active && tab === 'multiview'
            ? `${texturePipelineProgress.label} · ${Math.round(texturePipelineProgress.progress)}%`
            : generateActionRunning
              ? t('generating')
              : tab === 'multiview'
                ? t('generateTextureMap')
                : tab === 'repaint'
                  ? '局部生图'
                  : t('generateImage')}
        </span>
      </Button>
      {canCancelGeneration && (
        <Button
          data-task-preview-allowed="true"
          className="h-12 w-full px-0"
          variant="danger"
          onClick={cancelCurrentGeneration}
          title={
            snapshotPreparing
              ? '终止多视图快照'
              : isTextureMapTab
                ? '终止纹理贴图生成'
                : isLocalRepaintTab
                  ? '终止局部重绘生成'
                  : '终止莉刻生图'
          }
          aria-label={
            snapshotPreparing
              ? '终止多视图快照'
              : isTextureMapTab
                ? '终止纹理贴图生成'
                : isLocalRepaintTab
                  ? '终止局部重绘生成'
                  : '终止莉刻生图'
          }
          icon={<Square className="h-4 w-4 fill-current" />}
        />
      )}
    </div>
  );

  return (
    <>
      <Panel
        title={t('generatePanel')}
        className="generate-panel-adaptive flex h-full min-h-0 flex-col overflow-hidden"
      >
        {(isTextureMapTab || isLocalRepaintTab) && (
          <div
            data-task-preview-allowed="true"
            data-texture-onboarding="single-view"
            data-onboarding-complete={displayedTexturePreviewMode === 'single' ? 'true' : 'false'}
          >
            <SegmentedControl<TexturePreviewMode>
              value={displayedTexturePreviewMode}
              options={[
                { value: 'multi', label: '多视图' },
                { value: 'single', label: '单视图' },
                { value: 'repaint', label: '局部重绘' },
              ]}
              onChange={(value) => {
                setTexturePreviewMode(value);
                if (value === 'repaint') {
                  setTab('repaint');
                } else {
                  setTextureViewMode(value);
                  setTab('multiview');
                }
              }}
              className="mb-2"
            />
          </div>
        )}
        {isTextureMapTab && displayedTexturePreviewMode === 'single' && (
          <div
            data-single-view-provider={singleViewProvider}
            className="mb-2 rounded-md border border-white/10 bg-black/20 p-1.5"
          >
            <SegmentedControl<SingleViewProvider>
              value={singleViewProvider}
              options={[
                { value: 'gpt', label: 'GPT2', disabled: workflowConfigurationLocked },
                { value: 'remote', label: '远端', disabled: workflowConfigurationLocked },
              ]}
              onChange={(value) => {
                if (workflowConfigurationLocked) {
                  notifyWorkflowOperationLocked();
                  return;
                }
                setSingleViewProvider(value);
              }}
            />
          </div>
        )}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-white/10 bg-black/24">
          {displayedTexturePreviewMode !== 'multi' && (
            <div className="generate-preview-adaptive relative shrink-0 overflow-hidden bg-[#1b1b1b]">
              {displayedPreviewGeneration?.resultUrl ? (
                <button
                  type="button"
                  data-task-preview-allowed="true"
                  className="h-full w-full cursor-zoom-in"
                  onClick={() => setPreviewImageOpen(true)}
                  aria-label={t('view')}
                  title={t('view')}
                  style={checkerBackgroundStyle}
                >
                  <img
                    src={previewResultUrl ?? displayedPreviewGeneration.resultUrl}
                    alt=""
                    className="h-full w-full object-contain"
                  />
                </button>
              ) : displayedTexturePreviewMode === 'repaint' ? (
                <div className="grid h-full w-full place-items-center px-5 text-center">
                  <div className="grid gap-1">
                    <div className="text-sm font-semibold text-white/72">暂无局部重绘结果</div>
                    <div className="text-xs text-white/42">完成局部重绘生图后将在这里显示。</div>
                  </div>
                </div>
              ) : (
                <div className="h-full w-full bg-[#1b1b1b]" />
              )}
              {displayedPreviewGeneration?.resultUrl && (
                <div className="absolute right-2 top-2 flex gap-1 rounded-md border border-white/10 bg-black/68 p-1 shadow-xl backdrop-blur-sm">
                  {isTextureMapGeneration(displayedPreviewGeneration) && (
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
                    onClick={() => void handleDownloadGenerationImage()}
                  >
                    <Download className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    data-task-preview-allowed="true"
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-white transition hover:bg-white/12"
                    title={t('view')}
                    aria-label={t('view')}
                    onClick={() => setPreviewImageOpen(true)}
                  >
                    <Maximize2 className="h-4 w-4" />
                  </button>
                </div>
              )}
              {displayedPreviewIsGenerating && displayedPreviewGeneration && (
                <div className={previewProgressOverlayClassName}>
                  <GenerationProgressStatus generation={displayedPreviewGeneration} />
                </div>
              )}
              {displayedTexturePreviewMode === 'repaint' &&
                localRepaintPreparation &&
                !displayedPreviewIsGenerating && (
                  <div className={previewProgressOverlayClassName}>
                    <LocalRepaintPreparationStatus
                      startedAt={localRepaintPreparation.startedAt}
                      detail={localRepaintPreparation.detail}
                    />
                  </div>
                )}
              {displayedPreviewFailed && !displayedPreviewIsGenerating && (
                <div className="absolute inset-0 grid place-items-center bg-rose-950/28 px-4 text-center text-white">
                  <div className="grid gap-1">
                    <div className="text-sm font-semibold">
                      {displayedPreviewCancelled ? '已终止' : '生成失败'}
                    </div>
                    <div className="text-xs text-white/66">
                      {displayedPreviewCancelled
                        ? '当前生成任务已停止等待，本次结果已丢弃。'
                        : '请检查提示词、参考图或模型要求后重试。'}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="generate-content-adaptive scrollbar-none flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-2.5 pt-2.5">
            {isTextureMapTab && texturePreviewMode === 'multi' && (
              <section className="generate-multiview-adaptive order-1 grid shrink-0 content-start gap-2">
                <div
                  data-texture-onboarding="multiview-retry"
                  className="grid grid-cols-3 gap-2"
                  role="tablist"
                  aria-label="多视图预设"
                >
                  {cameraViewPresetOptions.map((option) => {
                    const selected = selectedCameraViewPreset === option.id;
                    const viewCount =
                      option.id === 'preset-1'
                        ? 10
                        : option.id === 'preset-2'
                          ? 14
                          : selectedCameraViewPreset === 'custom'
                            ? cameraViews.length
                            : customCameraViewPreset.views.length;
                    return (
                      <button
                        key={option.id}
                        type="button"
                        role="tab"
                        aria-selected={selected}
                        className={`generate-camera-preset min-h-10 min-w-0 rounded-md px-1.5 py-1 text-[10px] font-semibold leading-3 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-liclick-pink/35 ${
                          selected
                            ? 'bg-white text-[#17131f] shadow-sm'
                            : 'bg-[#10101b] text-white/62 hover:bg-white/[0.065] hover:text-white'
                        }`}
                        onClick={() => handleCameraViewPresetSelect(option.id)}
                      >
                        <span className="block truncate">{option.title}</span>
                        <span
                          className={`mt-0.5 block truncate text-[9px] font-normal ${
                            selected ? 'text-[#17131f]/58' : 'text-white/38'
                          }`}
                        >
                          {viewCount} 视角
                        </span>
                      </button>
                    );
                  })}
                </div>
                <div className="grid grid-cols-3 gap-2 pb-1">
                  {cameraViews.map((view) => (
                    <div
                      key={view.id}
                      className="generate-camera-card-adaptive group relative min-w-0"
                    >
                      <button
                        type="button"
                        className="h-full w-full overflow-hidden rounded-lg bg-transparent"
                        onClick={() => handleCameraViewSelect(view)}
                        title={view.label}
                        aria-label={view.label}
                      >
                        <CameraViewThumbnail
                          preview={cameraViewPreviews[view.id]}
                          loading={capturingCameraViews.has(view.id)}
                        />
                      </button>
                      <button
                        type="button"
                        className="absolute right-1 top-1 grid h-6 w-6 place-items-center rounded-full bg-black/72 text-white/72 opacity-0 shadow transition hover:bg-red-500 hover:text-white group-hover:opacity-100 focus:opacity-100"
                        title={`删除${view.label}视角`}
                        aria-label={`删除${view.label}视角`}
                        onClick={() => handleDeleteCameraView(view.id)}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="generate-camera-card-adaptive group grid place-items-center overflow-hidden rounded-lg bg-[#303033] text-liclick-pink transition hover:bg-[#3a3a3e] focus:outline-none focus:ring-2 focus:ring-liclick-pink/30"
                    title={t('addCameraView')}
                    aria-label={t('addCameraView')}
                    onClick={handleAddCurrentCameraView}
                  >
                    <Plus className="h-7 w-7 transition-transform group-hover:scale-110" />
                  </button>
                </div>
              </section>
            )}

            <section className="order-3 grid shrink-0 gap-1.5 text-xs font-semibold text-white/82">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-white/88">
                  {isLocalRepaintTab
                    ? '补充提示词（可选）'
                    : textureViewMode === 'single' && singleViewProvider === 'remote'
                      ? '纹理提示词（可选）'
                      : '纹理提示词'}
                </span>
                {isLocalRepaintTab ? (
                  <span className="text-[11px] font-medium text-white/46">
                    生成时自动分析并优化
                  </span>
                ) : (
                  <button
                    type="button"
                    title="智能润色"
                    aria-label="智能润色"
                    data-prompt-polish="true"
                    disabled={promptPolishing || workflowConfigurationLocked || !prompt.trim()}
                    onClick={() => void handlePromptPolish()}
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-white/16 bg-white/6 text-white/76 transition hover:border-liclick-pink/55 hover:bg-liclick-pink/12 hover:text-white focus:outline-none focus:ring-2 focus:ring-liclick-pink/40 disabled:cursor-not-allowed disabled:opacity-35"
                  >
                    {promptPolishing ? (
                      <LoaderCircle className="h-4 w-4 animate-spin" />
                    ) : (
                      <Sparkles className="h-4 w-4" />
                    )}
                  </button>
                )}
              </div>
              <textarea
                value={prompt}
                aria-label={isLocalRepaintTab ? '补充提示词（可选）' : '纹理提示词'}
                readOnly={workflowConfigurationLocked}
                aria-readonly={workflowConfigurationLocked}
                maxLength={
                  isLocalRepaintTab ||
                  (isTextureMapTab &&
                    textureViewMode === 'single' &&
                    singleViewProvider === 'remote')
                    ? 4096
                    : undefined
                }
                placeholder={
                  isLocalRepaintTab
                    ? '可补充编辑要求；留空则自动分析蒙版区域问题'
                    : undefined
                }
                onChange={(event) => {
                  if (workflowConfigurationLocked) {
                    notifyWorkflowOperationLocked();
                    return;
                  }
                  if (isLocalRepaintTab) {
                    setLocalRepaintPrompt(event.target.value);
                    return;
                  }
                  updateGenerationSettings(
                    isTextureMapTab
                      ? { textureMapPrompt: event.target.value }
                      : { liclickPrompt: event.target.value },
                  );
                }}
                className={`generate-prompt-adaptive w-full resize-none rounded-md border border-white/18 bg-black/34 p-2.5 text-[13px] leading-5 text-white outline-none transition placeholder:text-white/38 focus:border-liclick-pink ${
                  workflowConfigurationLocked ? 'cursor-default' : ''
                }`}
              />
            </section>

            {(isTextureMapTab || isLocalRepaintTab) && (
              <section
                data-texture-onboarding="reference-images"
                data-onboarding-complete={activeSelectedReferenceIds.length > 0 ? 'true' : 'false'}
                className="order-2 grid shrink-0 gap-2"
              >
                <ReferenceGroupPicker
                  disabled={
                    workflowConfigurationLocked ||
                    displayedReferenceGroupGenerationState?.status === 'generating'
                  }
                  generationState={displayedReferenceGroupGenerationState}
                  onGenerateMultiview={(singleReference) =>
                    void handleGeneratePairedMultiview(singleReference)
                  }
                />
              </section>
            )}

            {generateNotice && (
              <div
                role={generateNotice.tone === 'error' ? 'alert' : 'status'}
                aria-live="polite"
                className={`order-4 shrink-0 rounded-md border px-2.5 py-2 text-xs leading-5 ${
                  generateNotice.tone === 'error'
                    ? 'border-rose-300/32 bg-rose-400/12 text-rose-50'
                    : generateNotice.tone === 'warning'
                      ? 'border-amber-300/32 bg-amber-400/12 text-amber-50'
                      : 'border-sky-300/28 bg-sky-400/12 text-sky-50'
                }`}
              >
                {generateNotice.message}
              </div>
            )}
          </div>
        </div>
      </Panel>
      {portalRoot &&
        generatePanelExpanded &&
        createPortal(
          <div
            className={`pointer-events-auto fixed bottom-4 left-4 z-[90] hidden overflow-hidden rounded-lg lg:block ${
              dockDensity === 'normal' ? 'w-[312px]' : 'w-[292px]'
            }`}
          >
            {generateAction}
          </div>,
          portalRoot,
        )}
      {portalRoot &&
        cancelTextureSnapshotConfirmOpen &&
        createPortal(
          <div
            data-task-preview-allowed="true"
            className="fixed inset-0 z-[140] grid place-items-center bg-black/62 px-4 backdrop-blur-sm"
          >
            <div className="w-full max-w-[420px] rounded-lg border border-white/16 bg-[#151520] p-4 text-white shadow-2xl">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-liclick-pink">终止多视图快照</div>
                  <div className="mt-1 text-lg font-bold">停止本次快照任务？</div>
                </div>
                <button
                  type="button"
                  className="grid h-8 w-8 place-items-center rounded-md text-white/70 transition hover:bg-white/10 hover:text-white"
                  onClick={() => setCancelTextureSnapshotConfirmOpen(false)}
                  aria-label={t('close')}
                  title={t('close')}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <p className="text-sm leading-6 text-white/72">
                当前快照会在正在处理的这一张结束后停止，已完成的临时快照将被丢弃，且不会继续向远端提交纹理生图任务。
              </p>
              <div className="mt-4 grid grid-cols-2 gap-2">
                <Button
                  variant="secondary"
                  className="h-10"
                  onClick={() => setCancelTextureSnapshotConfirmOpen(false)}
                >
                  继续等待
                </Button>
                <Button
                  variant="danger"
                  className="h-10"
                  disabled={texturePipelineCancelling}
                  onClick={confirmCancelTextureSnapshot}
                  icon={<Square className="h-4 w-4 fill-current" />}
                >
                  终止快照
                </Button>
              </div>
            </div>
          </div>,
          portalRoot,
        )}
      {portalRoot &&
        cancelConfirmGeneration &&
        createPortal(
          <div
            data-task-preview-allowed="true"
            className="fixed inset-0 z-[140] grid place-items-center bg-black/62 px-4 backdrop-blur-sm"
          >
            <div className="w-full max-w-[420px] rounded-lg border border-white/16 bg-[#151520] p-4 text-white shadow-2xl">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-liclick-pink">
                    {isTextureMapGeneration(cancelConfirmGeneration)
                      ? '终止纹理贴图生成'
                      : '终止莉刻生图'}
                  </div>
                  <div className="mt-1 text-lg font-bold">丢弃本次等待结果？</div>
                </div>
                <button
                  type="button"
                  className="grid h-8 w-8 place-items-center rounded-md text-white/70 transition hover:bg-white/10 hover:text-white"
                  onClick={() => setCancelConfirmGeneration(undefined)}
                  aria-label={t('close')}
                  title={t('close')}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <p className="text-sm leading-6 text-white/72">
                当前任务会立即从莉刻 3D Texture 面板中停止等待，生成结果不会写回预览、图层或项目。
                {cancelConfirmGeneration.metadata.provider === 'comfyui-local'
                  ? ' 同时会向本地 ComfyUI 发送中断请求。'
                  : cancelConfirmGeneration.metadata.provider === 'modelview-seedvr2' ||
                      cancelConfirmGeneration.metadata.provider === 'modelview-int8'
                    ? ' ModelView 接口没有取消端点，本地会断开当前等待。'
                    : ' 同时会向生图后端发送取消请求。'}
              </p>
              <div className="mt-4 grid grid-cols-2 gap-2">
                <Button
                  variant="secondary"
                  className="h-10"
                  onClick={() => setCancelConfirmGeneration(undefined)}
                >
                  继续等待
                </Button>
                <Button
                  variant="danger"
                  className="h-10"
                  onClick={confirmCancelCurrentGeneration}
                  icon={<Square className="h-4 w-4 fill-current" />}
                >
                  终止并丢弃
                </Button>
              </div>
            </div>
          </div>,
          portalRoot,
        )}
      {portalRoot &&
        previewImageOpen &&
        displayedPreviewGeneration?.resultUrl &&
        createPortal(
          <button
            type="button"
            className="fixed inset-0 z-[135] grid cursor-zoom-out place-items-center bg-black/72 p-4 backdrop-blur-sm"
            onClick={() => setPreviewImageOpen(false)}
            aria-label={t('close')}
          >
            <img
              src={previewResultUrl ?? displayedPreviewGeneration.resultUrl}
              alt=""
              className="max-h-[92vh] max-w-[94vw] rounded-md border border-white/16 bg-[#181818] object-contain shadow-2xl"
              style={checkerBackgroundStyle}
              draggable={false}
            />
          </button>,
          portalRoot,
        )}
    </>
  );
}
