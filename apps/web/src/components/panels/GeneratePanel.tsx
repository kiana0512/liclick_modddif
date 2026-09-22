import { captureLocalRepaintNormal } from '@/engine/localRepaint/captureLocalRepaintNormal';
import { GenerationServerStatus } from './GenerationServerStatus';
import { personalRepaintEnabled } from '@/services/personalRepaintMode';
import { sameGenerationRecovery } from '@/services/generationRecoveryComparison';
import {
  createTextureGenerationRecoveryOwnership,
  isRejectedTextureReturn,
  isTextureReturnQaFailure,
  textureReturnQaFailureMetadata,
} from '@/engine/generation/textureGenerationRecoveryOwnership';
import { isServerWorkspace } from '@/services/isServerWorkspace';
import { buildMultiviewPrompt } from '../../services/multiviewReferencePrompt';
import { usesCaptureMaskTextureProjection, preservesGeneratedSourceAlpha, textureProjectionIgnoresSourceAlpha } from '@/engine/generation/textureProjectionPolicy';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
  frameGenerationCapture,
  withStableClayTargetPresentation,
} from '@/engine/capture/captureCurrentView';
import { requestContentAwareRepair } from '@/engine/contentAware';
import {
  hasProjectionCommit,
  needsSingleViewAutoProjection,
  needsTextureCompletionCheckpoint,
  persistProjectionCommit,
  withProjectionCommit,
  type ProjectionSaveObserver,
} from '@/engine/generation/singleViewAutoProjection';
import {
  insertCameraViewByPreviewOrder,
} from '@/engine/generation/remoteMultiviewSequence';
import {
  createCaptureMaskedProjectionImage,
  createCaptureMaskedPreview,
  createGeneratedDisplayPreview,
} from '@/engine/localRepaint/resultPreviewUtils';
import { generationBelongsToObject } from '@/engine/localRepaint/objectBinding';
import { SINGLE_VIEW_MINIMUM_PROJECTION_FACING } from '@/engine/projection/projectionTypes';
import {
  prepareLocalRepaintGenerationInput,
  prepareSingleViewTextureCompletion,
  type PreparedSingleViewTextureCompletion,
} from '@/engine/localRepaint/generationInputWorker';
import {
  getObjectViewPresetDirection,
  setCameraToObjectDirection,
  type ObjectViewPreset,
} from '@/engine/scene/transformActions';
import { serializeCamera } from '@/engine/projection/ProjectionCamera';
import { ReferenceGroupPicker } from '@/components/panels/ReferenceGroupPicker';
import {
  referenceGroupId,
  latestPairedGenerations,
  replacePairedReference,
  type ReferenceGroupGenerationState,
} from '@/components/panels/referenceGroup';
import { devLogin } from '@/services/authApiClient';
import { isCloudBuild } from '@/platform/runtimeCapabilities';
import { runFeishuLoginFlow } from '@/services/feishuLoginFlow';
import { resolveLiclickAuthStrategy } from '@/services/liclickAuthStrategy';
import {
  createLiclickApiClient,
  restoreFramedJobResult,
  LiclickApiError,
  type GenerationJobListItem,
  type LiclickAspectRatio,
  type LiclickImageModel,
  type LiclickImageSize,
} from '@/services/liclickApiClient';
import { getUserFacingGenerationError, isGenerationCancellation, isRetryableGenerationPollError } from '@/services/generationErrorMessage';
import { resolveLocalRepaintMaterialReference } from '@/services/localRepaintMaterialReference';
import { resolveGptRepaintReference } from '@/engine/localRepaint/gptRepaintReference';
import {
  resolveLocalRepaintUserPrompt,
  LOCAL_REPAINT_PROMPT_TEMPLATE_POLICY,
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
import { useLayerStore } from '@/stores/layerStore';
import { IMMEDIATE_PROJECT_SAVE_EVENT, useProjectStore } from '@/stores/projectStore';
import { useReferenceStore } from '@/stores/referenceStore';
import { useSceneStore } from '@/stores/sceneStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useToastStore } from '@/stores/toastStore';
import type { Capture } from '@/types/capture';
import type {
  CaptureNormalPreview,
  CaptureResolution,
  SerializedCameraInput,
} from '@/engine/capture/captureTypes';
import type { Generation } from '@/types/generation';
import type { Layer } from '@/types/layer';
import type { ReferenceImage } from '@/types/project';
import { getRegisteredObjectUrlBlob, revokeRegisteredObjectUrl } from '@/utils/blobUrlRegistry';
import { createId } from '@/utils/id';
import { waitForBrowserPaint } from '@/utils/browserScheduling';
import { downloadImageAsset } from '@/utils/downloadImage';
import { generationBelongsToProject, generationIdentityIds, generationMetadataString } from '@/utils/generationIdentity';
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

import { resolveGptTextureModel, resolveGptTextureQuality, getGptTextureRequestParameters } from '@/engine/generation/gptTextureModels';
import { GptGenerationOptions } from '@/components/ui/GptGenerationOptions';
import { prepareCloudRepaintCompletion } from '@/engine/localRepaint/cloudCompletion';
import { prepareRepaintResult } from '@/engine/localRepaint/resultAlphaPolicy';
import { buildGptLocalRepaintRequest } from '@/services/gptLocalRepaintRequest';

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
type CameraViewPresetId = 'preset-2' | 'preset-3';
type CameraViewPresetSelection = CameraViewPresetId | 'custom';
type GptPairContext = {
  textureBatchId: string;
  scheduler: typeof import('@/engine/generation/gptMultiviewPairs');
};
type TextureViewBatchResult = {
  projected: number;
  layerIds: string[];
  qaRejected: number;
  error?: string;
};
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
    id: 'preset-3',
    label: '预设 1 · 9 视角（默认）',
    description: '8 个俯视 30° 环绕视角 + 底视角',
    views: ['front', 'front-left', 'left', 'back-left', 'back', 'back-right', 'right', 'front-right', 'bottom'],
  },
  {
    id: 'preset-2',
    label: '预设 2 · 14 视角',
    description:
      '14 个视角：前、后、左、右、上、下、前上、后上、左上、右上、前下、后下、左下、右下 45°',
    views: [
      'front',
      'left',
      'back',
      'right',
      'right-top',
      'front-top',
      'left-top',
      'back-top',
      'back-bottom',
      'left-bottom',
      'front-bottom',
      'right-bottom',
      'top',
      'bottom',
    ],
  },
];

const customCameraViewPreset = {
  views: ['front', 'left', 'back', 'right', 'top', 'bottom'] as ObjectViewPreset[],
};

const cameraViewPresetOptions: Array<{
  id: CameraViewPresetSelection;
  title: string;
}> = [
  { id: 'preset-3', title: '预设 1' },
  { id: 'preset-2', title: '预设 2' },
  { id: 'custom', title: '自定义预设' },
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
    return createPresetCameraViewItem(option, translate(option.labelKey), presetId === 'preset-3' ? 30 : 0);
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

function createPresetCameraViewItem(option: CameraViewOption, label: string, orbitElevation = 0): CameraViewItem {
  const viewDirection = getObjectViewPresetDirection(option.value, orbitElevation).toArray() as [
    number,
    number,
    number,
  ];
  return {
    id: orbitElevation ? `preset-3-${option.value}` : option.value,
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

function isVerboseGenerationNotice(message: string) {
  return /^第[一二]步：|本组回贴后再生成下一组|等待回贴与合成渲染完成/.test(message);
}

function compactTextureProgressButtonLabel(label: string) {
  if (/^第[一二]步：/.test(label)) return '生成多视图中';
  const pair = label.match(/第 \d+\/\d+ 组$/);
  return pair && /^(?:提交纹理任务|准备多视图快照|结果已保存)/.test(label)
    ? pair[0]
    : label;
}
const defaultImageGenerationSettings = {
  textureGptModel: 'gpt-image-2.5-sunburst',
  textureGptQuality: 'high',
  localRepaintProvider: 'modelview' as 'modelview' | 'gpt',
  localRepaintSmartPolish: false,
  gptRepaintUseMaterialReference: false,
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
    <span className="gen-preview-shell">
      {normalUrl ? (
        <img src={normalUrl} alt="" className="h-full w-full object-contain mix-blend-screen" />
      ) : (
        <span className="gen-preview-gradient" />
      )}
      {loading && (
        <span className="absolute inset-0 grid place-items-center bg-black/24">
          <span className="gen-preview-spinner" />
        </span>
      )}
    </span>
  );
}

const previewProgressOverlayClassName =
  'gen-preview-progress';

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
      {typeof generation.metadata.personalRepaintStage === 'string'
        ? generation.metadata.personalRepaintStage
        : submitted ? '后台正在处理，完成后会自动返回' : '正在检查参考图并提交任务'}
      <span className="ml-2 tabular-nums text-white/62">
        {minutes}:{seconds}
      </span>
      <GenerationServerStatus generation={generation} />
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

function hasVisibleTextureLayerCandidate(objectId: string) {
  return useLayerStore
    .getState()
    .layers.some(
      (layer) =>
        (!layer.objectId || layer.objectId === objectId) &&
        layer.type !== 'normal' &&
        layer.visible &&
        layer.opacity > 0 &&
        (layer.strength ?? 1) > 0 &&
        Boolean(layer.imageUrl),
    );
}


const multiviewGenerationFailureFallback = '多视图生成失败，请稍后重试。';



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

function generationRecencyTimestamp(generation: Generation) {
  const completedAt = generation.metadata.completedAt;
  const completedTimestamp = typeof completedAt === 'string' ? Date.parse(completedAt) : Number.NaN;
  const startedTimestamp = getGenerationStartedAt(generation);
  return Number.isFinite(completedTimestamp)
    ? completedTimestamp
    : Number.isFinite(startedTimestamp)
      ? startedTimestamp
      : Number.NEGATIVE_INFINITY;
}

function selectMostRecentGeneration(generations: Generation[]) {
  return generations.reduce<Generation | undefined>((latest, generation) => {
    if (!latest) return generation;
    return generationRecencyTimestamp(generation) > generationRecencyTimestamp(latest)
      ? generation
      : latest;
  }, undefined);
}

function isRunningGeneration(generation?: Generation) {
  return Boolean(
    generation &&
    !generation.resultUrl &&
    (generation.status === 'queued' || generation.status === 'running'),
  );
}

function throwIfTexturePipelineCancelled(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException('用户已终止多视图快照。', 'AbortError');
  }
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

function resolveRequestImageSize(imageSize: LiclickImageSize, aspectRatio: LiclickAspectRatio = 'auto') {
  return imageSize === 'auto' && aspectRatio !== 'auto' ? '1K' : imageSize;
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
  workspaceActive?: boolean;
  localImageGenerationRequestKey?: number;
  openLocalRepaintPanelRequestKey?: number;
  onRequestLocalImageGeneration?: () => void;
  onLocalImageGenerationSettled?: (result: LocalImageGenerationSettledResult) => void;
  cancelActiveGenerationRequestKey?: number;
  contentAwareRepairActive?: boolean;
  contentAwareRepairCancelling?: boolean;
  onCancelContentAwareRepair?: () => void;
  interactionLocked?: boolean;
  onInteractionLocked?: () => void;
  onTaskRunningChange?: (state: GeneratePanelTaskState) => void;
};

export type GeneratePanelTaskState = {
  running: boolean;
  snapshotPreparing: boolean;
  layerInputsPreparing?: boolean;
};

export type LocalImageGenerationSettledResult =
  | { succeeded: true; generationId: string }
  | { succeeded: false; generationId?: never };

export function GeneratePanel({
  workspaceActive = true,
  localImageGenerationRequestKey = 0,
  openLocalRepaintPanelRequestKey = 0,
  onRequestLocalImageGeneration,
  onLocalImageGenerationSettled,
  cancelActiveGenerationRequestKey = 0,
  contentAwareRepairActive = false,
  contentAwareRepairCancelling = false,
  onCancelContentAwareRepair,
  interactionLocked = false,
  onInteractionLocked,
  onTaskRunningChange,
}: GeneratePanelProps) {
  const t = useT();
  const [tab, setTab] = useState<GenerateTab>('multiview');
  const [textureViewMode, setTextureViewMode] = useState<TextureViewMode>('multi');
  // TEXTURE-PROVIDER-SWITCH/1.0.0: share selection across single/multiview tabs.
  const [singleViewProvider, setSingleViewProvider] = useState<SingleViewProvider>('gpt');
  const [normalBlackBackground, setNormalBlackBackground] = useState(false);
  const [texturePreviewMode, setTexturePreviewMode] = useState<TexturePreviewMode>('multi');
  useEffect(() => {
    if (!openLocalRepaintPanelRequestKey) return;
    setTab('repaint');
    setTexturePreviewMode('repaint');
  }, [openLocalRepaintPanelRequestKey]);
  const [localRepaintPrompt, setLocalRepaintPrompt] = useState('');
  const [promptPolishing, setPromptPolishing] = useState(false);
  const promptPolishRequestRef = useRef(0);
  const promptValueRef = useRef({ key: '', value: '' });
  const localRepaintResolvedPromptCacheRef = useRef(
    new Map<string, { prompt: string; source: 'user-request' | 'default-seam' | 'single-view-template' | 'geometry-normal-v1' | 'workflow-default' }>(),
  );
  const [previewImageOpen, setPreviewImageOpen] = useState(false);
  const [subjectFilledPreview, setSubjectFilledPreview] = useState<{
    sourceUrl: string;
    maskUrl?: string;
    depthUrl?: string;
    previewUrl: string;
  }>();
  const [selectedCameraViewPreset, setSelectedCameraViewPreset] =
    useState<CameraViewPresetSelection>('preset-3');
  const [cameraViews, setCameraViews] = useState<CameraViewItem[]>(() =>
    createCameraViewsForPreset('preset-3', t),
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
  const localRepaintPreparationAbortControllerRef = useRef<AbortController>();
  const lastCompletedLocalRepaintGenerationIdRef = useRef<string>();
  const handleLocalRepaintGenerateRef = useRef<() => Promise<boolean>>(async () => false);
  const pairProgressScopeRef = useRef<{ index: number; count: number }>();

  const updateTexturePipelineProgress = useCallback((progress: number, label: string) => {
    const pair = pairProgressScopeRef.current;
    if (pair) {
      progress =
        20 + (70 * (pair.index + Math.max(0, Math.min(1, (progress - 20) / 70)))) / pair.count;
      label = `${label} · 第 ${pair.index + 1}/${pair.count} 组`;
    }
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
  const [cancelLocalRepaintPreparationConfirmOpen, setCancelLocalRepaintPreparationConfirmOpen] =
    useState(false);
  const [cancelContentAwareRepairConfirmOpen, setCancelContentAwareRepairConfirmOpen] =
    useState(false);
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
  const textureGptModel = resolveGptTextureModel(generationSettings.textureGptModel);
  const textureGptQuality = resolveGptTextureQuality(generationSettings.textureGptQuality, textureGptModel);
  const isGptLocalRepaint = generationSettings.localRepaintProvider === 'gpt';
  const gptRepaintUseMaterialReference = generationSettings.gptRepaintUseMaterialReference === true;
  const localRepaintSmartPolish = !personalRepaintEnabled && generationSettings.localRepaintSmartPolish === true;
  const normalBackground = normalBlackBackground ? 'black' : 'blue';
  const imageModel = isTextureMapTab || (isLocalRepaintTab && isGptLocalRepaint)
    ? textureGptModel
    : (generationSettings.model as LiclickImageModel);
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
        generationMetadataString(generation, 'projectId');
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
  const textureRecoveryOwnershipRef = useRef(createTextureGenerationRecoveryOwnership());
  const cancelledGenerationIdsRef = useRef(new Set<string>());
  const cancelledTextureBatchIdsRef = useRef(new Set<string>());
  const generationPollFailureCountsRef = useRef(new Map<string, number>());
  const generationAbortControllersRef = useRef(new Map<string, AbortController>());
  const texturePipelineAbortControllerRef = useRef<AbortController>();
  const projectedLayerCommitQueueRef = useRef<Promise<void>>(Promise.resolve());
  const autoProjectionFailureNoticeRef = useRef(new Map<string, string>());
  const recoverSingleViewProjectionsRef = useRef<() => Promise<void>>();
  const wakeSingleViewProjectionsRef = useRef<() => void>();
  const criticalProjectSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pairedGenerationPersistenceRef = useRef(new Set<string>());
  const persistPairedMultiviewReferenceRef =
    useRef<(singleReference: ReferenceImage, generation: Generation) => Promise<ReferenceImage>>();
  const portalRoot = typeof document === 'undefined' ? undefined : document.body;
  const generateActionRef = useRef<HTMLDivElement>(null);
  const dockDensity = useWorkspaceLayoutStore((state) => state.dockDensity);
  const generatePanelExpanded = useWorkspaceLayoutStore(
    (state) =>
      state.mode === 'texture' &&
      state.panels.some((panel) => panel.id === 'generate' && !panel.collapsed && panel.visible),
  );
  useLayoutEffect(() => {
    const action = generateActionRef.current;
    if (!workspaceActive || !generatePanelExpanded || !portalRoot || !action) return;
    const property = '--generate-action-space';
    const previous = portalRoot.style.getPropertyValue(property);
    const measure = () => {
      // Keep the existing 12px clearance, including wrapped parameter/help text.
      const height = action.getBoundingClientRect().height;
      portalRoot.style.setProperty(property, `${height > 0 ? Math.ceil(height) + 12 : 76}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(action);
    return () => {
      observer.disconnect();
      if (previous) portalRoot.style.setProperty(property, previous);
      else portalRoot.style.removeProperty(property);
    };
  }, [workspaceActive, generatePanelExpanded, portalRoot]);
  const tabGenerations = generations.filter((generation) => {
    const projectId =
      generationMetadataString(generation, 'projectId');
    const belongsToProject = !currentProject?.id || !projectId || projectId === currentProject.id;
    return belongsToProject && generationMatchesTab(generation, tab);
  });
  const activeProjectGeneration = tabGenerations.find((generation) =>
    isRunningGeneration(generation),
  );
  const activeAnyProjectGeneration = generations.find((generation) => {
    const projectId =
      generationMetadataString(generation, 'projectId');
    const belongsToProject = !currentProject?.id || !projectId || projectId === currentProject.id;
    return belongsToProject && isRunningGeneration(generation);
  });
  const activeReferenceGeneration = generations.find((generation) => {
    const projectId =
      generationMetadataString(generation, 'projectId');
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
    onTaskRunningChange?.({
      running: panelTaskRunning,
      snapshotPreparing,
      layerInputsPreparing: Boolean(localRepaintPreparation),
    });
  }, [onTaskRunningChange, panelTaskRunning, snapshotPreparing, localRepaintPreparation]);

  useEffect(
    () => () => {
      onTaskRunningChange?.({ running: false, snapshotPreparing: false });
    },
    [onTaskRunningChange],
  );
  const latestTabGeneration = selectMostRecentGeneration(tabGenerations);
  const latestSingleViewTextureGeneration = selectMostRecentGeneration(
    tabGenerations.filter((generation) => generation.mode === 'single'),
  );
  const previewGeneration = activeProjectGeneration ?? latestTabGeneration ?? tabGenerations[0];
  const onboardingProjectionApplied = useLayerStore(state => state.layers.some(layer =>
    layer.generationId === previewGeneration?.id && Boolean(layer.generationId) && layer.visible && layer.opacity > 0));
  const previewIsGenerating = isRunningGeneration(previewGeneration);
  // A toolbar repaint request owns the synchronous submit lock before its
  // Generation row exists. Reflect that preparation window in the panel CTA
  // so the dock spinner and the left panel never disagree about task state.
  const textureActionProgress =
    isTextureMapTab && texturePipelineProgress?.active ? texturePipelineProgress : undefined;
  const generateActionRunning =
    previewIsGenerating ||
    Boolean(textureActionProgress) ||
    (tab === 'repaint' && submissionActive);
  const displayedPreviewGeneration =
    isTextureMapTab && texturePreviewMode === 'repaint'
      ? latestLocalRepaintGeneration
      : isTextureMapTab && texturePreviewMode === 'single' && !activeProjectGeneration
        ? latestSingleViewTextureGeneration
        : previewGeneration;
  const displayedPreviewIsGenerating = isRunningGeneration(displayedPreviewGeneration);
  const displayedPreviewFailed = displayedPreviewGeneration?.status === 'failed';
  const displayedPreviewCancelled = displayedPreviewGeneration?.metadata.cancelled === true;
  // GEN-PREVIEW-STATUS/1.0.0: one message owns the preview, including retries
  // that are preparing while the previous cancelled/failed row is still shown.
  const previewStatus = displayedPreviewIsGenerating
    ? 'running'
    : displayedTexturePreviewMode === 'repaint' && localRepaintPreparation
      ? 'preparing'
      : displayedPreviewFailed
        ? 'error'
        : 'idle';
  const localRepaintPreparationCancellable = Boolean(
    submissionActive &&
    localRepaintPreparationAbortControllerRef.current &&
    !localRepaintPreparationAbortControllerRef.current.signal.aborted,
  );
  const canCancelGeneration = Boolean(
    activeWorkflowGeneration ||
    localRepaintPreparationCancellable ||
    (contentAwareRepairActive && onCancelContentAwareRepair) ||
    (texturePipelineProgress?.active === true &&
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
      return;
    }
    if (localRepaintPreparationCancellable) {
      handledCancelActiveGenerationRequestKeyRef.current = cancelActiveGenerationRequestKey;
      setCancelLocalRepaintPreparationConfirmOpen(true);
      return;
    }
    if (contentAwareRepairActive && onCancelContentAwareRepair) {
      handledCancelActiveGenerationRequestKeyRef.current = cancelActiveGenerationRequestKey;
      setCancelContentAwareRepairConfirmOpen(true);
    }
  }, [
    activeWorkflowGeneration,
    cancelActiveGenerationRequestKey,
    contentAwareRepairActive,
    localRepaintPreparationCancellable,
    onCancelContentAwareRepair,
    snapshotPreparing,
  ]);
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
    ? preservesGeneratedSourceAlpha(displayedPreviewGeneration)
      ? 'source-alpha'
      : isLocalRepaintGeneration(displayedPreviewGeneration)
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

  const previewProcessingVisible =
    workspaceActive &&
    (previewImageOpen || (generatePanelExpanded && displayedTexturePreviewMode !== 'multi'));
  useEffect(() => {
    const sourceUrl = previewRawResultUrl;
    if (!previewProcessingVisible || !sourceUrl || !previewProcessingMode) {
      setSubjectFilledPreview(undefined);
      return undefined;
    }
    let cancelled = false;
    const controller = new AbortController();
    const previewRequest = { signal: controller.signal };
    const previewPromise =
      previewProcessingMode === 'capture-mask'
        ? createCaptureMaskedPreview(sourceUrl, capturePreviewMaskUrl!, previewRequest)
        : createGeneratedDisplayPreview(sourceUrl, previewProcessingDepthUrl, previewRequest, previewProcessingMode === 'source-alpha').then(
            (preview) => preview.fittedUrl,
          );
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
      controller.abort();
    };
  }, [
    capturePreviewMaskUrl,
    previewProcessingDepthUrl,
    previewProcessingMaskUrl,
    previewProcessingMode,
    previewProcessingVisible,
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

  // Normal completion owns its transaction. Also reconcile results restored by
  // either background poller (including reloads), without depending on the tab
  // or selected preview. Retry assets only, never resubmit a paid generation.
  useEffect(() => {
    if (!currentProjectId) return undefined;
    let disposed = false;
    let inFlight = false;
    let wakePending = false;
    let timeout: number | undefined;
    async function recover() {
      if (disposed) return;
      if (inFlight) {
        wakePending = true;
        return;
      }
      if (timeout !== undefined) window.clearTimeout(timeout);
      inFlight = true;
      try {
        await recoverSingleViewProjectionsRef.current?.();
      } finally {
        inFlight = false;
        if (!disposed) timeout = window.setTimeout(() => void recover(), wakePending ? 0 : 5000);
        wakePending = false;
      }
    }
    const wake = () => void recover();
    wakeSingleViewProjectionsRef.current = wake;
    void recover();
    window.addEventListener('online', recover);
    window.addEventListener('focus', recover);
    return () => {
      disposed = true;
      if (wakeSingleViewProjectionsRef.current === wake) wakeSingleViewProjectionsRef.current = undefined;
      if (timeout !== undefined) window.clearTimeout(timeout);
      window.removeEventListener('online', recover);
      window.removeEventListener('focus', recover);
    };
  }, [currentProjectId]);

  // New terminal results and the foreground pipeline releasing its lock should
  // not wait for the periodic retry tick. In-flight recovery remains deduped.
  useEffect(() => {
    wakeSingleViewProjectionsRef.current?.();
  }, [generations, workflowSubmissionLocked]);

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

    async function reconcileJob(job: GenerationJobListItem) {
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
      const recoveryIsCurrent = textureRecoveryOwnershipRef.current.backgroundTicket(
        recoveryProjectId, job.workflow ?? existing?.metadata.workflow,
      );
      if (
        !recoveryIsCurrent() ||
        isRejectedTextureReturn(projectGeneration?.metadata) ||
        isRejectedTextureReturn(storeGeneration?.metadata)
      )
        return { changed: false, needsPersist: false };
      // Foreground repaint owns clipping and completion; do not publish its raw result early.
      if (existing?.metadata.provider === 'liclick-atlas' && isLocalRepaintGeneration(existing) && generationAbortControllersRef.current.has(existing.id))
        return { changed: false, needsPersist: false };
      const fallback = storeGeneration ?? projectGeneration;
      const existingMetadata = {
        ...(projectGeneration?.metadata ?? {}),
        ...(storeGeneration?.metadata ?? {}),
      };
      const workspaceResultUrl = [projectGeneration?.resultUrl, storeGeneration?.resultUrl].find(
        (url): url is string => typeof url === 'string' && isWorkspaceAssetUrl(url),
      );
      let resultUrl =
        workspaceResultUrl ?? existing?.resultUrl ?? fallback?.resultUrl ?? job.resultUrl;
      if (!workspaceResultUrl && job.framing && resultUrl === job.resultUrl) {
        try {
          resultUrl = (await restoreFramedJobResult(job)).resultUrl;
        } catch (error) {
          if (cancelled || !recoveryIsCurrent()) return { changed: false, needsPersist: false };
          const qaFailure = textureReturnQaFailureMetadata(error);
          if (!qaFailure.returnQaRejected) throw error;
          const rejected = existing ?? {
            id: job.clientGenerationId ?? job.id,
            mode: 'single' as const,
            prompt: job.prompt,
            referenceIds: job.referenceIds,
            status: 'failed' as const,
            metadata: { projectId: recoveryProjectId, workflow: job.workflow, serverJobId: job.id },
          };
          syncGeneration(createFailedGeneration(rejected, getUserFacingGenerationError(error), qaFailure));
          return { changed: true, needsPersist: false };
        }
        if (cancelled || !recoveryIsCurrent()) return { changed: false, needsPersist: false };
      }
      const status = resultUrl ? ('succeeded' as const) : job.status;
      let generation: Generation = {
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
          generationFraming: job.framing ?? existingMetadata.generationFraming,
          framingRestored: job.framing && resultUrl ? true : existingMetadata.framingRestored,
          aspectRatio: job.params?.aspectRatio ?? existingMetadata.aspectRatio,
          imageSize: job.params?.imageSize ?? existingMetadata.imageSize,
          quality: job.params?.quality ?? existingMetadata.quality,
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
      generation = await prepareCloudRepaintCompletion(generation, liveProject?.captures ?? []);
      if (cancelled || !recoveryIsCurrent() || generationIdentityIds(generation).some((id) => cancelledGenerationIdsRef.current.has(id)))
        return { changed: false, needsPersist: false };
      const needsPersist =
        Boolean(generation.resultUrl) && !isWorkspaceAssetUrl(generation.resultUrl);
      if (
        sameGenerationRecovery(projectGeneration, generation) &&
        sameGenerationRecovery(storeGeneration, generation)
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
          let reconciliation;
          try {
            reconciliation = await reconcileJob(job);
          } catch (error) {
            if (cancelled) return;
            // A broken historical result must not starve other jobs' recovery.
            retry = isRetryableGenerationPollError(error) || retry;
            continue;
          }
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
        retry = retry || jobs.some((job) => job.status === 'running' || job.status === 'queued');
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
  }, [authStatus, currentProjectId, submissionActive, syncGeneration]);

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
      options: {
        setAsLastCapture?: boolean;
        resolution?: CaptureResolution;
        cameraSnapshot?: SerializedCameraInput;
      } = {},
    ) => {
      if (!captureObjectId) throw new Error(t('importModelFirst'));
      const capture = await captureCurrentView({
        objectId: captureObjectId,
        resolution: options.resolution ?? resolutionToSize[resolution],
        framing: 'fit-object',
        colorMode: 'clay-target',
        normalBackground: singleViewProvider === 'remote' ? normalBackground : undefined,
        cameraSnapshot: options.cameraSnapshot,
        // Leave a stable edge-safe frame for GPT/control-image upload. The
        // capture camera still keeps the preview direction and roll.
        fillRatio: 0.88,
        viewDirection: view?.viewDirection,
        viewUp: view?.viewUp,
      });
      if (options.setAsLastCapture !== false) setLastCapture(capture);
      return capture;
    },
    [captureObjectId, resolution, setLastCapture, t, singleViewProvider, normalBackground],
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
    const previewAbort = new AbortController();
    capturingCameraViewsRef.current = new Set([
      ...capturingCameraViewsRef.current,
      ...missingViews.map((view) => view.id),
    ]);
    const publishPending = () => setCapturingCameraViews(new Set(capturingCameraViewsRef.current));
    const clearPending = () => {
      missingViews.forEach((view) => capturingCameraViewsRef.current.delete(view.id));
      publishPending();
    };
    publishPending();

    async function captureMissingViews() {
      try {
        for (const view of missingViews) {
          if (cancelled) return;
          const preview = await captureCurrentNormalPreview({
            signal: previewAbort.signal,
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
          setCameraViewPreviews(cameraViewPreviewsRef.current);
          capturingCameraViewsRef.current.delete(view.id);
          publishPending();
        }
      } catch (error) {
        if (!cancelled) {
          console.warn('[Capture] Normal preview failed:', error);
          const message = error instanceof Error ? error.message : '无法生成多视图法线预览。';
          setGenerateNotice({
            tone: 'warning',
            message,
          });
          pushToast({
            tone: 'warning',
            title: '多视图预览生成失败',
            description: message,
            dedupeKey: 'multiview-preview-failed',
          });
        }
      } finally {
        if (!cancelled) clearPending();
      }
    }

    const previewTimer = setTimeout(() => void captureMissingViews(), 180);
    return () => {
      cancelled = true;
      clearTimeout(previewTimer);
      previewAbort.abort();
      clearPending();
    };
  }, [cameraViews, captureObjectId, isTextureMapTab, pushToast, setGenerateNotice, viewport]);

  useEffect(() => {
    const generationToPoll = activeReferenceGeneration ?? previewGeneration;
    if (!generationToPoll || generationToPoll.resultUrl) return undefined;
    const recoveryIsCurrent = textureRecoveryOwnershipRef.current.backgroundTicket(
      generationMetadataString(generationToPoll, 'projectId') ?? currentProjectId,
      generationToPoll.metadata.workflow,
    );
    if (isRejectedTextureReturn(generationToPoll.metadata)) return undefined;
    if (generationToPoll.status !== 'queued' && generationToPoll.status !== 'running')
      return undefined;
    if (cancelledGenerationIdsRef.current.has(generationToPoll.id)) return undefined;
    if (generationToPoll.metadata.provider === 'liclick-atlas' && isLocalRepaintGeneration(generationToPoll) && generationAbortControllersRef.current.has(generationToPoll.id))
      return undefined;
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
    // Keep the pre-submission watchdog; only the result polling/QA is owned
    // by the foreground sequence once the server has accepted the job.
    if (!recoveryIsCurrent()) return undefined;
    const taskId =
      generationMetadataString(generationToPoll, 'taskId');
    const clientGenerationId =
      generationMetadataString(generationToPoll, 'clientGenerationId');
    const serverJobId =
      generationMetadataString(generationToPoll, 'serverJobId');
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
      if (!recoveryIsCurrent()) return;
      const controller = new AbortController();
      requestAbortController = controller;
      try {
        const result = await client.getGenerationJob(jobId, { signal: controller.signal });
        if (cancelled || controller.signal.aborted || !recoveryIsCurrent()) return;
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
          const restored = await prepareCloudRepaintCompletion(generation,
            useProjectStore.getState().projects.find((project) => project.id === generation.metadata.projectId)?.captures ?? [],
            controller.signal);
          if (cancelled || controller.signal.aborted || !recoveryIsCurrent()) return;
          syncGeneration(restored);
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
        if (cancelled || controller.signal.aborted || !recoveryIsCurrent()) return;
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
        if (!isRetryableGenerationPollError(error)) {
          clearPollRetryFeedback();
          markGenerationFailed(
            generationToPoll, getUserFacingGenerationError(error), textureReturnQaFailureMetadata(error),
          );
          return;
        }
        const failureCount = (generationPollFailureCountsRef.current.get(jobId) ?? 0) + 1;
        generationPollFailureCountsRef.current.set(jobId, failureCount);
        if (failureCount >= 2) {
          const retryMessage = '与生成服务的连接暂时不稳定，后台任务没有丢失，正在自动重试。';
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
    currentProjectId,
    submissionActive,
    dismissToastByDedupeKey,
    failUnsubmittedGeneration,
    markGenerationFailed,
    previewGeneration,
    pushToast,
    setGenerateNotice,
    syncGeneration,
  ]);

  useEffect(() => {
    const completedReferenceGeneration = latestPairedGenerations(generations, currentProject?.id).find((generation) => {
      if (
        generation.status !== 'succeeded' ||
        !generation.resultUrl ||
        generation.metadata.referenceBindingApplied
      ) {
        return false;
      }
      const sourceReferenceId =
        generationMetadataString(generation, 'sourceReferenceId');
      return (
        Boolean(
          sourceReferenceId &&
          references.some(
            (reference) => reference.id === sourceReferenceId &&
              (!isMultiviewReference(reference) || generation.metadata.referenceOperation === 'lighting'),
          ),
        ) &&
        !references.some((reference) => reference.generationId === generation.id) &&
        !pairedGenerationPersistenceRef.current.has(generation.id)
      );
    });
    if (!completedReferenceGeneration) return;
    const sourceReferenceId =
      generationMetadataString(completedReferenceGeneration, 'sourceReferenceId');
    const sourceReference = references.find(
      (reference) => reference.id === sourceReferenceId &&
        (!isMultiviewReference(reference) || completedReferenceGeneration.metadata.referenceOperation === 'lighting'),
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
        if (isGenerationCancellation(error)) return;
        const message = getUserFacingGenerationError(error, '多视图结果写回失败，请重试。');
        setReferenceGroupGenerationState({
          groupId: referenceGroupId(sourceReference),
          status: 'failed',
          error: message,
        });
      });
  }, [currentProject?.id, generations, pushToast, references]);

  function updateGenerationSettings(patch: Partial<typeof defaultImageGenerationSettings>) {
    // This writer only updates the next-request prompt draft, not the running request snapshot.
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
        modelName: singleViewProvider === 'remote' ? '远端纹理模型' : imageModel,
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
    if (selection === selectedCameraViewPreset) return;
    if (workflowConfigurationLocked) {
      notifyWorkflowOperationLocked();
      return;
    }
    const nextViews =
      selection === 'custom'
        ? createCameraViewsFromValues(customCameraViewPreset.views, t)
        : createCameraViewsForPreset(selection, t);
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
    setCameraViews((current) => insertCameraViewByPreviewOrder(current, nextView));
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
      generationMetadataString(generation, 'taskId');
    const serverJobId =
      generationMetadataString(generation, 'serverJobId');
    const clientGenerationId =
      generationMetadataString(generation, 'clientGenerationId');
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
    if (generationToCancel) {
      setCancelConfirmGeneration(generationToCancel);
      return;
    }
    if (localRepaintPreparationCancellable) {
      setCancelLocalRepaintPreparationConfirmOpen(true);
      return;
    }
    if (contentAwareRepairActive && onCancelContentAwareRepair) {
      setCancelContentAwareRepairConfirmOpen(true);
    }
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

  function confirmCancelLocalRepaintPreparation() {
    const controller = localRepaintPreparationAbortControllerRef.current;
    setCancelLocalRepaintPreparationConfirmOpen(false);
    if (!controller || controller.signal.aborted) return;
    setGenerateNotice({ tone: 'info', message: '正在终止局部生图准备。' });
    controller.abort('user-cancelled-local-repaint-preparation');
  }

  function confirmCancelContentAwareRepair() {
    setCancelContentAwareRepairConfirmOpen(false);
    onCancelContentAwareRepair?.();
  }

  function confirmCancelCurrentGeneration() {
    const generationToCancel = cancelConfirmGeneration ?? activeWorkflowGeneration;
    if (!generationToCancel) return;
    setCancelConfirmGeneration(undefined);
    if (!isRunningGeneration(generationToCancel)) return;
    const isTextureMap = isTextureMapGeneration(generationToCancel);
    const isLocalRepaint = isLocalRepaintGeneration(generationToCancel);
    const textureBatchId =
      generationMetadataString(generationToCancel, 'textureBatchId');
    if (textureBatchId) cancelledTextureBatchIdsRef.current.add(textureBatchId);
    if (isTextureMap) {
      const pipelineController = texturePipelineAbortControllerRef.current;
      if (pipelineController && !pipelineController.signal.aborted) {
        pipelineController.abort('user-cancelled-texture-generation');
      }
    }

    const liveGenerations = useGenerationStore.getState().generations;
    const generationsToCancel =
      isTextureMap || isLocalRepaint
        ? liveGenerations.filter((generation) => {
            if (!isRunningGeneration(generation)) return false;
            if (isTextureMap && !isTextureMapGeneration(generation)) return false;
            if (isLocalRepaint && !isLocalRepaintGeneration(generation)) return false;
            const generationProjectId =
              generationMetadataString(generation, 'projectId');
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
        generation.metadata.provider === 'modelview-single-view' ||
        generation.metadata.provider === 'modelview-single-view-inpaint'
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

  async function getTextureMapMultiviewCaptures(
    views: CameraViewItem[],
    signal?: AbortSignal,
    options: { cameraSnapshot?: SerializedCameraInput; viewSnapshots?: Map<string, SerializedCameraInput>; reportProgress?: boolean } = {},
  ) {
    if (!captureObjectId) throw new Error(t('importModelFirst'));
    const viewSnapshots = options.viewSnapshots ?? new Map<string, SerializedCameraInput>();
    for (const view of views) {
      throwIfTexturePipelineCancelled(signal);
      if (!viewSnapshots.has(view.id)) viewSnapshots.set(view.id, options.cameraSnapshot ??
        await frameGenerationCapture(captureObjectId, 1, view.viewDirection, view.viewUp, signal, false,
          singleViewProvider === 'remote' ? 0.92 : 0.98));
    }
    return withStableClayTargetPresentation(captureObjectId, async () => {
      const captures: Partial<Record<string, Capture>> = {};
      for (let index = 0; index < views.length; index += 1) {
        throwIfTexturePipelineCancelled(signal);
        const view = views[index];
        if (!view) continue;
        if (captures[view.id]) continue;
        setCapturingCameraViews((current) => new Set([...current, view.id]));
        try {
          const capture = await captureTextureMapCameraView(view, {
            setAsLastCapture: false,
            cameraSnapshot: viewSnapshots.get(view.id),
          });
          throwIfTexturePipelineCancelled(signal);
          captures[view.id] = capture;
          if (options.reportProgress !== false) updateTexturePipelineProgress(
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
          cameraSnapshot: viewSnapshots.get(view.id),
        }))
        .filter(
          (
            item,
          ): item is {
            viewId: string;
            cameraView: ObjectViewPreset | 'custom';
            label: string;
            capture: Capture;
            cameraSnapshot: SerializedCameraInput | undefined;
          } => Boolean(item.capture),
        );
    });
  }

  async function waitForLiclickGeneration(generation: Generation, onMessage?: (label: string) => void) {
    if (generation.resultUrl) return generation;
    const client = createLiclickApiClient();
    const jobId = getGenerationJobId(generation);
    let transientFailures = 0;
    let nextLongWaitNoticeAt = Date.now() + 30 * 60 * 1000;
    for (;;) {
      if (isCancelledGeneration(generation)) throw new Error('用户已终止纹理贴图生成任务。');
      let result: Awaited<ReturnType<typeof client.getGenerationJob>>;
      try {
        result = await client.getGenerationJob(jobId);
        transientFailures = 0;
      } catch (error) {
        if (isCancelledGeneration(generation)) throw new Error('用户已终止纹理贴图生成任务。');
        const message = error instanceof Error ? error.message : String(error);
        if (/Generation job not found|生成任务已失效|没有找到.*任务/i.test(message)) throw error;
        if (!isRetryableGenerationPollError(error)) throw error;
        transientFailures += 1;
        if (transientFailures >= 2) {
          setGenerateNotice({
            tone: 'warning',
            message: '生图服务连接暂时不可用，远端任务不会判定失败，正在自动重连。',
          });
        }
        await new Promise((resolve) => window.setTimeout(resolve, 3500));
        continue;
      }
      if (result.message) onMessage?.(result.message);
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
            extraParams: result.extraParams ?? generation.metadata.extraParams,
            completedAt: result.updatedAt ?? new Date().toISOString(),
          },
        };
      }
      if (Date.now() >= nextLongWaitNoticeAt) {
        setGenerateNotice({
          tone: 'warning',
          message: '远端仍在处理本组生图，任务保持运行并会继续等待，不会因页面切换判定失败。',
        });
        nextLongWaitNoticeAt = Date.now() + 30 * 60 * 1000;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 3500));
    }
  }

  function submitGptTextureView(
    generationId: string,
    submittedPrompt: string,
    modelViewReference: ReferenceImage,
    materialReference: ReferenceImage,
    capture: Capture,
  ) {
    const referenceImages = [modelViewReference, materialReference];
    const requestParameters = getGptTextureRequestParameters(resolution, textureGptQuality, textureGptModel);
    return createLiclickApiClient().generateTextureSingleView({
      clientGenerationId: generationId,
      projectId: currentProject?.id,
      workflow: 'texture-map',
      mode: 'single',
      prompt: submittedPrompt,
      referenceIds: referenceImages.map((reference) => reference.id),
      referenceImages,
      capture,
      object: objects.find((item) => item.id === capture.objectId),
      resolution,
      textureMode: 'realistic',
      visibleOnly: true,
      upscale: false,
      model: imageModel,
      ...requestParameters,
    });
  }

  async function markSilhouetteRetryFailed(
    generation: Generation,
    error: unknown,
  ): Promise<never> {
    const retryPolicy = await import('@/engine/generation/gptReturnSilhouetteRetry');
    const failure = retryPolicy.isGptReturnSilhouetteMismatch(error)
      ? retryPolicy.terminalSilhouetteRetryError()
      : error instanceof Error
        ? error
        : new Error(String(error));
    syncGeneration(createFailedGeneration(
      generation, failure.message, textureReturnQaFailureMetadata(error),
    ));
    await saveGenerationStateBestEffort();
    throw failure;
  }

  async function submitSilhouetteAlignmentRetry(
    failedGeneration: Generation,
    failure: unknown,
    modelViewReference: ReferenceImage,
    materialReference: ReferenceImage,
    capture: Capture,
    signal?: AbortSignal,
  ): Promise<Generation> {
    const retryPolicy = await import('@/engine/generation/gptReturnSilhouetteRetry');
    if (!retryPolicy.isGptReturnSilhouetteMismatch(failure)) throw failure;
    if (
      retryPolicy.silhouetteRetryAttempt(failedGeneration.metadata) >=
      retryPolicy.GPT_SILHOUETTE_RETRY_LIMIT
    ) {
      return markSilhouetteRetryFailed(failedGeneration, failure);
    }
    throwIfTexturePipelineCancelled(signal);
    const { generation: retryPending, viewLabel } =
      retryPolicy.createTextureMapSilhouetteRetry(failedGeneration);
    const retryId = retryPending.id;
    const retryPrompt = retryPending.prompt;
    syncGeneration(
      createFailedGeneration(failedGeneration, retryPolicy.SILHOUETTE_RETRY_FAILURE_MESSAGE, {
        silhouetteRetryGenerationId: retryId,
        ...textureReturnQaFailureMetadata(failure),
      }),
    );
    start(retryPending);
    addProjectGeneration(retryPending);
    setGenerateNotice({
      tone: 'warning',
      message: `${viewLabel} 远端回图发生构图漂移，正在使用同一冻结视角自动重试一次。`,
    });
    await saveGenerationStateBestEffort();
    throwIfTexturePipelineCancelled(signal);
    try {
      const submitted = await submitGptTextureView(
        retryId,
        retryPrompt,
        modelViewReference,
        materialReference,
        capture,
      );
      const aligned: Generation = {
        ...retryPending,
        ...submitted,
        metadata: {
          ...mergeGenerationMetadataPreservingStartedAt(retryPending.metadata, submitted.metadata),
          serverSubmitted: true,
          serverJobId: submitted.metadata.serverJobId ?? submitted.id,
          silhouetteRetryOf: failedGeneration.id,
          silhouetteRetryAttempt: 1,
        },
      };
      syncGeneration(aligned);
      return aligned;
    } catch (error) {
      return markSilhouetteRetryFailed(retryPending, error);
    }
  }

  async function submitGptTextureViewWithSilhouetteRetry(
    pendingGeneration: Generation,
    modelViewReference: ReferenceImage,
    materialReference: ReferenceImage,
    capture: Capture,
    signal?: AbortSignal,
  ): Promise<Generation> {
    try {
      return await submitGptTextureView(
        pendingGeneration.id,
        pendingGeneration.prompt,
        modelViewReference,
        materialReference,
        capture,
      );
    } catch (error) {
      return submitSilhouetteAlignmentRetry(
        pendingGeneration,
        error,
        modelViewReference,
        materialReference,
        capture,
        signal,
      );
    }
  }

  async function waitForGptTextureGenerationWithSilhouetteRetry(
    generation: Generation,
    modelViewReference: ReferenceImage,
    materialReference: ReferenceImage,
    capture: Capture,
    signal?: AbortSignal,
  ): Promise<Generation> {
    try {
      return await waitForLiclickGeneration(generation);
    } catch (error) {
      const retry = await submitSilhouetteAlignmentRetry(
        generation,
        error,
        modelViewReference,
        materialReference,
        capture,
        signal,
      );
      try {
        return await waitForLiclickGeneration(retry);
      } catch (retryError) {
        return markSilhouetteRetryFailed(retry, retryError);
      }
    }
  }

  async function handleRemoteSequentialMultiviewGenerate(
    materialReference: ReferenceImage,
    requestedViews: CameraViewItem[],
    signal?: AbortSignal,
  ) {
    if (!captureObjectId) throw new Error(t('importModelFirst'));
    if (!currentProject) throw new Error('当前工程尚未加载完成。');
    const objectId = captureObjectId;
    // The preview array is the execution contract. Do not reorder it from the
    // active tile, otherwise the visible thumbnail order and progress diverge.
    const orderedViews = [...requestedViews];
    const viewCount = orderedViews.length;
    const remoteFailureMessage = '多视图失败，请重试。';
    const viewport = useSceneStore.getState().viewport;
    if (!viewport) throw new Error(t('viewportUnavailable'));
    const viewportTarget = viewport.controls?.target.clone();
    const cameraWithAspect = viewport.camera as unknown as { aspect?: number };
    const viewportAspect =
      typeof cameraWithAspect.aspect === 'number' ? cameraWithAspect.aspect : 1;
    const originalCamera = serializeCamera(
      viewport.camera,
      viewportAspect,
      viewportTarget ?? viewport.camera.position.clone().set(0, 0, 0),
    );
    const originalActiveViewId = activeCameraViewId;
    const textureBatchId = createId('remote-multiview-batch');
    const textureBatchWasCancelled = () => cancelledTextureBatchIdsRef.current.has(textureBatchId);
    const { createModelviewApiClient } = await import('@/services/modelviewApiClient');
    const presentation = await import('@/engine/generation/gptMultiviewPairs');
    const modelviewClient = createModelviewApiClient();
    let projectedGenerationCount = 0;
    let skippedViewCount = 0;

    try {
      // ALG-GEN-006 v1.2.0: prepare only the next view after the previous
      // result is presented. Persist its complete capture before remote submission.
      const materialDataUrl = await urlToDataUrl(materialReference.url);

      for (let index = 0; index < viewCount; index += 1) {
        throwIfTexturePipelineCancelled(signal);
        if (textureBatchWasCancelled()) throw new Error('用户已终止纹理贴图生成任务。');
        const view = orderedViews[index];
        if (!view) throw new Error(remoteFailureMessage);
        const stepLabel = `${index + 1}/${viewCount}`;

        setActiveCameraViewId(view.id);
        setCameraToObjectDirection(objectId, view.viewDirection, view.viewUp);
        updateTexturePipelineProgress(
          20 + (index / viewCount) * 70,
          `准备多视图快照 · ${stepLabel} ${view.label}`,
        );
        await waitForBrowserPaint();
        await waitForBrowserPaint();
        throwIfTexturePipelineCancelled(signal);

        const cameraSnapshot = await frameGenerationCapture(
          objectId, 1, view.viewDirection, view.viewUp, signal, false, 0.92,
        );
        const objectMatrixWorld = getImportedModelMatrixWorld(objectId);
        // Freeze authored colour before the clay capture temporarily replaces
        // resident materials; clearing the override does not restore them synchronously.
        const hasExistingTexture = hasVisibleTextureLayerCandidate(objectId);
        const currentEffect = hasExistingTexture ? await captureCurrentColorPreview({
          objectId,
          resolution: resolutionToSize[resolution],
          framing: 'fit-object',
          colorMode: 'flat-target-coverage',
          fillRatio: 0.88,
          cameraSnapshot,
          viewDirection: view.viewDirection,
          viewUp: view.viewUp,
        }) : undefined;
        throwIfTexturePipelineCancelled(signal);
        const [capturedView] = await getTextureMapMultiviewCaptures([view], signal, {
          cameraSnapshot, reportProgress: false,
        });
        if (!capturedView) throw new Error(remoteFailureMessage);
        throwIfTexturePipelineCancelled(signal);
        let generationCapture = capturedView.capture;
        let completion: PreparedSingleViewTextureCompletion | undefined;
        let usesInpaint = false;
        {
          completion = await prepareSingleViewTextureCompletion({
            currentEffectUrl: currentEffect?.colorUrl ?? capturedView.capture.colorUrl,
            clayPreviewUrl: capturedView.capture.colorUrl,
            objectMaskUrl: capturedView.capture.maskUrl,
            whiteFill: true,
            fullObject: !hasExistingTexture,
          });
          if (completion.hasVisibleTexture && completion.uncoveredPixelCount === 0) {
            skippedViewCount += 1;
            updateTexturePipelineProgress(
              20 + ((index + 1) / viewCount) * 70,
              `远端多视图 ${stepLabel} · 已跳过`,
            );
            continue;
          }
          {
            if (!completion.imageUrl || !completion.completionMaskUrl) {
              throw new Error(remoteFailureMessage);
            }
            usesInpaint = completion.hasVisibleTexture;
            generationCapture = { ...capturedView.capture, colorUrl: completion.imageUrl };
            const currentCaptures = useProjectStore.getState().projects
              .find((project) => project.id === currentProject.id)?.captures ?? currentProject.captures;
            const persistedCaptures = await persistCaptureAssets(
              [
                generationCapture,
                ...currentCaptures.filter((capture) => capture.id !== generationCapture.id),
              ],
              currentProject.id,
            );
            throwIfTexturePipelineCancelled(signal);
            updateProjectById(currentProject.id, { captures: persistedCaptures });
            generationCapture =
              persistedCaptures.find((capture) => capture.id === generationCapture.id) ??
              generationCapture;
            await saveCriticalProjectState({ captures: persistedCaptures });
            throwIfTexturePipelineCancelled(signal);
          }
        }

        const generationId = createId(`remote-multiview-${view.id}`);
        const modelViewReferenceId = `${generationCapture.id}-model-view-${view.id}`;
        const commonMetadata: Generation['metadata'] = {
          provider: usesInpaint
              ? 'modelview-single-view-inpaint'
              : 'modelview-single-view',
          workflow: 'texture-map',
          textureBatchId,
          clientGenerationId: generationId,
          projectId: currentProject.id,
          objectId,
          objectMatrixWorld,
          materialReferenceId: materialReference.id,
          modelViewReferenceId,
          multiview: false,
          singleViewProvider: 'remote',
          sourceComposition: 'flat-white-mask-v1',
          autoProjectExpected: true,
          cameraView: capturedView.cameraView,
          cameraViewId: view.id,
          cameraViewLabel: view.label,
          resolution,
          serverSubmitted: false,
          startedAt: new Date().toISOString(),
          alphaMode: 'pending-guided-foreground-matte',
        };
        const pendingGeneration: Generation = {
          id: generationId,
          mode: 'single',
          prompt: '',
          referenceIds: [modelViewReferenceId, materialReference.id],
          captureId: generationCapture.id,
          status: 'running',
          metadata: commonMetadata,
        };
        start(pendingGeneration);
        addProjectGeneration(pendingGeneration);
        await saveGenerationStateBestEffort();
        updateTexturePipelineProgress(
          20 + ((index + 0.3) / viewCount) * 70,
          `远端多视图 ${stepLabel} · 生成${view.label}`,
        );

        try {
          let remoteGeneration: Generation;
          {
            if (!generationCapture.normalUrl) {
              throw new Error('当前视角法线图不可用，请重新捕获后重试。');
            }
            const [imageDataUrl, normalDataUrl] = await Promise.all([
              urlToDataUrl(generationCapture.colorUrl),
              urlToDataUrl(generationCapture.normalUrl),
            ]);
            const completionMaskDataUrl =
              usesInpaint && completion?.completionMaskUrl
                ? await urlToDataUrl(completion.completionMaskUrl)
                : undefined;
            throwIfTexturePipelineCancelled(signal);
            remoteGeneration = usesInpaint
              ? await modelviewClient.generateSingleViewInpaint(
                  {
                    clientGenerationId: generationId,
                    projectId: currentProject.id,
                    captureId: generationCapture.id,
                    objectId,
                    normalImage: {
                      path: `${generationCapture.id}-normal.png`,
                      dataUrl: normalDataUrl,
                    },
                    image: {
                      path: `${generationCapture.id}-current-effect.png`,
                      dataUrl: imageDataUrl,
                    },
                    materialImage: {
                      path: `${materialReference.id}-multiview-material.png`,
                      dataUrl: materialDataUrl,
                    },
                    mask: {
                      path: `${generationCapture.id}-completion-mask.png`,
                      dataUrl: completionMaskDataUrl!,
                    },
                    materialReferenceId: materialReference.id,
                    materialReferenceGroupId: referenceGroupId(materialReference),
                    materialReferenceName: materialReference.name,
                    materialReferenceRole: materialReference.referenceRole,
                    modelViewReferenceId,
                  },
                  { signal },
                )
              : await modelviewClient.generateSingleView(
                  {
                    clientGenerationId: generationId,
                    projectId: currentProject.id,
                    captureId: generationCapture.id,
                    objectId,
                    normalImage: {
                      path: `${generationCapture.id}-normal.png`,
                      dataUrl: normalDataUrl,
                    },
                    image: {
                      path: `${generationCapture.id}-white-model.png`,
                      dataUrl: imageDataUrl,
                    },
                    materialImage: {
                      path: `${materialReference.id}-multiview-material.png`,
                      dataUrl: materialDataUrl,
                    },
                    materialReferenceId: materialReference.id,
                    materialReferenceGroupId: referenceGroupId(materialReference),
                    materialReferenceName: materialReference.name,
                    materialReferenceRole: materialReference.referenceRole,
                    modelViewReferenceId,
                  },
                  { signal },
                );
          }
          if (!remoteGeneration.resultUrl || remoteGeneration.status !== 'succeeded') {
            throw new Error(remoteFailureMessage);
          }
          const completed: Generation = {
            ...remoteGeneration,
            mode: 'single',
            metadata: {
              ...mergeGenerationMetadataPreservingStartedAt(
                commonMetadata,
                remoteGeneration.metadata,
              ),
              serverSubmitted: true,
              completedAt: new Date().toISOString(),
            },
          };
          syncGeneration(completed);
          updateTexturePipelineProgress(
            20 + ((index + 0.8) / viewCount) * 70,
            `远端多视图 ${stepLabel} · 回贴${view.label}`,
          );
          const projectedLayer = await addGenerationAsProjectedLayer(completed, {
            automatic: true,
            capture: generationCapture,
          });
          if (!projectedLayer) throw new Error(remoteFailureMessage);
          // A reused UV material updates in place without another resident event.
          // Check this result's actual bindings, including already-presented results.
          await presentation.waitForProjectedLayerPresentation(
            () => presentation.hasResidentProjectedLayers(
              useSceneStore.getState().importedModels.find((model) => model.objectId === objectId)?.group,
              [projectedLayer.id],
            ),
            () => throwIfTexturePipelineCancelled(signal),
            waitForBrowserPaint,
            60_000,
            () => {
              updateTexturePipelineProgress(
                20 + ((index + 0.8) / viewCount) * 70,
                `结果已保存 · 等待${view.label}回贴渲染`,
              );
              setGenerateNotice({
                tone: 'warning',
                message: `${view.label} 生图结果已保存，正在等待回贴与合成渲染完成；完成后自动继续。`,
              });
            },
          );
          syncGeneration({
            ...completed,
            metadata: {
              ...completed.metadata,
              projectedLayerId: projectedLayer.id,
              projectionCommittedAt: new Date().toISOString(),
            },
          });
          projectedGenerationCount += 1;
          await saveGenerationStateBestEffort();
          updateTexturePipelineProgress(
            20 + ((index + 1) / viewCount) * 70,
            `远端多视图 ${stepLabel} · 完成`,
          );
        } catch (error) {
          if (!isGenerationCancellation(error, signal) && !textureBatchWasCancelled()) {
            syncGeneration(
              createFailedGeneration(
                pendingGeneration,
                error instanceof Error ? error.message : remoteFailureMessage,
              ),
            );
            await saveGenerationStateBestEffort();
          }
          throw error;
        }
      }

      if (projectedGenerationCount > 0) {
        updateTexturePipelineProgress(92, '内容识别补缝');
        try {
          await requestContentAwareRepair({
            source: 'multiview-texture',
            projectId: currentProject.id,
            objectId,
            batchId: textureBatchId,
            silentForeground: true,
          });
          updateTexturePipelineProgress(100, '远端多视图完成');
        } catch (error) {
          updateTexturePipelineProgress(100, '纹理完成，补缝未完成');
          console.warn('[Li3D] Remote multiview repair failed:', error);
        }
      } else {
        updateTexturePipelineProgress(100, '当前视角均已有完整贴图');
      }
      setGenerateNotice(undefined);
      pushToast({
        tone: 'success',
        title: '远端多视图生成完成',
        description: `生成并投影 ${projectedGenerationCount}/${viewCount} 个视角${
          skippedViewCount > 0 ? `，跳过 ${skippedViewCount} 个已完整覆盖视角` : ''
        }。`,
      });
    } finally {
      useSceneStore.getState().requestCameraRestore(originalCamera);
      setActiveCameraViewId(originalActiveViewId);
    }
  }

  async function handleGptPairedMultiviewGenerate(
    materialReference: ReferenceImage,
    requestedViews: CameraViewItem[],
    signal?: AbortSignal,
  ) {
    if (!captureObjectId || !currentProject) throw new Error('当前模型或工程尚未就绪。');
    const objectId = captureObjectId;
    const projectId = currentProject.id;
    const scheduler = await import('@/engine/generation/gptMultiviewPairs');
    const pairs = scheduler.planGptViewPairs(requestedViews, selectedCameraViewPreset);
    const textureBatchId = createId('gpt-paired-multiview');
    const assertActive = () => {
      throwIfTexturePipelineCancelled(signal);
      if (cancelledTextureBatchIdsRef.current.has(textureBatchId)) {
        throw new Error('用户已终止纹理贴图生成任务。');
      }
      if (
        useProjectStore.getState().currentProjectId !== projectId ||
        !useSceneStore.getState().importedModels.some((model) => model.objectId === objectId)
      ) {
        throw new Error('工程或模型已切换，停止后续视角。');
      }
    };
    let projectedCount = 0;
    let qaRejectedCount = 0;
    try {
      await scheduler.runGptViewPairs(pairs, assertActive, async (pair, index) => {
        pairProgressScopeRef.current = { index, count: pairs.length };
        setGenerateNotice({
          tone: 'info',
          message: `第 ${index + 1}/${pairs.length} 组：${pair.map((view) => view.label).join(' + ')}。本组回贴后再生成下一组。`,
        });
        const result = await handleTextureMapMultiviewGenerate(
          materialReference,
          [...pair],
          'multi',
          signal,
          { textureBatchId, scheduler },
        );
        assertActive();
        if (!result) {
          throw new Error(
            '本组没有返回可用的生成结果，已停止后续视角。',
          );
        }
        const disposition = scheduler.gptPairCompletionDisposition(
          pair.length,
          result.projected,
          result.qaRejected,
        );
        const qaOnlyFailure = disposition === 'continue-after-qa';
        if (disposition === 'stop') {
          throw new Error(
            result.error ?? '本组有视角未完成生成或回贴，已保留成功结果并停止后续视角。',
          );
        }
        if (result.layerIds.length > 0) {
          updateTexturePipelineProgress(87, '准备多视图快照 · 等待本组回贴显示');
          await scheduler.waitForGptPairPresentation(
            () => {
              const liveLayers = useLayerStore.getState().layers;
              // A user-deleted/hidden result is not resurrected or awaited forever.
              const required = result.layerIds.filter((id) =>
                liveLayers.some((layer) => layer.id === id && layer.visible),
              );
              if (!required.length) return true;
              const root = useSceneStore
                .getState()
                .importedModels.find((model) => model.objectId === objectId)?.group;
              return scheduler.hasResidentGptLayers(root, required);
            },
            assertActive,
            waitForBrowserPaint,
            60_000,
            () => {
              updateTexturePipelineProgress(87, '结果已保存 · 等待视口渲染恢复');
              setGenerateNotice({
                tone: 'warning',
                message: '本组生图结果已保存，正在等待回贴与合成渲染完成；完成后会自动继续下一组。',
              });
            },
          );
        }
        projectedCount += result.projected;
        qaRejectedCount += result.qaRejected;
        if (qaOnlyFailure) {
          setGenerateNotice({
            tone: 'warning',
            message: `本组 ${result.qaRejected} 个视角未通过回图 QA；已保留结果并继续后续视角。`,
          });
        }
        updateTexturePipelineProgress(90, '多视图回贴完成');
      });
    } finally {
      pairProgressScopeRef.current = undefined;
    }
    assertActive();
    if (projectedCount > 0) {
      updateTexturePipelineProgress(92, '内容识别补缝');
      try {
        await requestContentAwareRepair({
          source: 'multiview-texture',
          projectId,
          objectId,
          batchId: textureBatchId,
          silentForeground: true,
        });
        updateTexturePipelineProgress(100, '多视图完成');
      } catch (error) {
        updateTexturePipelineProgress(100, '纹理完成，补缝未完成');
        console.warn('[Li3D] Paired multiview repair failed:', error);
      }
    } else {
      updateTexturePipelineProgress(100, '多视图回图未通过 QA');
    }
    setGenerateNotice(undefined);
    pushToast({
      tone: qaRejectedCount > 0 ? 'warning' : 'success',
      title: qaRejectedCount > 0 ? '多视图部分完成' : t('textureMapGenerated'),
      description: `已按 ${pairs.length} 组生成并投影 ${projectedCount} 个视角${
        qaRejectedCount > 0 ? `，${qaRejectedCount} 个视角未通过回图 QA` : ''
      }。`,
    });
  }

  async function handleTextureMapMultiviewGenerate(
    materialReference: ReferenceImage,
    requestedViews: CameraViewItem[] = cameraViews,
    requestedViewMode: TextureViewMode = 'multi',
    signal?: AbortSignal,
    pairContext?: GptPairContext,
  ): Promise<TextureViewBatchResult | undefined> {
    throwIfTexturePipelineCancelled(signal);
    if (!captureObjectId) throw new Error(t('importModelFirst'));
    if (requestedViews.length === 0) throw new Error('请先添加至少一个模型视角。');
    const isMultiviewRequest = requestedViewMode === 'multi';
    const usesRemoteTextureGeneration = singleViewProvider === 'remote';
    const usesRemoteSingleView = !isMultiviewRequest && usesRemoteTextureGeneration;
    if (usesRemoteTextureGeneration) {
      if (!(await requireFeishuLogin())) {
        throw new Error('未完成飞书登录，无法使用远端纹理生成服务。');
      }
    } else {
      if (!pairContext) await requirePersonalLiclickAccount();
    }
    throwIfTexturePipelineCancelled(signal);
    if (isMultiviewRequest && usesRemoteTextureGeneration) {
      await handleRemoteSequentialMultiviewGenerate(materialReference, requestedViews, signal);
      return;
    }
    if (isMultiviewRequest && !pairContext) {
      await handleGptPairedMultiviewGenerate(materialReference, requestedViews, signal);
      return;
    }
    const objectId = captureObjectId;
    const object = objects.find((item) => item.id === objectId);
    const texturePromptBuilders = usesRemoteSingleView
      ? undefined
      : await import('@/engine/generation/textureMapPrompts');
    let texturePrompt = usesRemoteSingleView
      ? ''
      : texturePromptBuilders!.buildTextureMapPrompt(prompt);
    const objectMatrixWorld = getImportedModelMatrixWorld(objectId);
    const shouldInspectExistingSingleViewTexture =
      !isMultiviewRequest && hasVisibleTextureLayerCandidate(objectId);
    const singleViewCameraSnapshot = !isMultiviewRequest
      ? await frameGenerationCapture(objectId, 1, requestedViews[0]?.viewDirection, requestedViews[0]?.viewUp, signal, true, usesRemoteSingleView ? 0.92 : 0.98)
      : undefined;
    let currentSingleViewEffectUrl: string | undefined;
    if (shouldInspectExistingSingleViewTexture) {
      const currentView = requestedViews[0];
      updateTexturePipelineProgress(20, '准备当前贴图效果');
      const currentEffect = await captureCurrentColorPreview({
        objectId,
        resolution: resolutionToSize[resolution],
        framing: 'fit-object',
        colorMode: 'flat-target-coverage',
        fillRatio: 0.88,
        cameraSnapshot: singleViewCameraSnapshot,
        viewDirection: currentView?.viewDirection,
        viewUp: currentView?.viewUp,
      });
      currentSingleViewEffectUrl = currentEffect.colorUrl;
      throwIfTexturePipelineCancelled(signal);
    }
    const pairCurrentEffects = new Map<string, string>();
    const viewSnapshots = new Map<string, SerializedCameraInput>();
    if (pairContext && hasVisibleTextureLayerCandidate(objectId)) {
      // Freeze authored colour BEFORE white presentation replaces the resident
      // material. Clearing that flag later does not synchronously restore it.
      updateTexturePipelineProgress(20, '准备多视图快照 · 保存已有纹理');
      for (const view of requestedViews) {
        throwIfTexturePipelineCancelled(signal);
        const snapshot = await frameGenerationCapture(objectId, 1, view.viewDirection, view.viewUp, signal, false, 0.98);
        viewSnapshots.set(view.id, snapshot);
        const effect = await captureCurrentColorPreview({
          objectId, resolution: resolutionToSize[resolution], framing: 'fit-object',
          colorMode: 'flat-target-coverage', fillRatio: 0.88, cameraSnapshot: snapshot,
          viewDirection: view.viewDirection, viewUp: view.viewUp,
        });
        pairCurrentEffects.set(view.id, effect.colorUrl);
      }
    }
    updateTexturePipelineProgress(24, isMultiviewRequest ? '准备多视角快照' : '准备当前单视图');
    let capturedViews = await getTextureMapMultiviewCaptures(requestedViews, signal, {
      cameraSnapshot: singleViewCameraSnapshot, viewSnapshots,
    });
    throwIfTexturePipelineCancelled(signal);
    if (capturedViews.length === 0) {
      throw new Error(isMultiviewRequest ? '无法捕获多视图模型方向。' : '无法捕获当前单视图。');
    }
    const completionViewIds = new Set<string>();
    if (pairContext && pairCurrentEffects.size > 0) {
      // Capture only this pair, after the previous pair's resident barrier. GPU
      // capture/compositing is serial; only the remote jobs run concurrently.
      for (const view of capturedViews) {
        throwIfTexturePipelineCancelled(signal);
        const currentEffectUrl = pairCurrentEffects.get(view.viewId);
        if (!currentEffectUrl) throw new Error('当前视角的已有纹理截图未准备完成。');
        const completion = await prepareSingleViewTextureCompletion({
          currentEffectUrl,
          clayPreviewUrl: view.capture.colorUrl,
          objectMaskUrl: view.capture.maskUrl,
        });
        if (completion.hasVisibleTexture) {
          // The input worker intentionally omits a composite for fully covered
          // views. Still honor every selected angle using its current texture.
          const guideUrl = completion.imageUrl ??
            (completion.uncoveredPixelCount === 0 ? currentEffectUrl : undefined);
          if (!guideUrl) throw new Error('无法准备本组已有纹理补全引导图。');
          view.capture = { ...view.capture, colorUrl: guideUrl };
          completionViewIds.add(view.viewId);
        }
      }
    }
    let singleViewCompletion: PreparedSingleViewTextureCompletion | undefined;
    let usesRemoteSingleViewInpaint = false;
    if (currentSingleViewEffectUrl || usesRemoteSingleView) {
      const currentViewCapture = capturedViews[0]?.capture;
      if (currentViewCapture?.maskUrl) {
        updateTexturePipelineProgress(38, '合成单视图补全引导图');
        try {
          singleViewCompletion = await prepareSingleViewTextureCompletion({
            currentEffectUrl: currentSingleViewEffectUrl ?? currentViewCapture.colorUrl,
            clayPreviewUrl: currentViewCapture.colorUrl,
            objectMaskUrl: currentViewCapture.maskUrl,
            whiteFill: usesRemoteSingleView,
            fullObject: !currentSingleViewEffectUrl,
          });
          if (singleViewCompletion.hasVisibleTexture || usesRemoteSingleView) {
            if (usesRemoteSingleView && singleViewCompletion.uncoveredPixelCount === 0) {
              throw new Error('当前视角已经全部有贴图，没有需要远端补全的白模区域。');
            }
            const completionGuideUrl = singleViewCompletion.imageUrl ?? currentSingleViewEffectUrl;
            if (!completionGuideUrl) throw new Error('无法准备单视图纯白输入。');
            capturedViews = capturedViews.map((view, index) =>
              index === 0
                ? {
                    ...view,
                    capture: {
                      ...view.capture,
                      // The fused image guides Atlas, but the original full-object
                      // silhouette must remain the projection mask. Replacing it
                      // with the local gap mask crops the returned result to a strip.
                      colorUrl: completionGuideUrl,
                    },
                  }
                : view,
            );
            if (usesRemoteSingleView) {
              if (!singleViewCompletion.completionMaskUrl) {
                throw new Error('无法生成远端单视图补全蒙版，请重试。');
              }
              usesRemoteSingleViewInpaint = singleViewCompletion.hasVisibleTexture;
            } else {
              texturePrompt = texturePromptBuilders!.buildTextureMapCompletionPrompt(prompt);
            }
          }
        } catch (error) {
          throw new Error(
            getUserFacingGenerationError(error, '已有贴图的单视图补全引导图准备失败，请重试。'),
          );
        }
      }
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
    if (!pairContext)
      setGenerateNotice({
        tone: 'info',
        message: isMultiviewRequest
          ? `正在提交 ${viewCaptures.length} 个多视图纹理贴图任务。`
          : '正在提交当前单视图纹理贴图任务。',
      });

    const { createModelviewApiClient } = await import('@/services/modelviewApiClient');
    const modelviewClient = usesRemoteSingleView ? createModelviewApiClient() : undefined;
    const textureBatchId = pairContext?.textureBatchId ?? createId('texture-map-batch');
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
        prompt: completionViewIds.has(viewId)
          ? texturePromptBuilders!.buildTextureMapCompletionPrompt(prompt)
          : texturePrompt,
        referenceIds: [modelViewReference.id, materialReference.id],
        captureId: capture.id,
        status: 'running',
        metadata: {
          provider: usesRemoteSingleView
            ? usesRemoteSingleViewInpaint
              ? 'modelview-single-view-inpaint'
              : 'modelview-single-view'
            : 'liclick-atlas',
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
          singleViewInputMode:
            singleViewCompletion?.hasVisibleTexture === true || completionViewIds.has(viewId)
              ? 'existing-texture-completion'
              : 'initial-clay',
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
      pendingGenerations.map(
        async ({ capture, generationId, modelViewReference, pendingGeneration }) => {
          throwIfTexturePipelineCancelled(signal);
          if (usesRemoteSingleView && modelviewClient) {
            if (!capture.normalUrl) {
              throw new Error('当前视角法线图不可用，请重新捕获后重试。');
            }
            const [singleViewDataUrl, materialDataUrl, completionMaskDataUrl, normalDataUrl] =
              await Promise.all([
                urlToDataUrl(capture.colorUrl),
                urlToDataUrl(materialReference.url),
                usesRemoteSingleViewInpaint && singleViewCompletion?.completionMaskUrl
                  ? urlToDataUrl(singleViewCompletion.completionMaskUrl)
                  : Promise.resolve(undefined),
                urlToDataUrl(capture.normalUrl),
              ]);
            throwIfTexturePipelineCancelled(signal);
            if (usesRemoteSingleViewInpaint) {
              if (!completionMaskDataUrl) {
                throw new Error('远端单视图补全蒙版不可用，请重试。');
              }
              return modelviewClient.generateSingleViewInpaint(
                {
                  resultBlend: await modelviewClient.prepareResultBlend(currentSingleViewEffectUrl, capture, signal),
                  clientGenerationId: generationId,
                  projectId: currentProject?.id,
                  captureId: capture.id,
                  objectId: object?.id,
                  normalImage: {
                    path: `${capture.id}-normal.png`,
                    dataUrl: normalDataUrl,
                  },
                  image: {
                    path: `${capture.id}-current-effect.png`,
                    dataUrl: singleViewDataUrl,
                  },
                  materialImage: {
                    path: `${materialReference.id}-multiview-material.png`,
                    dataUrl: materialDataUrl,
                  },
                  mask: {
                    path: `${capture.id}-completion-mask.png`,
                    dataUrl: completionMaskDataUrl,
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
            return modelviewClient.generateSingleView(
              {
                clientGenerationId: generationId,
                projectId: currentProject?.id,
                captureId: capture.id,
                objectId: object?.id,
                normalImage: {
                  path: `${capture.id}-normal.png`,
                  dataUrl: normalDataUrl,
                },
                image: {
                  path: `${capture.id}-white-model.png`,
                  dataUrl: singleViewDataUrl,
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
          return submitGptTextureViewWithSilhouetteRetry(
            pendingGeneration,
            modelViewReference,
            materialReference,
            capture,
            signal,
          );
        },
      ),
    );
    if (!textureBatchWasCancelled()) updateTexturePipelineProgress(46, '生成纹理贴图');

    const completedGenerations: Generation[] = [];
    let singleViewProjectionSaved = false;
    const failureMessages: string[] = [];
    let qaRejectedGenerationCount = 0;
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
            void createLiclickApiClient()
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
      const failureMessage =
        result.reason instanceof Error ? result.reason.message : `${pending.label} 视角提交失败。`;
      if (isTextureReturnQaFailure(result.reason)) qaRejectedGenerationCount += 1;
      failureMessages.push(`${pending.label}视角提交失败：${getUserFacingGenerationError(failureMessage)}`);
      syncGeneration(
        createFailedGeneration(pending.pendingGeneration, failureMessage, {
          cameraView: pending.cameraView,
          cameraViewId: pending.viewId,
          cameraViewLabel: pending.label,
          ...textureReturnQaFailureMetadata(result.reason),
        }),
      );
    });
    // The paired jobs already have server IDs and their camera checkpoint was
    // saved before submission. Observe returned images while this status-only
    // save runs; the final group checkpoint still drains the same save queue
    // before the next group's capture/submission can start.
    if (pairContext) void saveGenerationStateBestEffort();
    else await saveGenerationStateBestEffort();

    // Multi-view generation/network/persistence may finish one view at a time, but a
    // different projected-layer count requires a different shader and texture
    // array. Keep the last valid viewport material resident throughout the
    // batch and publish the complete stack once. Layer rows and durable project
    // saves still progress normally. Single-view has no intermediate stack to
    // hide: publish its durable assets immediately, while the project CAS save
    // and material preparation continue independently.
    if (isMultiviewRequest) useLayerStore.getState().beginProjectedPreviewBatch();
    try {
      let completedTextureViewCount = 0;
      const waitForSubmittedTextureGeneration = (generation: Generation) => {
        if (usesRemoteSingleView) return waitForLiclickGeneration(generation);
        const pending = pendingGenerations.find(
          (candidate) =>
            candidate.capture.id === generation.captureId ||
            candidate.viewId === generation.metadata.cameraViewId,
        );
        if (!pending) return waitForLiclickGeneration(generation);
        return waitForGptTextureGenerationWithSilhouetteRetry(
          generation,
          pending.modelViewReference,
          materialReference,
          pending.capture,
          signal,
        );
      };
      const completeView = async (generation: Generation, ready?: Generation) => {
        try {
          throwIfTexturePipelineCancelled(signal);
          if (textureBatchWasCancelled() || isCancelledGeneration(generation)) {
            throw new Error('用户已终止纹理贴图生成任务。');
          }
          const completed = ready ?? (await waitForSubmittedTextureGeneration(generation));
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
            let savedProjection: Generation | undefined;
            const projectedLayer = await addGenerationAsProjectedLayer(completed, {
              automatic: true,
              capture: exactCapture,
              saveObserver: isMultiviewRequest ? undefined : {
                onSaving: () => {
                  if (textureBatchWasCancelled()) return;
                  const message = '回贴完成，正在保存';
                  updateTexturePipelineProgress(86, message);
                  setGenerateNotice({ tone: 'info', message });
                },
                onSaved: (committed) => {
                  savedProjection = committed;
                  singleViewProjectionSaved = true;
                },
              },
            });
            if (!projectedLayer) {
              return { generation: completed, projected: false };
            }
            // The transaction saved both the layer and its receipt. Do not
            // rewrite completedAt/projectionCommittedAt and save them again.
            if (savedProjection) return { generation: savedProjection, projected: true };
            const completedWithProjection = withProjectionCommit(completed, projectedLayer.id);
            syncGeneration(completedWithProjection);
            return { generation: completedWithProjection, projected: true };
          } catch (error) {
            const message = error instanceof Error ? error.message : '生成已完成，但自动投影失败。';
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
      };
      const completionResults = pairContext
          ? await pairContext.scheduler.settleGptPairInOrder(
            submittedGenerations,
            waitForSubmittedTextureGeneration,
            completeView,
          )
        : await Promise.allSettled(
            submittedGenerations.map((generation) => completeView(generation)),
          );
      completionResults.forEach((result, index) => {
        const submitted = submittedGenerations[index];
        if (!submitted) return;
        if (result.status === 'fulfilled') {
          completedGenerations.push(result.value.generation);
          if (result.value.projected) projectedGenerationCount += 1;
        } else {
          if (textureBatchWasCancelled() || isCancelledGeneration(submitted)) return;
          const failureMessage =
            result.reason instanceof Error
              ? result.reason.message
              : isMultiviewRequest
                ? '多视角纹理贴图任务失败。'
                : '当前单视图纹理贴图任务失败。';
          failureMessages.push(`${String(submitted.metadata.cameraViewLabel ?? '当前')}视角生成失败：${getUserFacingGenerationError(failureMessage)}`);
          if (isTextureReturnQaFailure(result.reason)) qaRejectedGenerationCount += 1;
          syncGeneration(createFailedGeneration(
            submitted,
            failureMessage,
            textureReturnQaFailureMetadata(result.reason),
          ));
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
          const recoveredGeneration = withProjectionCommit(generation, recoveredLayer.id);
          completedGenerations[index] = recoveredGeneration;
          syncGeneration(recoveredGeneration);
        } catch (error) {
          console.error('[Liclick 3D Texture] Could not recover missing projected view:', error);
        }
      }
    } finally {
      if (isMultiviewRequest) useLayerStore.getState().endProjectedPreviewBatch();
    }
    const completedGenerationIds = new Set(completedGenerations.map((generation) => generation.id));
    projectedGenerationCount = useLayerStore
      .getState()
      .layers.filter(
        (layer) => layer.generationId && completedGenerationIds.has(layer.generationId),
      ).length;
    if (needsTextureCompletionCheckpoint(
      isMultiviewRequest, singleViewProjectionSaved, completedGenerations.length,
      projectedGenerationCount, failureMessages.length,
    )) await saveGenerationStateBestEffort();

    if (pairContext) {
      throwIfTexturePipelineCancelled(signal);
      return {
        projected: projectedGenerationCount,
        qaRejected: qaRejectedGenerationCount,
        layerIds: useLayerStore
          .getState()
          .layers.filter(
            (layer) => layer.generationId && completedGenerationIds.has(layer.generationId),
          )
          .map((layer) => layer.id),
        error: failureMessages[0],
      };
    }

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
        tone: projectedGenerationCount === completedGenerations.length ? 'success' : 'warning',
        title: t('textureMapGenerated'),
        description: isMultiviewRequest
          ? `已生成 ${completedGenerations.length}/${pendingGenerations.length} 个多视图纹理贴图，自动投影 ${projectedGenerationCount}/${completedGenerations.length} 个。`
          : projectedGenerationCount === completedGenerations.length
            ? '单视图纹理贴图已自动投影并添加到图层。'
            : '单视图图片已生成，尚未完成回贴的结果将自动重试，请勿重复生图。',
      });
    } else {
      setGenerateNotice({
        tone: 'error',
        message:
          failureMessages[0] ??
          (isMultiviewRequest ? '多视图纹理贴图任务提交失败。' : '单视图纹理贴图任务提交失败。'),
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
      // Validate the canonical UV mask before framing. After the short camera
      // transition all passes share one frozen camera, including after login.
      const captureAspect = 1;
      if (!initialMaskState.paintMaskCapture) {
        throw new Error('蒙版尚未准备好，请稍后重试。');
      }
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
      let materialReference = isGptLocalRepaint ? resolveGptRepaintReference({
        enabled: gptRepaintUseMaterialReference,
        references: referencesAtSubmission,
        selectedReferenceIds: referenceStateAtSubmission.selectedReferenceIds,
      }) : resolveLocalRepaintMaterialReference({
        references: referencesAtSubmission,
        selectedReferenceIds: referenceStateAtSubmission.selectedReferenceIds,
        historicalReferenceId:
          typeof historicalReferenceId === 'string' ? historicalReferenceId : undefined,
      });
      if (!isGptLocalRepaint && !materialReference) {
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
      requestAbortController = new AbortController();
      localRepaintPreparationAbortControllerRef.current = requestAbortController;
      submitLocksRef.current.add('repaint');
      setSubmissionActive(true);
      if (personalRepaintEnabled && !isGptLocalRepaint) {
        if (!materialReference || !isMultiviewReference(materialReference)) {
          throw new Error('个人云端直连需要先选择已有的多视图材质参考图。');
        }
        await (await import('@/services/personalRepaintClient')).connectPersonalRepaint(requestAbortController.signal);
      }
      setLocalRepaintPreparation((current) => ({
        startedAt: current?.startedAt ?? Date.now(),
        detail: '正在调整生成取景',
      }));
      const captureCameraSnapshot = await frameGenerationCapture(objectId, captureAspect, undefined, undefined, requestAbortController.signal, true, isGptLocalRepaint ? 0.98 : 0.92);
      // Keep the previous completed repaint on its resident GPU path while the
      // next request prepares detached browser snapshots.
      useSceneStore.getState().setLocalRepaintGenerationPresentationActive(true);
      if (authStatus !== 'authenticated' && !(await requireFeishuLogin())) return false;
      if (!isGptLocalRepaint && materialReference && !isMultiviewReference(materialReference)) {
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
      // A hidden tab has no rAF. Keep submission progressing via the existing
      // background fallback instead of waiting for the user to return.
      await waitForBrowserPaint();
      await waitForBrowserPaint();
      // ModelView receives one square 2K composite: authored BaseColor outside
      // the selection union and exact RGB white inside. GPT retains its clay guide.
      // Qwen receives the clean authored view instead, plus the original
      // unexpanded selection union and full multiview reference, so neither placeholder
      // shading nor the remote-only blending margin biases its diagnosis.
      document.body.dataset.perfLocalRepaintPhase = 'button2-mask-capture';
      setLocalRepaintPreparation((current) => ({
        startedAt: current?.startedAt ?? Date.now(),
        detail: '正在准备当前蒙版',
      }));
      const maskCaptureStartedAt = performance.now();
      let currentPaintMaskDataUrl =
        await initialMaskState.paintMaskCapture({
          aspect: captureAspect,
          camera: captureCameraSnapshot.camera,
          resolution: LOCAL_REPAINT_INPUT_RESOLUTION,
        });
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
          colorMode: 'flat-target-coverage',
          aspect: captureAspect,
          cameraSnapshot: captureCameraSnapshot,
        },
        currentPaintMaskDataUrl,
        { archive: false },
      );
      let depthPreviewPromise: ReturnType<typeof captureRepaintDepth> | undefined;
      if (!isGptLocalRepaint) {
        depthPreviewPromise = captureRepaintDepth();
        const depth = await depthPreviewPromise;
        if (!depth) throw new Error('无法读取当前视角的未贴图区域，请重试。');
        capture = { ...capture, depthUrl: depth.depthUrl, depthEncoding: depth.depthEncoding };
      }
      const flatCurrentEffectUrl = capture.colorUrl;
      promptAnalysisCurrentEffectUrl = flatCurrentEffectUrl;
      let clayPreviewUrl: string | undefined;
      let preparedGenerationInput: Awaited<ReturnType<typeof prepareLocalRepaintGenerationInput>>;
      try {
        if (isGptLocalRepaint) {
          const clayPreview = await captureCurrentColorPreview({
            objectId,
            resolution: LOCAL_REPAINT_INPUT_RESOLUTION,
            framing: 'current',
            colorMode: 'clay-target',
            aspect: captureAspect,
            cameraSnapshot: captureCameraSnapshot,
          });
          clayPreviewUrl = clayPreview.colorUrl;
        }
        setLocalRepaintPreparation((current) => ({
          startedAt: current?.startedAt ?? Date.now(),
          detail: '正在融合当前效果与蒙版预览',
        }));
        const preparationInput = {
          gptGuide: isGptLocalRepaint,
          currentEffectUrl: flatCurrentEffectUrl,
          clayPreviewUrl,
          authoredMaskUrl: currentPaintMaskDataUrl,
          coverageDepthUrl: isGptLocalRepaint ? undefined : capture.depthUrl,
        };
        if (isGptLocalRepaint) {
          preparedGenerationInput = await prepareLocalRepaintGenerationInput(preparationInput);
        } else {
          const { prepareRepaintInputs } = await import('@/engine/localRepaint/prepareRepaintInputs');
          const prepared = await prepareRepaintInputs(preparationInput,
            () => captureLocalRepaintNormal(capture, captureCameraSnapshot, requestAbortController!.signal, normalBackground),
            requestAbortController.signal);
          capture = prepared.capture;
          preparedGenerationInput = prepared.prepared;
        }
        document.body.dataset.localRepaintButton2InputWorkerMs = preparedGenerationInput.processMs.toFixed(1);
        document.body.dataset.localRepaintButton2InputPhases = JSON.stringify(preparedGenerationInput.phaseDurationsMs);
        currentPaintMaskDataUrl = preparedGenerationInput.selectionMaskUrl ?? currentPaintMaskDataUrl;
      } finally {
        revokeRegisteredObjectUrl(clayPreviewUrl);
      }
      capture = {
        ...capture,
        colorUrl: preparedGenerationInput.compositeUrl,
        // Capture/paintback keeps the selection union, independently of the
        // remote sampling mask. Neither limits manual repaint brush coverage.
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
      const persistedSubmittedMaskUrlPromise = isGptLocalRepaint ? Promise.resolve(undefined) : persistGeneratedImage(
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
      const requestPrompt = resolveLocalRepaintUserPrompt(rawUserPrompt);
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
        prompt: requestPrompt,
        modelviewPromptPolicy: 'white-selection-default-v1',
        smartPolish: isGptLocalRepaint ? undefined : localRepaintSmartPolish,
        normalBackground,
        promptTemplatePolicy: LOCAL_REPAINT_PROMPT_TEMPLATE_POLICY,
        promptSource: rawUserPrompt ? 'user-request' : 'default-seam',
        projectId: currentProject.id,
        objectId,
        referenceId: materialReference?.id,
        gptRepaintUseMaterialReference: isGptLocalRepaint ? gptRepaintUseMaterialReference : undefined,
        paintMaskRevision: currentPaintMaskRevision,
        camera: capture.camera,
        objectMatrixWorld: captureObjectMatrixWorld,
        surfaceSignature,
        sourceComposition: isGptLocalRepaint ? 'gpt-clay-selection-coverage-v1' : 'flat-white-mask-v1',
      });
      let resolvedPrompt = isGptLocalRepaint
        ? { prompt: (await import('@/engine/localRepaint/gptRepaintPrompt')).buildGptRepaintPrompt(rawUserPrompt, gptRepaintUseMaterialReference), source: 'geometry-normal-v1' as const }
        : !localRepaintSmartPolish
          ? { prompt: '', source: 'workflow-default' as const }
          : localRepaintResolvedPromptCacheRef.current.get(promptFingerprint);
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
              persistedResolution.metadata.promptSource === 'default-seam'
                ? 'default-seam'
                : 'user-request',
          };
          localRepaintResolvedPromptCacheRef.current.set(promptFingerprint, resolvedPrompt);
        }
      }
      if (!resolvedPrompt) {
        if (!materialReference) throw new Error('缺少材质参考图。');
        setLocalRepaintPreparation((current) => ({
          startedAt: current?.startedAt ?? Date.now(),
          detail: '正在优化局部重绘提示词',
        }));
        setGenerateNotice({
          tone: 'info',
          message: '正在结合蒙版与参考图优化提示词。',
        });
        const visualInputs = await prepareLocalRepaintPromptPolishInputs({
          objectId,
          reference: materialReference,
          cameraSnapshot: captureCameraSnapshot,
          currentEffectUrl: promptAnalysisCurrentEffectUrl,
          maskUrl: currentPaintMaskDataUrl,
          paintMaskRevision: currentPaintMaskRevision,
        });
        const preparationSignal = requestAbortController.signal;
        if (preparationSignal.aborted) {
          throw new DOMException('用户已终止局部生图准备。', 'AbortError');
        }
        const optimizedPrompt = await Promise.race([
          createLiclickApiClient().polishPrompt({
            prompt: requestPrompt,
            context: 'local-repaint',
            modelName: 'FLUX.2 Klein',
            objectName: objects.find((object) => object.id === objectId)?.name,
            referenceNames: [visualInputs.referenceImage.name || materialReference.name],
            hasMask: true,
            currentEffectImage: visualInputs.currentEffectImage,
            maskImage: visualInputs.maskImage,
            referenceImage: visualInputs.referenceImage,
          }),
          new Promise<never>((_, reject) => {
            preparationSignal.addEventListener(
              'abort',
              () => reject(new DOMException('用户已终止局部生图准备。', 'AbortError')),
              { once: true },
            );
          }),
        ]);
        if (useSceneStore.getState().paintMaskRevision !== currentPaintMaskRevision) {
          throw new Error('蒙版在分析期间发生变化，请重新生成。');
        }
        resolvedPrompt = {
          prompt: optimizedPrompt,
          source: rawUserPrompt ? 'user-request' : 'default-seam',
        };
        const promptCache = localRepaintResolvedPromptCacheRef.current;
        if (promptCache.size >= 6) {
          const oldestKey = promptCache.keys().next().value;
          if (oldestKey) promptCache.delete(oldestKey);
        }
        promptCache.set(promptFingerprint, resolvedPrompt);
      }
      if (requestAbortController.signal.aborted) {
        throw new DOMException('用户已终止局部生图准备。', 'AbortError');
      }
      const effectivePrompt = resolvedPrompt.prompt;
      pendingGeneration = {
        id: generationId,
        mode: 'inpaint',
        prompt: effectivePrompt,
        referenceIds: materialReference ? [materialReference.id] : [],
        captureId: capture.id,
        status: 'running',
        metadata: {
          provider: isGptLocalRepaint ? 'liclick-atlas' : 'modelview-int8',
          model: isGptLocalRepaint ? textureGptModel : undefined,
          workflow: 'local-repaint',
          modelviewWorkflow: isGptLocalRepaint ? undefined : '2026.09.18-refcontrol-normal-4step-r1',
          promptPolishEnabled: isGptLocalRepaint ? undefined : localRepaintSmartPolish,
          normalBackground,
          clientGenerationId: generationId,
          projectId: currentProject.id,
          objectId,
          materialReferenceId: materialReference?.id,
          gptRepaintInputPolicy: isGptLocalRepaint ? 'geometry-normal-v1' : undefined,
          gptRepaintUseMaterialReference: isGptLocalRepaint ? gptRepaintUseMaterialReference : undefined,
          paintMaskRevision: currentPaintMaskRevision,
          paintMaskSource: isGptLocalRepaint ? 'user' : 'user-and-visible-gaps-v1',
          authoredMaskUrl: currentPaintMaskDataUrl,
          submittedMaskUrl: isGptLocalRepaint ? undefined : preparedGenerationInput.submittedMaskUrl,
          promptSource: resolvedPrompt.source,
          promptFingerprint,
          userPrompt: rawUserPrompt,
          sourceColorMode: isGptLocalRepaint ? 'gpt-clay-selection-coverage-v1' : 'flat-white-mask-v1',
          sourceComposition: isGptLocalRepaint ? 'gpt-clay-selection-coverage-v1' : 'flat-white-mask-v1',
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
        message: isGptLocalRepaint
          ? `正在提交结合图、法线图${materialReference ? '、材质参考图' : ''}和提示词。`
          : '正在提交效果图、参考图、蒙版和原始法线图。',
      });
      if (localRepaintPreparationAbortControllerRef.current === requestAbortController) {
        localRepaintPreparationAbortControllerRef.current = undefined;
      }
      generationAbortControllersRef.current.set(generationId, requestAbortController);
      const personalRequestStartedAt = personalRepaintEnabled ? performance.now() : 0;
      const [currentEffectDataUrl, materialReferenceDataUrl, maskDataUrl, normalDataUrl] = await Promise.all([
        urlToDataUrl(capture.colorUrl),
        materialReference ? urlToDataUrl(materialReference.url) : Promise.resolve(''),
        isGptLocalRepaint ? Promise.resolve('') : urlToDataUrl(preparedGenerationInput.submittedMaskUrl),
        isGptLocalRepaint ? Promise.resolve('') : urlToDataUrl(capture.normalUrl!),
      ]);
      const { createModelviewApiClient } = await import('@/services/modelviewApiClient');
      const personalRequestPreparationMs = personalRepaintEnabled ? performance.now() - personalRequestStartedAt : 0;
      const generationPromise = isGptLocalRepaint ? (async () => {
        // Persist camera + authored selection before paying for a recoverable cloud job.
        const authoredMaskUrl = await persistedAuthoredMaskUrlPromise;
        if (!isWorkspaceAssetUrl(authoredMaskUrl)) throw new Error('原始选区尚未保存，未提交 GPT 任务，请重试。');
        const depth = await (depthPreviewPromise ??= captureRepaintDepth());
        if (!depth) throw new Error('深度截图失败，未提交 GPT 任务，请重试。');
        capture = { ...capture, depthUrl: depth.depthUrl, depthEncoding: depth.depthEncoding };
        if (requestAbortController!.signal.aborted) throw new DOMException('已终止局部生图。', 'AbortError');
        capture = await captureLocalRepaintNormal(capture, captureCameraSnapshot, requestAbortController!.signal, normalBackground);
        const recoveryCaptures = [
          { ...capture, maskUrl: authoredMaskUrl },
          ...(useProjectStore.getState().projects.find((item) => item.id === currentProject.id)?.captures ?? [])
            .filter((item) => item.id !== capture.id),
        ];
        updateProjectById(currentProject.id, { captures: recoveryCaptures });
        syncGeneration({ ...pendingGeneration!, metadata: { ...pendingGeneration!.metadata,
          authoredMaskUrl, maskUrl: authoredMaskUrl } });
        await saveCriticalProjectState({ captures: recoveryCaptures });
        if (requestAbortController!.signal.aborted) throw new DOMException('已终止局部生图。', 'AbortError');
        const submitted = await createLiclickApiClient().generateTextureSingleView(buildGptLocalRepaintRequest({
          generationId, projectId: currentProject.id, prompt: effectivePrompt,
          guideUrl: currentEffectDataUrl, normalUrl: await urlToDataUrl(capture.normalUrl!),
          reference: materialReference ? { ...materialReference, url: materialReferenceDataUrl } : undefined,
          signal: requestAbortController!.signal,
          capture, object: objects.find((item) => item.id === objectId), model: textureGptModel,
          quality: textureGptQuality,
          resolution,
        }));
        if (isCancelledGeneration(pendingGeneration!)) {
          await createLiclickApiClient().cancelGenerationJob(getGenerationJobId(submitted));
          throw new DOMException('已终止局部生图。', 'AbortError');
        }
        const tracked: Generation = { ...pendingGeneration!, metadata: {
          ...pendingGeneration!.metadata, ...submitted.metadata, authoredMaskUrl, maskUrl: authoredMaskUrl,
          workflow: 'local-repaint', serverSubmitted: true,
        } };
        syncGeneration(tracked);
        window.dispatchEvent(new Event(IMMEDIATE_PROJECT_SAVE_EVENT));
        return waitForLiclickGeneration({ ...tracked, resultUrl: submitted.resultUrl });
      })() : createModelviewApiClient().generateInpaint(
        {
          clientGenerationId: generationId,
          projectId: currentProject.id,
          captureId: capture.id,
          objectId,
          materialReferenceId: materialReference!.id,
          materialReferenceGroupId: referenceGroupId(materialReference!),
          materialReferenceName: materialReference!.name,
          materialReferenceRole: isMultiviewReference(materialReference!)
            ? 'multi-view'
            : 'single-view',
          promptPolishEnabled: localRepaintSmartPolish,
          ...(localRepaintSmartPolish ? { prompt: effectivePrompt } : {}),
          image: { path: 'preview-white-filled.png', dataUrl: currentEffectDataUrl },
          materialImage: {
            path: `${generationId}-${materialReference!.id}-material-reference.png`,
            dataUrl: materialReferenceDataUrl,
          },
          mask: { path: `${generationId}-mask.png`, dataUrl: maskDataUrl },
          normalImage: { path: `${generationId}-normal.png`, dataUrl: normalDataUrl },
        },
        { signal: requestAbortController.signal, onStatus: personalRepaintEnabled ? (status) => {
          if (!pendingGeneration || requestAbortController!.signal.aborted) return;
          const labels: Record<string, string> = { uploading: '正在上传', queued: '排队中', running: '生成中', downloading: '正在接收结果' };
          pendingGeneration = { ...pendingGeneration, metadata: {
            ...pendingGeneration.metadata, personalRepaintStage: labels[status],
          } };
          syncGeneration(pendingGeneration);
        } : undefined },
      );
      // Reuse ModelView depth from gap detection; GPT captures it before submission.
      function captureRepaintDepth() {
        return captureCurrentDepthPreview({
          objectId,
          resolution: 2048,
          framing: 'current',
          aspect: captureAspect,
          cameraSnapshot: captureCameraSnapshot,
        }, 2048).catch((error) => {
          console.warn('[Liclick 3D Texture] Local repaint depth guard was not captured:', error);
          return undefined;
        });
      }
      depthPreviewPromise ??= captureRepaintDepth();
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
      if (!generation.resultUrl) throw new Error('局部重绘没有返回图片。');
      const personalResultStartedAt = personalRepaintEnabled ? performance.now() : 0;
      const preparedResult = await prepareRepaintResult(
        generation.resultUrl, capture.depthUrl, isGptLocalRepaint, requestAbortController.signal,
      );
      if (personalRepaintEnabled && generation.metadata.provider === 'autodl-personal') {
        generation.metadata.personalRequestPreparationMs = personalRequestPreparationMs;
        generation.metadata.personalResultPreparationMs = performance.now() - personalResultStartedAt;
      }
      if (isCancelledGeneration(pendingGeneration)) return false;
      const completedGeneration: Generation = {
        ...generation,
        mode: 'inpaint',
        // Keep one canonical client id from start through completion. Some
        // legacy ModelView responses used the remote id here, leaving the
        // persisted client-id record permanently `running` beside the result.
        id: pendingGeneration.id,
        resultUrl: preparedResult.resultUrl,
        captureId: generation.captureId ?? capture.id,
        metadata: {
          ...pendingGeneration.metadata,
          ...generation.metadata,
          workflow: 'local-repaint',
          objectMatrixWorld: captureObjectMatrixWorld,
          captureCamera: capture.camera,
          maskUrl: currentPaintMaskDataUrl,
          rawResultUrl: generation.resultUrl,
          ...preparedResult.metadata,
          resultComposition: 'direct-v1',
          paintMaskRevision: currentPaintMaskRevision,
          sourceColorMode: isGptLocalRepaint ? 'gpt-clay-selection-coverage-v1' : 'flat-clay-mask-v1',
          sourceComposition: isGptLocalRepaint ? 'gpt-clay-selection-coverage-v1' : 'flat-clay-mask-v1',
          completedAt: generation.metadata.completedAt ?? new Date().toISOString(),
        },
      };
      syncGeneration(completedGeneration);
      // metadata.maskUrl owns the exact snapshot used by this task. Keep the
      // single live mask intact until the user edits or explicitly clears it.
      lastCompletedLocalRepaintGenerationIdRef.current = completedGeneration.id;
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
              rawResultUrl: generation.resultUrl,
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
      if (requestAbortController?.signal.aborted) {
        setGenerateNotice(undefined);
        return false;
      }
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
      if (localRepaintPreparationAbortControllerRef.current === requestAbortController) {
        localRepaintPreparationAbortControllerRef.current = undefined;
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
      referenceSource: 'generated',
      generationId: generation.id,
    };
    const referenceStore = useReferenceStore.getState();
    const latestReferences = referenceStore.references;
    const source = latestReferences.find(reference => reference.id === singleReference.id);
    if (!source || useProjectStore.getState().currentProjectId !== currentProject?.id ||
      !latestPairedGenerations(useGenerationStore.getState().generations, currentProject?.id)
        .some(candidate => candidate.id === generation.id)) {
      throw new DOMException('多视图结果已过期。', 'AbortError');
    }
    const nextReferences = replacePairedReference(latestReferences, source, multiviewReference);
    referenceStore.setReferences(nextReferences);
    // A single-view reference is only the input to this job. Once its paired
    // multi-view result exists, make that result the active material reference
    // without changing the user's current generation tab. The paired image is
    // pipeline state, not a navigation request: single-view generation must
    // remain on single view after the background reference step completes.
    referenceStore.setSelectedReferences([nextReferences[0]!.id]);
    syncGeneration({ ...generation, metadata: { ...generation.metadata, referenceBindingApplied: true } });
    setProjectReferences(nextReferences);
    await saveCriticalProjectState({ references: nextReferences });
    return nextReferences[0]!;
  }
  persistPairedMultiviewReferenceRef.current = persistPairedMultiviewReference;

  async function generatePairedMultiviewReference(
    singleReference: ReferenceImage,
    onProgress?: (progress: number, label: string) => void,
  ) {
    const lighting = isMultiviewReference(singleReference);
    const groupId = referenceGroupId(singleReference);
    let pendingGeneration: Generation | undefined;
    setReferenceGroupGenerationState({ groupId, status: 'generating' });
    try {
      onProgress?.(8, '检查多视图参考');
      await requirePersonalLiclickAccount();
      onProgress?.(16, '提交多视图参考');
      const submittedPrompt = lighting ? '对当前多视图进行光照处理，保持基础色、视角和排版。' : await buildMultiviewPrompt(liclickPrompt);
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
          model: 'gpt-image-2.5-sunburst',
          resolution,
          referenceGroupId: groupId,
          sourceReferenceId: singleReference.id,
          referenceRole: 'multi-view',
          referenceOperation: lighting ? 'lighting' : undefined,
          referenceBindingSourceId: lighting ? singleReference.derivedFromReferenceId ?? singleReference.id : singleReference.id,
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
        model: 'gpt-image-2.5-sunburst',
        quality: lighting ? 'medium' : 'low',
        referencePipeline: lighting ? 'delight-only-v1' : 'six-view-delight-v1',
        pixelExactReferenceIds: lighting ? [singleReference.id] : undefined,
        aspectRatio: lighting ? 'auto' : '3:2',
        imageSize: lighting ? 'auto' : resolveRequestImageSize(imageSize, '3:2'),
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
          referenceOperation: lighting ? 'lighting' : undefined,
          referenceBindingSourceId: lighting ? singleReference.derivedFromReferenceId ?? singleReference.id : singleReference.id,
          serverSubmitted: true,
          serverJobId: submitted.metadata.serverJobId ?? submitted.id,
        },
      };
      onProgress?.(32, lighting ? '光照处理中' : '生成多视图参考');
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
      const completedGeneration = await waitForLiclickGeneration(alignedGeneration, (label) => onProgress?.(60, label));
      onProgress?.(88, '保存多视图参考');
      pairedGenerationPersistenceRef.current.add(completedGeneration.id);
      syncGeneration(completedGeneration);
      const multiviewReference = await persistPairedMultiviewReference(
        singleReference,
        completedGeneration,
      );
      await saveGenerationStateBestEffort();
      onProgress?.(100, '多视图参考已就绪');
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
      const message = getUserFacingGenerationError(error, multiviewGenerationFailureFallback);
      if (pendingGeneration) syncGeneration(createFailedGeneration(pendingGeneration, message));
      setReferenceGroupGenerationState({ groupId, status: 'failed', error: message });
      await saveGenerationStateBestEffort();
      finish();
      throw error;
    }
  }

  async function handleGeneratePairedMultiview(singleReference: ReferenceImage) {
    const lighting = isMultiviewReference(singleReference);
    if (workflowSubmissionLocked || submitLocksRef.current.size > 0) {
      notifyWorkflowOperationLocked();
      return;
    }
    submitLocksRef.current.add('single');
    setSubmissionActive(true);
    setTexturePipelineProgress({ active: true, progress: 4, label: lighting ? '准备光照处理' : '准备多视图参考' });
    setGenerateNotice({ tone: 'info', message: lighting ? '光照处理中' : '正在保存多视图参考。' });
    try {
      await generatePairedMultiviewReference(singleReference, updateTexturePipelineProgress);
      await waitForBrowserPaint();
      setGenerateNotice(undefined);
      pushToast({
        tone: 'success',
        title: lighting ? '光照处理完成' : '多视图已补全',
        description: '多视图参考已保存，可直接生成纹理贴图。',
      });
    } catch (error) {
      if (isGenerationCancellation(error)) {
        setGenerateNotice(undefined);
        return;
      }
      const message = getUserFacingGenerationError(error, multiviewGenerationFailureFallback);
      setGenerateNotice({ tone: 'error', message });
      pushToast({ tone: 'error', title: lighting ? '光照处理失败' : '多视图生成失败', description: message });
    } finally {
      submitLocksRef.current.delete('single');
      setSubmissionActive(submitLocksRef.current.size > 0);
      setTexturePipelineProgress(undefined);
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
    let releaseTextureRecoveryOwnership: (() => void) | undefined;
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
      if (currentProjectId)
        releaseTextureRecoveryOwnership = textureRecoveryOwnershipRef.current.begin(currentProjectId);
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
      if (isGenerationCancellation(error, pipelineAbortController?.signal)) {
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
      pushToast({ tone: 'error', title: '纹理生成流程中断', description: message });
      await saveGenerationStateBestEffort();
      finish();
      setTexturePipelineProgress(undefined);
    } finally {
      releaseTextureRecoveryOwnership?.();
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
      !isServerWorkspace(targetProject.workspaceMode) ||
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
    if (!targetProject || !isServerWorkspace(targetProject.workspaceMode)) return captures;
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
    if (!targetProject || !isServerWorkspace(targetProject.workspaceMode)) {
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
    if (!project || !isServerWorkspace(project.workspaceMode)) return;
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
        // Re-read on every CAS attempt: a deletion during upload/retry must
        // never be overwritten by the generation's earlier layer snapshot.
        layers: useProjectStore.getState().currentProjectId === targetProjectId
          ? useLayerStore.getState().layers
          : layers,
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
        workspaceMode: latest.workspaceMode,
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
      workspaceMode: savedProjectSnapshot.workspaceMode,
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
    const captureMaskTexture = usesCaptureMaskTextureProjection(generation);
    let projectedResultUrl = readableResultUrl;
    if (captureMaskTexture && generationCapture.maskUrl && !preservesGeneratedSourceAlpha(generation)) {
      try {
        // The panel preview is tightly cropped and cannot be projected without
        // changing camera UVs. Prepare the same cleaned edge colours in the
        // original capture frame, then bleed them outside the separate mask so
        // linear/mipmap sampling cannot pull the provider's dark backdrop into
        // the model silhouette.
        projectedResultUrl = await createCaptureMaskedProjectionImage(
          readableResultUrl,
          generationCapture.maskUrl,
        );
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
      targetProjectId?: string;
      shouldPersist: true;
    },
    options: { automatic?: boolean; capture?: Capture; saveObserver?: ProjectionSaveObserver } = {},
  ) {
    const {
      generation,
      existingLayer,
      generationCapture,
      layerId,
      projectedResultUrl,
      targetProjectId,
    } = prepared;
    let persistedGenerationCapture = generationCapture;
    if (currentProject && isServerWorkspace(currentProject.workspaceMode)) {
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
    const latestGeneration = useGenerationStore.getState().generations.find(
      (item) => item.id === generation.id,
    );
    if (
      options.automatic &&
      (!latestGeneration || isCancelledGeneration(generation) || latestGeneration.metadata.cancelled === true)
    ) return undefined;
    const currentExisting = useLayerStore
      .getState()
      .layers.find((layer) => layer.id === layerId || layer.generationId === generation.id);
    if (options.automatic && !currentExisting && hasProjectionCommit(latestGeneration ?? generation)) {
      return undefined;
    }
    // A manual replacement may target a layer that the user deleted while its
    // files were saving. New automatic layers have not entered the store yet,
    // so they can be committed safely only after every asset is durable.
    if (existingLayer && !currentExisting) return undefined;
    if (currentExisting && options.automatic) {
      // Another mounted panel may have committed while these assets uploaded.
      // Keep its image, eraser mask and visibility exactly as the user left them.
      await persistProjectionCommit(generation, currentExisting.id, syncGeneration,
        () => saveCriticalProjectState({}), options.saveObserver);
      return currentExisting;
    }
    let layer: Layer;
    if (currentExisting) {
      const captureMaskTexture = usesCaptureMaskTextureProjection(generation);
      layer = {
        ...currentExisting,
        imageUrl,
        maskUrl,
        maskSpace: maskUrl ? 'projection' : undefined,
        depthUrl,
        camera: persistedGenerationCapture.camera,
        projectionCoverageMode: captureMaskTexture
          ? 'capture-mask'
          : currentExisting.projectionCoverageMode,
        ignoreSourceAlpha: captureMaskTexture
          ? textureProjectionIgnoresSourceAlpha(generation) : currentExisting.ignoreSourceAlpha,
        minimumProjectionFacing: captureMaskTexture
          ? SINGLE_VIEW_MINIMUM_PROJECTION_FACING
          : currentExisting.minimumProjectionFacing,
        projectionVisibilityPolicy: captureMaskTexture
          ? 'standard'
          : currentExisting.projectionVisibilityPolicy,
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
    // Commit the receipt in the same save as the layer. Late polling and a
    // user deleting this layer must not turn a completed operation into a retry.
    try {
      await persistProjectionCommit(generation, layer.id, syncGeneration,
        () => saveCriticalProjectState({}), options.saveObserver);
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
    options: { automatic?: boolean; capture?: Capture; saveObserver?: ProjectionSaveObserver } = {},
  ) {
    // Remote multi-view jobs may finish together. Keep staging and persistence
    // in one transaction: if the next view enters the layer store while the
    // previous view is saving, that save snapshot contains a not-yet-persisted
    // blob layer and can be rejected or overwrite part of the six-view batch.
    const operation = projectedLayerCommitQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const latest = useGenerationStore.getState().generations.find(
          (item) => item.id === generation.id,
        );
        if (options.automatic) {
          if (isCancelledGeneration(generation) || latest?.metadata.cancelled === true) return undefined;
          const existing = useLayerStore.getState().layers.find(
            (layer) => layer.generationId === generation.id,
          );
          if (!existing && hasProjectionCommit(latest ?? generation)) return undefined;
        }
        const prepared = await stageGenerationAsProjectedLayer(generation, options);
        if (!prepared) return undefined;
        if (!prepared.shouldPersist) {
          if (!hasProjectionCommit(latest ?? generation)) {
            await persistProjectionCommit(latest ?? generation, prepared.layer.id, syncGeneration,
              () => saveCriticalProjectState({}), options.saveObserver);
          }
          return prepared.layer;
        }
        if (options.automatic && isCancelledGeneration(generation)) return undefined;
        return persistGenerationAsProjectedLayer(prepared, options);
      });
    projectedLayerCommitQueueRef.current = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  recoverSingleViewProjectionsRef.current = async () => {
    if (!currentProjectId || workflowSubmissionLocked || submitLocksRef.current.size > 0) return;
    const pending = useGenerationStore.getState().generations.filter((generation) =>
      needsSingleViewAutoProjection(generation, currentProjectId),
    );
    const pendingIds = new Set(pending.map((generation) => generation.id));
    for (const generationId of autoProjectionFailureNoticeRef.current.keys()) {
      if (!pendingIds.has(generationId)) autoProjectionFailureNoticeRef.current.delete(generationId);
    }
    const multiviewRecovery = pending.some((generation) => generation.mode === 'multiview');
    if (multiviewRecovery) useLayerStore.getState().beginProjectedPreviewBatch();
    try {
      for (const generation of pending) {
        if (
          useProjectStore.getState().currentProjectId !== currentProjectId ||
          submitLocksRef.current.size > 0
        ) return;
        try {
          const layer = await addGenerationAsProjectedLayer(generation, { automatic: true });
          if (layer) {
            autoProjectionFailureNoticeRef.current.delete(generation.id);
            dismissToastByDedupeKey(`auto-project:${generation.id}`);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : '请保持网络连接，无需重新生图。';
          if (autoProjectionFailureNoticeRef.current.get(generation.id) === message) continue;
          autoProjectionFailureNoticeRef.current.set(generation.id, message);
          console.warn('[generation] Automatic projection recovery remains pending', {
            generationId: generation.id,
            message,
          });
        }
      }
    } finally {
      if (multiviewRecovery) useLayerStore.getState().endProjectedPreviewBatch();
    }
  };

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
      previewProcessingMode === 'source-alpha'
        ? displayedPreviewGeneration.resultUrl
        : previewResultUrl ?? displayedPreviewGeneration.resultUrl,
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
      ref={generateActionRef}
      data-texture-onboarding="generate-texture"
      data-onboarding-generation={previewGeneration?.id}
      data-onboarding-view={displayedTexturePreviewMode}
      data-onboarding-complete={
        previewGeneration?.status === 'succeeded' &&
        Boolean(previewGeneration.resultUrl) &&
        isTextureMapGeneration(previewGeneration) &&
        hasProjectionCommit(previewGeneration) &&
        !workflowSubmissionLocked &&
        onboardingProjectionApplied
          ? 'true'
          : 'false'
      }
      className={`gen-action-surface ${
        canCancelGeneration ? 'grid grid-cols-[1fr_52px] gap-2' : ''
      }`}
    >
      {((isTextureMapTab && singleViewProvider === 'gpt') || isGptLocalRepaint) && (
        <GptGenerationOptions
          model={textureGptModel}
          quality={textureGptQuality}
          disabled={workflowConfigurationLocked || workflowSubmissionLocked}
          onModelChange={(value) => {
            const model = resolveGptTextureModel(value);
            updateGenerationSettings({ textureGptModel: model, textureGptQuality: resolveGptTextureQuality(textureGptQuality, model) });
          }}
          onQualityChange={(value) => updateGenerationSettings({ textureGptQuality: resolveGptTextureQuality(value, textureGptModel) })}
        />
      )}
      <Button
        className={`gen-action-button ${
          textureActionProgress ? 'disabled:opacity-100' : ''
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
          textureActionProgress
            ? {
                backgroundColor: '#25182f',
                backgroundImage:
                  'linear-gradient(90deg, rgba(242,76,193,0.96), rgba(132,81,255,0.98)), linear-gradient(90deg, #25182f, #322044)',
                backgroundPosition: 'left top, left top',
                backgroundRepeat: 'no-repeat',
                backgroundSize: `${textureActionProgress.progress}% 100%, 100% 100%`,
                transition: 'background-size 500ms ease, filter 200ms ease',
              }
            : undefined
        }
      >
        <span className="relative z-10">
          {textureActionProgress
            ? `${compactTextureProgressButtonLabel(textureActionProgress.label)} · ${Math.round(textureActionProgress.progress)}%`
            : generateActionRunning
              ? (personalRepaintEnabled && isLocalRepaintTab && typeof displayedPreviewGeneration?.metadata.personalRepaintStage === 'string'
                ? displayedPreviewGeneration.metadata.personalRepaintStage : t('generating'))
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
            contentAwareRepairActive
              ? '终止内容识别填补'
              : localRepaintPreparationCancellable
                ? '终止局部生图准备'
                : snapshotPreparing
                  ? '终止多视图快照'
                  : isTextureMapTab
                    ? '终止纹理贴图生成'
                    : isLocalRepaintTab
                      ? '终止局部重绘生成'
                      : '终止莉刻生图'
          }
          aria-label={
            contentAwareRepairActive
              ? '终止内容识别填补'
              : localRepaintPreparationCancellable
                ? '终止局部生图准备'
                : snapshotPreparing
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
            {isTextureMapTab && (
              <SegmentedControl<SingleViewProvider>
                value={singleViewProvider}
                options={[
                  { value: 'gpt', label: 'GPT', disabled: workflowConfigurationLocked || workflowSubmissionLocked },
                  { value: 'remote', label: 'ModelView', disabled: workflowConfigurationLocked || workflowSubmissionLocked },
                ]}
                onChange={(provider) => {
                  if (workflowConfigurationLocked || workflowSubmissionLocked) return;
                  setSingleViewProvider(provider);
                }}
                className="mb-2"
              />
            )}
            {isLocalRepaintTab && (
              <SegmentedControl<'modelview' | 'gpt'>
                value={generationSettings.localRepaintProvider}
                options={[
                  { value: 'modelview', label: personalRepaintEnabled ? '个人云端重绘' : '原局部重绘', disabled: workflowConfigurationLocked || workflowSubmissionLocked },
                  { value: 'gpt', label: 'GPT 局部重绘', disabled: workflowConfigurationLocked || workflowSubmissionLocked },
                ]}
                onChange={(localRepaintProvider) => updateGenerationSettings({ localRepaintProvider })}
                className="mb-2"
              />
            )}
            {(isLocalRepaintTab || (isTextureMapTab && singleViewProvider === 'remote')) && (
              <div className="mb-2 flex items-center justify-between gap-2 text-xs text-white/75">
                <span>法线黑色背景</span>
                <button
                  type="button"
                  role="switch"
                  aria-label="法线黑色背景"
                  aria-checked={normalBlackBackground}
                  disabled={workflowConfigurationLocked || workflowSubmissionLocked}
                  title="开：黑底；关：蓝底"
                  onClick={() => {
                    if (workflowConfigurationLocked || workflowSubmissionLocked) return;
                    setNormalBlackBackground(!normalBlackBackground);
                  }}
                  className={`relative h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-fuchsia-400 disabled:opacity-40 ${normalBlackBackground ? 'bg-fuchsia-500' : 'bg-white/20'}`}
                >
                  <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${normalBlackBackground ? 'left-0.5 translate-x-4' : 'left-0.5'}`} />
                </button>
              </div>
            )}
            {isLocalRepaintTab && isGptLocalRepaint && (
              <div className="mb-2 flex items-center justify-between gap-2 text-xs text-white/75">
                <span>使用材质参考图</span>
                <button
                  type="button"
                  role="switch"
                  aria-label="使用材质参考图"
                  aria-checked={gptRepaintUseMaterialReference}
                  disabled={workflowConfigurationLocked || workflowSubmissionLocked}
                  title={gptRepaintUseMaterialReference ? '结合图＋法线图＋选中的材质参考图' : '结合图＋法线图，不提交材质参考图'}
                  onClick={() => updateGenerationSettings({ gptRepaintUseMaterialReference: !gptRepaintUseMaterialReference })}
                  className={`relative h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-fuchsia-400 disabled:opacity-40 ${gptRepaintUseMaterialReference ? 'bg-fuchsia-500' : 'bg-white/20'}`}
                >
                  <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${gptRepaintUseMaterialReference ? 'left-0.5 translate-x-4' : 'left-0.5'}`} />
                </button>
              </div>
            )}
            {isLocalRepaintTab && !isGptLocalRepaint && !personalRepaintEnabled && (
              <div className="mb-2 flex items-center justify-between gap-2 text-xs text-white/75">
                <span>智能润色</span>
                <button
                  type="button"
                  role="switch"
                  aria-label="局部重绘智能润色"
                  aria-checked={localRepaintSmartPolish}
                  disabled={workflowConfigurationLocked || workflowSubmissionLocked}
                  title="关闭使用远端内置提示词；开启后按编辑要求润色并覆盖提示词"
                  onClick={() => updateGenerationSettings({ localRepaintSmartPolish: !localRepaintSmartPolish })}
                  className={`relative h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-fuchsia-400 disabled:opacity-40 ${localRepaintSmartPolish ? 'bg-fuchsia-500' : 'bg-white/20'}`}
                >
                  <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${localRepaintSmartPolish ? 'left-0.5 translate-x-4' : 'left-0.5'}`} />
                </button>
              </div>
            )}
          </div>
        )}
        <div className="gen-preview-body">
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
              ) : displayedTexturePreviewMode === 'repaint' && previewStatus === 'idle' ? (
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
                <div className="gen-preview-actions">
                  {isTextureMapGeneration(displayedPreviewGeneration) && (
                    <button
                      type="button"
                      className="gen-preview-apply"
                      title={t('addAsProjectedLayer')}
                      aria-label={t('addAsProjectedLayer')}
                      onClick={handleAddProjectedLayer}
                    >
                      <Layers className="h-4 w-4" />
                    </button>
                  )}
                  <button
                    type="button"
                    className="gen-preview-tool"
                    title={t('downloadImage')}
                    aria-label={t('downloadImage')}
                    onClick={() => void handleDownloadGenerationImage()}
                  >
                    <Download className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    data-task-preview-allowed="true"
                  className="gen-preview-tool"
                    title={t('view')}
                    aria-label={t('view')}
                    onClick={() => setPreviewImageOpen(true)}
                  >
                    <Maximize2 className="h-4 w-4" />
                  </button>
                </div>
              )}
              {previewStatus === 'running' && displayedPreviewGeneration && (
                <div className={previewProgressOverlayClassName}>
                  <GenerationProgressStatus generation={displayedPreviewGeneration} />
                </div>
              )}
              {previewStatus === 'preparing' && localRepaintPreparation && (
                  <div className={previewProgressOverlayClassName}>
                    <LocalRepaintPreparationStatus
                      startedAt={localRepaintPreparation.startedAt}
                      detail={localRepaintPreparation.detail}
                    />
                  </div>
                )}
              {previewStatus === 'error' && (
                <div className="gen-preview-error">
                  <div className="grid gap-1">
                    <div className="text-sm font-semibold">
                      {displayedPreviewCancelled ? '已终止' : '最近一次生成失败'}
                    </div>
                    <div className="text-xs text-white/66">
                      {displayedPreviewCancelled
                        ? '当前生成任务已停止等待，本次结果已丢弃。'
                        : typeof displayedPreviewGeneration?.metadata.error === 'string'
                          ? getUserFacingGenerationError(
                              displayedPreviewGeneration.metadata.error,
                              '请检查提示词、参考图或模型要求后重试。',
                            )
                          : '请检查提示词、参考图或模型要求后重试。'}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="generate-content-adaptive scrollbar-none gen-content-scroll">
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
                      option.id !== 'custom'
                        ? getCameraViewPresetDefinition(option.id).views.length
                        : selectedCameraViewPreset === 'custom'
                          ? cameraViews.length
                          : customCameraViewPreset.views.length;
                    return (
                      <button
                        key={option.id}
                        type="button"
                        role="tab"
                        aria-selected={selected}
                        className={`generate-camera-preset gen-camera-preset ${
                          selected
                            ? 'bg-white text-[#17131f] shadow-sm'
                            : 'bg-[#10101b] text-white/62 hover:bg-white/[0.065] hover:text-white'
                        }`}
                        onClick={() => handleCameraViewPresetSelect(option.id)}
                      >
                        <span className="block truncate">{option.title}</span>
                        <span
                          className={`gen-camera-caption ${
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
                        className="gen-camera-remove"
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
                    className="generate-camera-card-adaptive group gen-camera-add"
                    title={t('addCameraView')}
                    aria-label={t('addCameraView')}
                    onClick={handleAddCurrentCameraView}
                  >
                    <Plus className="h-7 w-7 transition-transform group-hover:scale-110" />
                  </button>
                </div>
              </section>
            )}

            {isTextureMapTab && singleViewProvider === 'remote' ? (
              <div className="gen-prompt-section text-xs text-white/55">
                ModelView · 使用远端内置提示词 · 多视图逐视角串行生成
              </div>
            ) : <section className="gen-prompt-section">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-white/88">
                  {isLocalRepaintTab
                    ? '补充提示词（可选）'
                    : '纹理提示词（可选）'}
                </span>
                {isLocalRepaintTab ? (
                  <span className="text-[11px] font-medium text-white/46">
                    {isGptLocalRepaint ? '法线辅助局部修复' : localRepaintSmartPolish ? '生成时优化提示词' : '使用远端内置提示词'}
                  </span>
                ) : (
                  <button
                    type="button"
                    title="智能润色"
                    aria-label="智能润色"
                    data-prompt-polish="true"
                    disabled={promptPolishing || workflowConfigurationLocked || !prompt.trim()}
                    onClick={() => void handlePromptPolish()}
                    className="gen-prompt-polish"
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
                disabled={isLocalRepaintTab && !isGptLocalRepaint && !localRepaintSmartPolish}
                aria-label={isLocalRepaintTab ? '补充提示词（可选）' : '纹理提示词（可选）'}
                data-task-preview-allowed="true"
                maxLength={
                  isLocalRepaintTab || (isTextureMapTab && singleViewProvider === 'remote')
                    ? 4096
                    : undefined
                }
                placeholder={
                  isLocalRepaintTab ? (!isGptLocalRepaint && !localRepaintSmartPolish ? '开启智能润色后可输入编辑要求' : '可输入本次编辑要求') : undefined
                }
                onChange={(event) => {
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
                className="generate-prompt-adaptive gen-prompt-input"
              />
            </section>}

            {(isTextureMapTab || (isLocalRepaintTab && (!isGptLocalRepaint || gptRepaintUseMaterialReference))) && (
              <section
                data-texture-onboarding="reference-images"
                data-onboarding-complete={activeSelectedReferenceIds.length > 0 ? 'true' : 'false'}
                className="order-2 grid shrink-0 gap-2"
              >
                <ReferenceGroupPicker
                  disabled={
                    workflowConfigurationLocked ||
                    workflowSubmissionLocked ||
                    displayedReferenceGroupGenerationState?.status === 'generating'
                  }
                  generationState={displayedReferenceGroupGenerationState}
                  onGenerateMultiview={(singleReference) =>
                    void handleGeneratePairedMultiview(singleReference)
                  }
                />
              </section>
            )}

            {generateNotice && (generateNotice.tone !== 'info' || !isVerboseGenerationNotice(generateNotice.message)) && (
              <div
                role={generateNotice.tone === 'error' ? 'alert' : 'status'}
                aria-live="polite"
                className={`gen-status-box ${
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
      {workspaceActive &&
        portalRoot &&
        generatePanelExpanded &&
        createPortal(
          <div
            className={`gen-action-dock ${
              dockDensity === 'normal' ? 'w-[312px]' : 'w-[292px]'
            }`}
          >
            {generateAction}
          </div>,
          portalRoot,
        )}
      {workspaceActive &&
        portalRoot &&
        (cancelConfirmGeneration ||
          cancelTextureSnapshotConfirmOpen ||
          cancelLocalRepaintPreparationConfirmOpen ||
          cancelContentAwareRepairConfirmOpen) &&
        createPortal(
          <div
            data-task-preview-allowed="true"
            className="gen-cancel-backdrop"
          >
            <div className="gen-cancel-dialog">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-liclick-pink">终止莉刻生图</div>
                  <div className="mt-1 text-lg font-bold">丢弃本次等待结果？</div>
                </div>
                <button
                  type="button"
                  className="gen-cancel-close"
                  onClick={() => {
                    setCancelConfirmGeneration(undefined);
                    setCancelTextureSnapshotConfirmOpen(false);
                    setCancelLocalRepaintPreparationConfirmOpen(false);
                    setCancelContentAwareRepairConfirmOpen(false);
                  }}
                  aria-label={t('close')}
                  title={t('close')}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <p className="text-sm leading-6 text-white/72">
                当前任务会立即从莉刻 3D Texture 面板中停止等待，生成结果不会写回预览、图层或项目。
                {cancelTextureSnapshotConfirmOpen
                  ? ' 当前快照准备会停止，且不会继续向远端提交纹理生图任务。'
                  : cancelLocalRepaintPreparationConfirmOpen
                    ? ' 当前局部生图准备和提示词优化会停止，且不会提交远端生图任务。'
                    : cancelContentAwareRepairConfirmOpen
                      ? ' 当前内容识别填补会停止，未完整发布的填补结果将被丢弃。'
                      : cancelConfirmGeneration?.metadata.provider === 'comfyui-local'
                        ? ' 同时会向本地 ComfyUI 发送中断请求。'
                        : cancelConfirmGeneration?.metadata.provider === 'modelview-seedvr2' ||
                            cancelConfirmGeneration?.metadata.provider === 'modelview-int8' ||
                            cancelConfirmGeneration?.metadata.provider ===
                              'modelview-single-view' ||
                            cancelConfirmGeneration?.metadata.provider ===
                              'modelview-single-view-inpaint'
                          ? ' ModelView 接口没有取消端点，本地会断开当前等待。'
                          : ' 同时会向生图后端发送取消请求。'}
              </p>
              <div className="mt-4 grid grid-cols-2 gap-2">
                <Button
                  variant="secondary"
                  className="h-10"
                  onClick={() => {
                    setCancelConfirmGeneration(undefined);
                    setCancelTextureSnapshotConfirmOpen(false);
                    setCancelLocalRepaintPreparationConfirmOpen(false);
                    setCancelContentAwareRepairConfirmOpen(false);
                  }}
                >
                  继续等待
                </Button>
                <Button
                  variant="danger"
                  className="h-10"
                  disabled={
                    (cancelTextureSnapshotConfirmOpen && texturePipelineCancelling) ||
                    (cancelContentAwareRepairConfirmOpen && contentAwareRepairCancelling)
                  }
                  onClick={
                    cancelTextureSnapshotConfirmOpen
                      ? confirmCancelTextureSnapshot
                      : cancelLocalRepaintPreparationConfirmOpen
                        ? confirmCancelLocalRepaintPreparation
                        : cancelContentAwareRepairConfirmOpen
                          ? confirmCancelContentAwareRepair
                          : confirmCancelCurrentGeneration
                  }
                  icon={<Square className="h-4 w-4 fill-current" />}
                >
                  终止并丢弃
                </Button>
              </div>
            </div>
          </div>,
          portalRoot,
        )}
      {workspaceActive &&
        portalRoot &&
        previewImageOpen &&
        displayedPreviewGeneration?.resultUrl &&
        createPortal(
          <button
            type="button"
            className="gen-zoom-backdrop"
            onClick={() => setPreviewImageOpen(false)}
            aria-label={t('close')}
          >
            <img
              src={previewResultUrl ?? displayedPreviewGeneration.resultUrl}
              alt=""
              className="gen-zoom-image"
              style={checkerBackgroundStyle}
              draggable={false}
            />
          </button>,
          portalRoot,
        )}
    </>
  );
}
