import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Banana,
  Bot,
  Download,
  ImagePlus,
  Layers,
  Maximize2,
  Plus,
  Sparkles,
  Square,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Panel } from '@/components/ui/Panel';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import {
  captureCurrentNormalPreview,
  captureCurrentView,
} from '@/engine/capture/captureCurrentView';
import { createMaskedProjectedImage } from '@/engine/projection/createMaskedProjectedImage';
import {
  createCaptureMaskedPreview,
  createSubjectFilledPreview,
} from '@/engine/localRepaint/resultPreviewUtils';
import {
  getObjectViewPresetDirection,
  type ObjectViewPreset,
} from '@/engine/scene/transformActions';
import { ReferenceImagePicker } from '@/components/panels/ReferenceImagePicker';
import { devLogin } from '@/services/authApiClient';
import { createComfyuiApiClient } from '@/services/comfyuiApiClient';
import { createModelviewApiClient } from '@/services/modelviewApiClient';
import { runFeishuLoginFlow } from '@/services/feishuLoginFlow';
import { ensurePersonalLiclickAccountForUser } from '@/services/liclickAccountBindingFlow';
import {
  getCachedPersonalLiclickAccountStatus,
  getPersonalLiclickAccountStatus,
  isPersonalLiclickAccountForEmail,
} from '@/services/liclickAccountApiClient';
import {
  resolveLiclickAuthStrategy,
  usesLocalAtlasLogin,
  usesPersonalLiclickAccount,
} from '@/services/liclickAuthStrategy';
import {
  createLiclickApiClient,
  LiclickApiError,
  type GenerationJobListItem,
  type LiclickAspectRatio,
  type LiclickImageModel,
  type LiclickImageSize,
} from '@/services/liclickApiClient';
import { getUserFacingGenerationError } from '@/services/generationErrorMessage';
import {
  hasTrackedModuleAction,
  trackModuleAction,
  trackModuleActionOnce,
  type TelemetryModule,
} from '@/services/telemetryClient';
import type { ReferencePreprocessingResult } from '@/services/referenceImagePreprocessor';
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
import type { CaptureNormalPreview, CaptureResolution } from '@/engine/capture/captureTypes';
import type { Generation } from '@/types/generation';
import type { Layer } from '@/types/layer';
import type { ReferenceImage } from '@/types/project';
import { getRegisteredObjectUrlBlob } from '@/utils/blobUrlRegistry';
import { createId } from '@/utils/id';
import { downloadImageAsset } from '@/utils/downloadImage';
import { encodeRgbaPngDataUrl } from '@/utils/encodeRgbaPng';
import { generationBelongsToProject, generationIdentityIds } from '@/utils/generationIdentity';
import {
  getGenerationStartedAt,
  mergeGenerationMetadataPreservingStartedAt,
} from '@/utils/generationTiming';
import {
  isWorkspaceAssetUrl,
  saveBlobAsset,
  saveDataUrlAsset,
  saveProject as saveWorkspaceProject,
  saveRemoteUrlAsset,
  urlToBlob,
  urlToDataUrl,
  WorkspaceApiError,
  type AssetCategory,
} from '@/services/workspaceApiClient';

type GenerateTab = 'single' | 'multiview' | 'repaint';
type GenerateMode = 'visible' | 'upscale';
type TextureMapViewMode = 'single-view' | 'multi-view';
type CameraViewPresetId = 'preset-1' | 'preset-2' | 'preset-3';
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
    label: '预设 1',
    description: '6 个正交视角：前、后、左、右、上、下',
    views: ['front', 'back', 'left', 'right', 'top', 'bottom'],
  },
  {
    id: 'preset-2',
    label: '预设 2',
    description: '6 个正交视角，加左前、右前、左后、右后',
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
    id: 'preset-3',
    label: '预设 3',
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
    viewUp:
      option.value === 'top'
        ? [0, 0, -1]
        : option.value === 'bottom'
          ? [0, 0, 1]
          : [0, 1, 0],
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
    <span className="relative block h-full w-full overflow-hidden rounded-[inherit] bg-[#252528]">
      {normalUrl ? (
        <img src={normalUrl} alt="" className="h-full w-full object-contain" />
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

function GenerationProgressStatus({
  generation,
  title,
}: {
  generation: Generation;
  title: string;
}) {
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
    <div className="grid justify-items-center gap-2 text-center" role="status" aria-live="polite">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/22 border-t-liclick-pink" />
      <div className="text-sm font-semibold">{title}</div>
      <div className="text-xs leading-5 text-white/68">
        {submitted ? '后台正在处理，完成后会自动返回' : '正在检查参考图并提交任务'}
        <span className="ml-1.5 tabular-nums">
          {minutes}:{seconds}
        </span>
      </div>
    </div>
  );
}

const textureMapDefaultPrompt = `任务类型：视角锁定的材质迁移，不是重新生成模型或场景。

【最高优先级：锁定参考图一】

参考图一是目标模型和最终画面的唯一空间依据。

必须严格保持参考图一的：
- 画布尺寸与宽高比
- 模型外轮廓和内部轮廓
- 几何形状、结构和部件边界
- 姿态、朝向和透视
- 相机位置、焦距和观察角度
- 主体中心、主体大小和画面占比
- 裁切范围、可见表面和遮挡关系

只允许改变目标模型可见表面内部的材质颜色与微观纹理。
禁止移动、缩放、旋转、重塑、补全、删减或重新解释目标模型。
目标模型的像素包围框和轮廓蒙版必须与参考图一重合。

【参考图二的用途】

参考图二只作为材质来源，不作为构图、几何、姿态、相机、背景或物体大小参考。

首先识别参考图二中与参考图一目标模型在语义、功能和部件位置上相对应的主体对象。
只提取该对应主体自身表面的材质。

不要简单复制参考图二中颜色最醒目、面积最大或细节最多的区域。

忽略参考图二中的：
- 背景、地面、阴影和环境
- 与目标模型无关的独立物体
- 容器中的内容物、填充物、液体、食物或货物
- 人物、植物、装饰物及临时摆放物
- 参考图一中不存在的附件和新增几何
- 多视角排版、文字、边框和拼图结构

独立物体或内容物不能被误当成目标模型的表面材质，也不能被压扁后铺到目标模型上。

【语义对应与材质映射】

按照“对应部件映射到对应部件”的原则迁移材质：

- 外壳材质只映射到外壳
- 边缘材质只映射到对应边缘
- 把手、框架、面板等材质只映射到参考图一中已有的对应部件
- 不同部件存在不同材质时，保持合理的材质分区
- 参考图一中没有对应几何的内容不得出现在最终图中
- 不得把一个局部材质无差别铺满整个目标模型
- 纹理方向、尺度和密度必须符合目标表面的走向与尺寸
- 材质变化只能改变表面外观，不能改变轮廓或制造新的几何凸起

如果参考图二包含多个视角，这些视角只能用于理解同一主体的材质，不得复制其多视角布局。

【Base Color / Albedo 输出要求】

输出为目标模型当前视角下的无光照 Base Color／Albedo 材质投射结果。

保留：
- 材料自身固有颜色
- 颜色斑驳、颗粒、纤维、木纹、石纹、磨损、污渍等真实颜色细节
- 与材料固有颜色有关的细微变化

去除：
- 直接光照和明暗塑形
- 阴影、投影和环境遮蔽
- 镜面反射、强高光和轮廓光
- 环境色渐变和摄影棚反光
- 烘焙光影及由光照产生的明暗信息

不要在 Base Color 中编码粗糙度、金属反射、高光或凹凸信息。
粗糙度、法线和高度信息应作为独立贴图处理。

【输出限制】

只输出参考图一当前视角中的同一个目标模型。
不得出现新物体、内容物、地面、网格、文字、边框、拼图或多视角结果。
模型外部区域保持与参考图一完全一致，不得重新生成背景。`;

function buildTextureMapPrompt(userPrompt: string) {
  const trimmedPrompt = userPrompt.trim();
  return trimmedPrompt
    ? `${textureMapDefaultPrompt}\n\n用户补充材质要求：${trimmedPrompt}`
    : textureMapDefaultPrompt;
}

const multiviewDefaultPrompt = `以输入图片中的主要物体为唯一参考，生成一张用于3D建模的六视图展示图。

严格保持物体的造型、比例、结构、零件、颜色、材质和纹理一致。所有视图必须来自同一个结构固定的三维物体。不可见区域根据对称性和结构逻辑进行最少量补全，不要添加参考图中不存在的细节。

输出横向2×3布局：
第一排：正面、左前45°、右前45°；
第二排：左侧、右侧、顶部。

正交视图减少透视畸变，所有物体保持相同比例、状态和方向，完整居中且不裁切。使用纯黑背景和统一的柔和棚拍光照。

不要出现结构变化、零件错位、重复视角、背景元素、文字、边框、Logo或水印。`;

function buildMultiviewPrompt(userPrompt: string) {
  const trimmedPrompt = userPrompt.trim();
  return trimmedPrompt
    ? `${multiviewDefaultPrompt}\n\n用户补充要求：${trimmedPrompt}`
    : multiviewDefaultPrompt;
}

function isTextureMapGeneration(generation: Generation) {
  return generation.metadata.workflow === 'texture-map';
}

function isLocalRepaintGeneration(generation: Generation) {
  return generation.metadata.workflow === 'local-repaint';
}

function getGenerationChannel(generation: Generation): GenerateTab {
  if (isTextureMapGeneration(generation)) return 'multiview';
  if (isLocalRepaintGeneration(generation)) return 'repaint';
  return 'single';
}

function generationMatchesTab(generation: Generation, tab: GenerateTab) {
  if (tab === 'multiview') return isTextureMapGeneration(generation);
  if (tab === 'repaint') return isLocalRepaintGeneration(generation);
  return !isTextureMapGeneration(generation) && !isLocalRepaintGeneration(generation);
}

function isRunningGeneration(generation?: Generation) {
  return Boolean(
    generation &&
    !generation.resultUrl &&
    (generation.status === 'queued' || generation.status === 'running'),
  );
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

function loadImageElement(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new window.Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('无法读取局部重绘输入图。'));
    image.src = url;
  });
}

async function createComfyInpaintInputImage(
  sourceUrl: string,
  maskUrl: string,
  width: number,
  height: number,
) {
  const [sourceImage, maskImage] = await Promise.all([
    loadImageElement(sourceUrl),
    loadImageElement(maskUrl),
  ]);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('无法创建局部重绘输入画布。');
  context.drawImage(sourceImage, 0, 0, width, height);
  const source = context.getImageData(0, 0, width, height);

  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = width;
  maskCanvas.height = height;
  const maskContext = maskCanvas.getContext('2d', { willReadFrequently: true });
  if (!maskContext) throw new Error('无法读取局部重绘蒙版。');
  maskContext.imageSmoothingEnabled = true;
  maskContext.imageSmoothingQuality = 'high';
  maskContext.drawImage(maskImage, 0, 0, width, height);

  // The selection canvas is smaller than the 2048px ComfyUI input. Smooth only
  // the enlarged contour, then keep a very narrow sub-pixel coverage band. A hard
  // 0/255 threshold turns every source pixel into a multi-pixel stair step again.
  const sourceWidth = Math.max(1, maskImage.naturalWidth || maskImage.width);
  const sourceHeight = Math.max(1, maskImage.naturalHeight || maskImage.height);
  const upscale = Math.max(width / sourceWidth, height / sourceHeight);
  let sampledMaskContext = maskContext;
  if (upscale > 1.05) {
    const contourCanvas = document.createElement('canvas');
    contourCanvas.width = width;
    contourCanvas.height = height;
    const contourContext = contourCanvas.getContext('2d', { willReadFrequently: true });
    if (contourContext) {
      contourContext.filter = `blur(${Math.min(3, Math.max(0.75, upscale * 0.65))}px)`;
      contourContext.drawImage(maskCanvas, 0, 0);
      contourContext.filter = 'none';
      sampledMaskContext = contourContext;
    }
  }
  const mask = sampledMaskContext.getImageData(0, 0, width, height).data;
  for (let offset = 0; offset < source.data.length; offset += 4) {
    const coverage =
      (Math.max(mask[offset], mask[offset + 1], mask[offset + 2]) * (mask[offset + 3] / 255)) / 255;
    const edgeCoverage = Math.max(0, Math.min(1, (coverage - 0.42) / 0.16));
    const antialiasedCoverage = edgeCoverage * edgeCoverage * (3 - 2 * edgeCoverage);
    // ComfyUI derives its MASK from alpha. The custom straight-RGBA encoder keeps
    // the original RGB below transparent pixels, so this one-pixel coverage edge
    // smooths the mask without adding a light/black outline to the IMAGE output.
    source.data[offset + 3] = Math.round((1 - antialiasedCoverage) * 255);
  }
  return encodeRgbaPngDataUrl(width, height, source.data);
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

export function GeneratePanel() {
  const t = useT();
  const [tab, setTab] = useState<GenerateTab>('multiview');
  const [previewImageOpen, setPreviewImageOpen] = useState(false);
  const [subjectFilledPreview, setSubjectFilledPreview] = useState<{
    sourceUrl: string;
    maskUrl?: string;
    previewUrl: string;
  }>();
  const [selectedCameraViewPreset, setSelectedCameraViewPreset] =
    useState<CameraViewPresetId | null>('preset-1');
  const [cameraViews, setCameraViews] = useState<CameraViewItem[]>(() =>
    createCameraViewsForPreset('preset-1', t),
  );
  const [activeCameraViewId, setActiveCameraViewId] = useState('front');
  const [aiOneClickConfirmOpen, setAiOneClickConfirmOpen] = useState(false);
  const [textureMapViewMode, setTextureMapViewMode] = useState<TextureMapViewMode>('single-view');
  const [cameraViewPreviews, setCameraViewPreviews] = useState<CameraViewPreviewMap>({});
  const [capturingCameraViews, setCapturingCameraViews] = useState<Set<string>>(() => new Set());
  const cameraViewPreviewsRef = useRef<CameraViewPreviewMap>({});
  const capturingCameraViewsRef = useRef<Set<string>>(new Set());
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
  const currentProject = useProjectStore((state) =>
    state.projects.find((project) => project.id === state.currentProjectId),
  );
  const currentProjectId = currentProject?.id;
  const isTextureMapTab = tab === 'multiview';
  const isLocalRepaintTab = tab === 'repaint';
  const updateCurrentProject = useProjectStore((state) => state.updateCurrentProject);
  const updateProjectById = useProjectStore((state) => state.updateProjectById);
  const generationSettings = {
    ...defaultImageGenerationSettings,
    ...currentProject?.settings.imageGeneration,
  };
  const liclickPrompt = generationSettings.liclickPrompt ?? generationSettings.prompt ?? '';
  const textureMapPrompt = generationSettings.textureMapPrompt ?? '';
  const localRepaintPrompt = generationSettings.localRepaintPrompt ?? '';
  const prompt = isTextureMapTab
    ? textureMapPrompt
    : isLocalRepaintTab
      ? localRepaintPrompt
      : liclickPrompt;
  const imageModel = generationSettings.model as LiclickImageModel;
  const aspectRatio = generationSettings.aspectRatio as LiclickAspectRatio;
  const imageSize = generationSettings.imageSize as LiclickImageSize;
  const count = generationSettings.count;
  const selectedReferenceIds = useReferenceStore((state) => state.selectedReferenceIds);
  const references = useReferenceStore((state) => state.references);
  const setSelectedReferences = useReferenceStore((state) => state.setSelectedReferences);
  const addReferences = useReferenceStore((state) => state.addReferences);
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
  const addProjectCapture = useProjectStore((state) => state.addCapture);
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
  const paintMaskDataUrl = useSceneStore((state) => state.paintMaskDataUrl);
  const paintMaskHasContent = useSceneStore((state) => state.paintMaskHasContent);
  const activeReferences = references;
  const activeReferenceIds = useMemo(
    () => new Set(references.map((reference) => reference.id)),
    [references],
  );
  const activeSelectedReferenceIds = useMemo(
    () => selectedReferenceIds.filter((id) => activeReferenceIds.has(id)),
    [activeReferenceIds, selectedReferenceIds],
  );
  const resolution = useSettingsStore((state) => state.resolution);
  const pushToast = useToastStore((state) => state.pushToast);
  const dismissToastByDedupeKey = useToastStore((state) => state.dismissToastByDedupeKey);
  const authStatus = useAuthStore((state) => state.status);
  const providerStatus = useAuthStore((state) => state.providerStatus);
  const setAuthenticated = useAuthStore((state) => state.setAuthenticated);
  useEffect(() => {
    if (authStatus !== 'authenticated' || !usesPersonalLiclickAccount(providerStatus)) return;
    void getPersonalLiclickAccountStatus().catch(() => undefined);
  }, [authStatus, providerStatus]);
  // Each workflow owns its submission lifecycle. A repaint request must not
  // block texture-map or ordinary image generation (and vice versa).
  const submitLocksRef = useRef(new Set<GenerateTab>());
  const cancelledGenerationIdsRef = useRef(new Set<string>());
  const generationPollFailureCountsRef = useRef(new Map<string, number>());
  const generationAbortControllersRef = useRef(new Map<string, AbortController>());
  const projectedLayerCommitQueueRef = useRef<Promise<void>>(Promise.resolve());
  const portalRoot = typeof document === 'undefined' ? undefined : document.body;
  const tabGenerations = generations.filter((generation) => {
    const projectId =
      typeof generation.metadata.projectId === 'string' ? generation.metadata.projectId : undefined;
    const belongsToProject = !currentProject?.id || !projectId || projectId === currentProject.id;
    return belongsToProject && generationMatchesTab(generation, tab);
  });
  const activeProjectGeneration = tabGenerations.find((generation) =>
    isRunningGeneration(generation),
  );
  const previewGeneration = activeProjectGeneration ?? tabGenerations[0];
  const previewIsGenerating = isRunningGeneration(previewGeneration);
  const previewFailed = previewGeneration?.status === 'failed';
  const previewCancelled = previewGeneration?.metadata.cancelled === true;
  const canCancelGeneration = Boolean(activeProjectGeneration);
  const previewRawResultUrl = previewGeneration?.resultUrl;
  const previewCapture = previewGeneration?.captureId
    ? lastCapture?.id === previewGeneration.captureId
      ? lastCapture
      : currentProject?.captures.find((capture) => capture.id === previewGeneration.captureId)
    : previewGeneration &&
        isLocalRepaintGeneration(previewGeneration) &&
        lastCapture &&
        (!previewGeneration.metadata.objectId ||
          previewGeneration.metadata.objectId === lastCapture.objectId)
      ? lastCapture
      : undefined;
  const capturePreviewMaskUrl =
    previewGeneration &&
    (isLocalRepaintGeneration(previewGeneration) || isTextureMapGeneration(previewGeneration))
      ? previewCapture?.maskUrl
      : undefined;
  const previewProcessingMode = previewGeneration
    ? isLocalRepaintGeneration(previewGeneration)
      ? capturePreviewMaskUrl
        ? 'capture-mask'
        : 'dark-background'
      : isTextureMapGeneration(previewGeneration)
        ? capturePreviewMaskUrl
          ? 'capture-mask'
          : undefined
        : undefined
    : undefined;
  const previewResultUrl =
    previewRawResultUrl &&
    subjectFilledPreview?.sourceUrl === previewRawResultUrl &&
    subjectFilledPreview.maskUrl === capturePreviewMaskUrl
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
        : createSubjectFilledPreview(
            sourceUrl,
            previewProcessingMode === 'dark-background' ? 'dark-only' : 'neutral',
          );
    void previewPromise
      .then((previewUrl) => {
        if (!cancelled)
          setSubjectFilledPreview({
            sourceUrl,
            maskUrl: capturePreviewMaskUrl,
            previewUrl,
          });
      })
      .catch((error) => {
        if (cancelled) return;
        console.warn('[Liclick 3D Texture] Could not prepare generated image preview.', error);
        setSubjectFilledPreview({
          sourceUrl,
          maskUrl: capturePreviewMaskUrl,
          previewUrl: sourceUrl,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [capturePreviewMaskUrl, previewProcessingMode, previewRawResultUrl]);

  const notifyReferencePreprocessed = useCallback(
    (result: ReferencePreprocessingResult) => {
      const originalMiB = (result.originalBytes / 1024 / 1024).toFixed(1);
      const processedMiB = (result.processedBytes / 1024 / 1024).toFixed(1);
      const keptOriginalResolution =
        result.originalWidth === result.processedWidth &&
        result.originalHeight === result.processedHeight;
      const resolutionDescription = keptOriginalResolution
        ? `保留原始 ${result.processedWidth}×${result.processedHeight} 分辨率`
        : `分辨率由 ${result.originalWidth}×${result.originalHeight} 调整为 ${result.processedWidth}×${result.processedHeight}`;
      const qualityPercent = Math.round(result.outputQuality * 100);
      pushToast({
        tone: 'warning',
        title: '参考图超限，已自动处理',
        description: `${result.name} 已从 ${originalMiB} MB 优化为 ${processedMiB} MB；${resolutionDescription}，WebP 编码质量 ${qualityPercent}%，将按原构图继续生成。`,
        dedupeKey: `atlas-reference-preprocessed:${result.id}`,
      });
    },
    [pushToast],
  );

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
      const resultUrl = workspaceResultUrl ?? existing?.resultUrl ?? fallback?.resultUrl ?? job.resultUrl;
      const status = resultUrl ? ('succeeded' as const) : job.status;
      const generation: Generation = {
        id: existing?.id ?? fallback?.id ?? job.clientGenerationId ?? job.id,
        mode: existing?.mode ?? fallback?.mode ?? 'single',
        prompt: existing?.prompt || fallback?.prompt || job.prompt,
        negativePrompt: existing?.negativePrompt ?? fallback?.negativePrompt,
        referenceIds:
          existing?.referenceIds.length
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
      const needsPersist = Boolean(generation.resultUrl) && !isWorkspaceAssetUrl(generation.resultUrl);
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
        retry =
          !(error instanceof LiclickApiError) ||
          error.status === 429 ||
          error.status >= 500;
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
    (generationToFail: Generation, message: string) => {
      const userMessage = getUserFacingGenerationError(message);
      syncGeneration(createFailedGeneration(generationToFail, userMessage));
      finish();
      setGenerateNotice({
        tone: 'error',
        message: userMessage,
      });
      pushToast({
        tone: 'error',
        title: isTextureMapGeneration(generationToFail) ? t('textureMapFailed') : '图片生成失败',
        description: userMessage,
        dedupeKey: `generation-failed:${generationToFail.id}`,
      });
    },
    [finish, pushToast, setGenerateNotice, syncGeneration, t],
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
    if (!isTextureMapTab || textureMapViewMode !== 'multi-view' || !captureObjectId)
      return undefined;
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
  }, [cameraViews, captureObjectId, isTextureMapTab, pushToast, textureMapViewMode]);

  useEffect(() => {
    if (!previewGeneration || previewGeneration.resultUrl) return undefined;
    if (previewGeneration.status !== 'queued' && previewGeneration.status !== 'running')
      return undefined;
    const generationToPoll = previewGeneration;
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
            markGenerationFailed(latest, '生图任务没有成功提交到莉刻后台，请重新生成。');
            window.dispatchEvent(new Event(IMMEDIATE_PROJECT_SAVE_EVENT));
          }
        }, remaining);
        return () => window.clearTimeout(submissionTimeoutId);
      }
      markGenerationFailed(generationToPoll, '生图任务没有成功提交到莉刻后台，请重新生成。');
      window.dispatchEvent(new Event(IMMEDIATE_PROJECT_SAVE_EVENT));
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
      if (showRecovered && failureCount >= 2) {
        pushToast({
          tone: 'success',
          title: '生成任务连接已恢复',
          description: '后台任务仍在正常运行，结果完成后会自动回到预览区。',
          dedupeKey: pollToastKey,
        });
      }
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
          pushToast({
            tone: 'warning',
            title: '生成服务正在自动重试',
            description: result.message,
            dedupeKey: pollToastKey,
          });
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
          pushToast({
            tone: 'success',
            title: '图片生成完成',
            description: '刷新前的莉刻生成任务已恢复结果。',
            dedupeKey: `generation-restored:${generation.id}`,
          });
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
          pushToast({
            tone: 'warning',
            title: '生成任务正在自动重连',
            description: retryMessage,
            dedupeKey: pollToastKey,
          });
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
  }, [dismissToastByDedupeKey, markGenerationFailed, previewGeneration, pushToast, syncGeneration]);

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

  function handleCameraViewSelect(view: CameraViewItem) {
    if (!captureObjectId) {
      pushToast({ tone: 'warning', title: t('importModelFirst') });
      return;
    }
    setActiveCameraViewId(view.id);
  }

  function handleCameraViewPresetSelect(presetId: CameraViewPresetId) {
    const nextViews = createCameraViewsForPreset(presetId, t);
    cameraViewPreviewsRef.current = {};
    capturingCameraViewsRef.current = new Set();
    setCameraViewPreviews({});
    setCapturingCameraViews(new Set());
    setSelectedCameraViewPreset(presetId);
    setCameraViews(nextViews);
    setActiveCameraViewId(nextViews[0]?.id ?? '');
  }

  function handleDeleteCameraView(viewId: string) {
    setSelectedCameraViewPreset(null);
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
    setSelectedCameraViewPreset(null);
    setCameraViews((current) => [...current, nextView]);
    setActiveCameraViewId(id);
    pushToast({ tone: 'success', title: '已添加当前 MVP 视角' });
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
      cancelledGenerationIdsRef.current.has(generation.id) ||
      cancelledGenerationIdsRef.current.has(jobId)
    );
  }

  function cancelCurrentGeneration() {
    const generationToCancel = activeProjectGeneration;
    if (!generationToCancel) return;
    setCancelConfirmGeneration(generationToCancel);
  }

  function confirmCancelCurrentGeneration() {
    const generationToCancel = cancelConfirmGeneration ?? activeProjectGeneration;
    if (!generationToCancel) return;
    setCancelConfirmGeneration(undefined);
    if (!isRunningGeneration(generationToCancel)) return;
    const jobId = getGenerationJobId(generationToCancel);
    const isTextureMap = isTextureMapGeneration(generationToCancel);
    const isLocalRepaint = isLocalRepaintGeneration(generationToCancel);
    const isComfyGeneration = generationToCancel.metadata.provider === 'comfyui-local';
    const isModelviewGeneration =
      generationToCancel.metadata.provider === 'modelview-seedvr2';
    cancelledGenerationIdsRef.current.add(generationToCancel.id);
    cancelledGenerationIdsRef.current.add(jobId);
    generationAbortControllersRef.current.get(generationToCancel.id)?.abort();
    generationAbortControllersRef.current.delete(generationToCancel.id);
    const cancelledGeneration: Generation = {
      ...generationToCancel,
      status: 'failed',
      metadata: {
        ...generationToCancel.metadata,
        cancelled: true,
        error: isTextureMap
          ? '用户已终止纹理贴图生成任务。'
          : isLocalRepaint
            ? '用户已终止局部重绘生成任务。'
            : '用户已终止莉刻生图任务。',
        completedAt: new Date().toISOString(),
      },
    };
    submitLocksRef.current.delete(getGenerationChannel(generationToCancel));
    syncGeneration(cancelledGeneration);
    finish();
    setGenerateNotice({
      tone: 'info',
      message: isTextureMap
        ? '已终止当前纹理贴图生成任务，并丢弃本次等待结果。'
        : isLocalRepaint
          ? '已终止当前局部重绘生成任务。'
          : '已终止当前莉刻生图任务。',
    });
    const cancelRequest = isModelviewGeneration
      ? Promise.resolve()
      : isComfyGeneration
        ? createComfyuiApiClient().cancelTextureMap(jobId)
        : createLiclickApiClient().cancelGenerationJob(jobId);
    void cancelRequest.catch((error) => {
      console.warn('[Liclick 3D Texture] Could not cancel remote generation job:', error);
      pushToast({
        tone: 'warning',
        title: '本地已终止',
        description:
          error instanceof Error ? error.message : '后端取消请求失败，但本地已停止等待。',
        dedupeKey: `generation-cancel-warning:${jobId}`,
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
        description: usesLocalAtlasLogin(activeProviderStatus)
          ? '本地版使用同一个飞书/Atlas 登录完成身份验证和莉刻生图。'
          : '服务器版使用飞书验证员工身份，莉刻生图账号将在当前电脑单独验证。',
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
    const wasAuthenticated = useAuthStore.getState().status === 'authenticated';
    if (!(await requireFeishuLogin())) return false;
    let activeProviderStatus = useAuthStore.getState().providerStatus;
    try {
      activeProviderStatus ??= await useAuthStore.getState().refreshProviderStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法确认当前登录方式。';
      setGenerateNotice({ tone: 'error', message });
      pushToast({
        tone: 'error',
        title: '登录方式不可用',
        description: message,
        dedupeKey: 'liclick-auth-strategy-unavailable',
      });
      return false;
    }
    const authStrategy = resolveLiclickAuthStrategy(activeProviderStatus);
    // The local build follows 7515224: its Atlas session owns both identity
    // and generation, so it must never enter the server-only account binder.
    if (authStrategy === 'atlas-workspace') return true;
    if (authStrategy !== 'personal-local-component') {
      const message = '当前登录方式尚未配置完成，请刷新页面或重新登录后再试。';
      setGenerateNotice({ tone: 'error', message });
      pushToast({
        tone: 'error',
        title: '登录方式不可用',
        description: message,
        dedupeKey: 'liclick-auth-strategy-unresolved',
      });
      return false;
    }
    if (!wasAuthenticated) {
      setGenerateNotice({
        tone: 'info',
        message: '飞书登录已完成。请再次点击生成，以绑定此电脑上的个人莉刻账号。',
      });
      return false;
    }
    const authenticatedUser = useAuthStore.getState().user;
    if (!authenticatedUser) return false;
    const expectedEmail = authenticatedUser.email?.trim();
    if (
      isPersonalLiclickAccountForEmail(
        getCachedPersonalLiclickAccountStatus(),
        authenticatedUser.authSource === 'dev-mock' ? undefined : expectedEmail,
      )
    ) return true;

    try {
      setGenerateNotice({
        tone: 'warning',
        message: '正在检查并绑定此电脑上的个人莉刻账号。',
      });
      pushToast({
        tone: 'info',
        title: '绑定个人莉刻账号',
        description: '生图任务和费用将归属你登录的莉刻账号；凭证只保存在这台电脑。',
        dedupeKey: 'liclick-account-binding-required',
      });
      const account = await ensurePersonalLiclickAccountForUser(authenticatedUser, {
        onStatus: (message) => setGenerateNotice({ tone: 'info', message }),
      });
      setGenerateNotice({
        tone: 'info',
        message: `已绑定个人莉刻账号${account.email ? `：${account.email}` : ''}，正在继续提交任务。`,
      });
      pushToast({
        tone: 'success',
        title: '个人莉刻账号绑定成功',
        description: account.email
          ? `当前电脑将使用 ${account.email} 提交莉刻生图任务。`
          : '当前电脑已使用你的个人莉刻账号提交生图任务。',
        dedupeKey: 'liclick-account-binding-success',
      });
      return true;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : '个人莉刻账号绑定失败，请重新尝试。';
      setGenerateNotice({ tone: 'error', message });
      pushToast({
        tone: 'error',
        title: '个人莉刻账号不可用',
        description: message,
        dedupeKey: 'liclick-account-binding-failed',
      });
      return false;
    }
  }

  async function captureTextureMapReferenceView() {
    return captureTextureMapCameraView();
  }

  async function getTextureMapMultiviewCaptures(views: CameraViewItem[]) {
    const captures: Partial<Record<string, Capture>> = {};
    for (const view of views) {
      if (captures[view.id]) continue;
      setCapturingCameraViews((current) => new Set([...current, view.id]));
      try {
        const capture = await captureTextureMapCameraView(view, { setAsLastCapture: false });
        captures[view.id] = capture;
      } finally {
        setCapturingCameraViews((current) => {
          const next = new Set(current);
          next.delete(view.id);
          return next;
        });
      }
    }
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
  ) {
    if (!captureObjectId) throw new Error(t('importModelFirst'));
    if (requestedViews.length === 0) throw new Error('请先添加至少一个模型视角。');
    if (!(await requirePersonalLiclickAccount())) return;
    const objectId = captureObjectId;
    const object = objects.find((item) => item.id === objectId);
    const texturePrompt = buildTextureMapPrompt(prompt);
    const objectMatrixWorld = getImportedModelMatrixWorld(objectId);
    const capturedViews = await getTextureMapMultiviewCaptures(requestedViews);
    if (capturedViews.length === 0) throw new Error('无法捕获多视图模型方向。');
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
    updateProjectById(currentProject.id, { captures: persistedCaptures });
    const persistedCapturesById = new Map(
      persistedCaptures.map((capture) => [capture.id, capture]),
    );
    const viewCaptures = capturedViews.map((view) => ({
      ...view,
      capture: persistedCapturesById.get(view.capture.id) ?? view.capture,
    }));
    setGenerateNotice({
      tone: 'info',
      message: `正在提交 ${viewCaptures.length} 个多视图纹理贴图任务。`,
    });

    const client = createLiclickApiClient({ onReferencePreprocessed: notifyReferencePreprocessed });
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
        mode: 'multiview',
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
          multiview: true,
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
      const message = getUserFacingGenerationError(
        error,
        '多视图相机数据保存失败，任务尚未提交，请稍后重试。',
      );
      pendingGenerations.forEach(({ pendingGeneration }) => {
        syncGeneration(createFailedGeneration(pendingGeneration, message));
      });
      finish();
      throw error;
    }

    const results = await Promise.allSettled(
      pendingGenerations.map(({ capture, generationId, modelViewReference }) =>
        client.generateTextureSingleView({
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
        }),
      ),
    );

    const completedGenerations: Generation[] = [];
    let projectedGenerationCount = 0;
    const submittedGenerations: Generation[] = [];
    results.forEach((result, index) => {
      const pending = pendingGenerations[index];
      if (!pending) return;
      if (result.status === 'fulfilled') {
        const submittedGeneration: Generation = {
          ...result.value,
          mode: 'multiview',
          metadata: {
            ...mergeGenerationMetadataPreservingStartedAt(
              pending.pendingGeneration.metadata,
              result.value.metadata,
            ),
            workflow: 'texture-map',
            objectMatrixWorld,
            materialReferenceId: materialReference.id,
            modelViewReferenceId: pending.modelViewReference.id,
            multiview: true,
            autoProjectExpected: true,
            cameraView: pending.cameraView,
            cameraViewId: pending.viewId,
            cameraViewLabel: pending.label,
            serverSubmitted: true,
            serverJobId: result.value.metadata.serverJobId ?? result.value.id,
            alphaMode: 'pending-guided-foreground-matte',
          },
        };
        submittedGenerations.push(submittedGeneration);
        syncGeneration(submittedGeneration);
        return;
      }
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
    const completionResults = await Promise.allSettled(
      submittedGenerations.map(async (generation) => {
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
          pushToast({
            tone: 'warning',
            title: `${String(completed.metadata.cameraViewLabel ?? '当前')}视角已生成，等待重新投影`,
            description: message,
            dedupeKey: `texture-map-view-projection-failed:${completed.id}`,
          });
          return { generation: completedWithProjectionError, projected: false };
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
        syncGeneration(
          createFailedGeneration(
            submitted,
            result.reason instanceof Error ? result.reason.message : '多视角纹理贴图任务失败。',
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
      .layers.filter((layer) => layer.generationId && completedGenerationIds.has(layer.generationId))
      .length;
    await saveGenerationStateBestEffort();

    setGenerateNotice(undefined);
    pushToast({
      tone: completedGenerations.length > 0 ? 'success' : 'error',
      title: completedGenerations.length > 0 ? t('textureMapGenerated') : t('textureMapFailed'),
      description:
        completedGenerations.length > 0
          ? `已生成 ${completedGenerations.length}/${pendingGenerations.length} 个多视图纹理贴图，自动投影 ${projectedGenerationCount}/${completedGenerations.length} 个。`
          : '多视图纹理贴图任务提交失败。',
    });
  }

  function requestAiOneClickTextureMap() {
    const materialReference = activeReferences.find(
      (reference) => reference.id === activeSelectedReferenceIds[0],
    );
    if (!materialReference) {
      pushToast({
        tone: 'warning',
        title: 'AI 一键生成贴图',
        description: t('selectOneMaterialReference'),
        dedupeKey: 'ai-one-click-reference-required',
      });
      return;
    }
    if (submitLocksRef.current.has('multiview') || previewIsGenerating) {
      pushToast({ tone: 'warning', title: '当前已有生图任务在运行，请完成后再试。' });
      return;
    }
    setAiOneClickConfirmOpen(true);
  }

  async function confirmAiOneClickTextureMap() {
    setAiOneClickConfirmOpen(false);
    const materialReference = activeReferences.find(
      (reference) => reference.id === activeSelectedReferenceIds[0],
    );
    if (!materialReference || submitLocksRef.current.has('multiview')) return;
    const cubeViews = createCameraViewsForPreset('preset-1', t);
    setSelectedCameraViewPreset('preset-1');
    setCameraViews(cubeViews);
    setActiveCameraViewId(cubeViews[0]?.id ?? '');
    submitLocksRef.current.add('multiview');
    try {
      await handleTextureMapMultiviewGenerate(materialReference, cubeViews);
    } catch (error) {
      const message = getUserFacingGenerationError(error, 'AI 一键生成贴图失败，请稍后重试。');
      pushToast({
        tone: 'error',
        title: 'AI 一键生成贴图失败',
        description: message,
        dedupeKey: `ai-one-click-failed:${message}`,
      });
    } finally {
      submitLocksRef.current.delete('multiview');
      finish();
    }
  }

  async function handleLocalRepaintGenerate() {
    let pendingGeneration: Generation | undefined;
    let requestAbortController: AbortController | undefined;
    try {
      if (submitLocksRef.current.has('repaint') || previewIsGenerating) {
        setGenerateNotice({
          tone: 'warning',
          message: '当前工程已有局部重绘任务在运行，请等待该任务完成。',
        });
        pushToast({ tone: 'warning', title: '当前已有局部重绘任务在运行，请完成后再试。' });
        return;
      }
      if (!currentProject || !captureObjectId) throw new Error(t('importModelFirst'));
      if (!paintMaskHasContent || !paintMaskDataUrl) {
        setGenerateNotice({ tone: 'warning', message: t('localRepaintMaskMissing') });
        pushToast({
          tone: 'warning',
          title: t('localRepaintMaskMissing'),
          description: t('inpaintSelectToolHelp'),
          dedupeKey: 'generate-local-repaint-mask-required',
        });
        return;
      }
      submitLocksRef.current.add('repaint');
      if (authStatus !== 'authenticated' && !(await requireFeishuLogin())) return;
      const objectId = captureObjectId;
      // The selection accumulates camera-specific projections instead of using
      // model UVs. Reproject their union from the current camera immediately
      // before submission so it matches the captured frame.
      const currentPaintMaskDataUrl =
        (await useSceneStore.getState().paintMaskCapture?.()) ?? paintMaskDataUrl;
      if (!currentPaintMaskDataUrl) throw new Error(t('localRepaintMaskMissing'));
      useSceneStore.getState().setPaintMaskDataUrl(currentPaintMaskDataUrl, true);
      const maskSize = await getImageSize(currentPaintMaskDataUrl);
      if (!maskSize.width || !maskSize.height) throw new Error('无法读取当前局部重绘蒙版尺寸。');
      const capture = await captureCurrentView({
        objectId,
        resolution: 2048,
        framing: 'current',
        colorMode: 'target-only',
        aspect: maskSize.width / maskSize.height,
      });
      setLastCapture(capture);
      addProjectCapture(capture);
      const submittedPrompt = prompt.trim();
      const generationId = createId('local-repaint');
      pendingGeneration = {
        id: generationId,
        mode: 'inpaint',
        prompt: submittedPrompt,
        referenceIds: [],
        captureId: capture.id,
        status: 'running',
        metadata: {
          provider: 'modelview-seedvr2',
          workflow: 'local-repaint',
          clientGenerationId: generationId,
          projectId: currentProject.id,
          objectId,
          objectMatrixWorld: getImportedModelMatrixWorld(objectId),
          serverSubmitted: false,
          startedAt: new Date().toISOString(),
        },
      };
      start(pendingGeneration);
      addProjectGeneration(pendingGeneration);
      setGenerateNotice({
        tone: 'info',
        message: '正在把当前视角和蒙版提交到 ModelView 局部重绘。',
      });
      requestAbortController = new AbortController();
      generationAbortControllersRef.current.set(generationId, requestAbortController);
      const inputImage = await createComfyInpaintInputImage(
        capture.colorUrl,
        currentPaintMaskDataUrl,
        capture.width,
        capture.height,
      );
      const generation = await createModelviewApiClient().generateInpaint(
        {
          clientGenerationId: generationId,
          projectId: currentProject.id,
          prompt: submittedPrompt,
          captureId: capture.id,
          objectId,
          image: { path: 'input-with-mask.png', dataUrl: inputImage },
        },
        { signal: requestAbortController.signal },
      );
      if (isCancelledGeneration(pendingGeneration)) return;
      let localResultUrl = generation.resultUrl;
      if (localResultUrl) {
        try {
          localResultUrl = await persistGeneratedImage(
            'generations',
            localResultUrl,
            `${generationId}.png`,
            undefined,
            currentProject.id,
          );
        } catch (error) {
          console.warn('[Liclick 3D Texture] Could not localize repaint result:', error);
          pushToast({
            tone: 'warning',
            title: '局部重绘结果暂未保存到本地',
            description: '当前结果仍可使用；请保持本地服务在线，项目保存时会自动重试。',
            dedupeKey: `local-repaint-result-persist:${generationId}`,
          });
        }
      }
      if (isCancelledGeneration(pendingGeneration)) return;
      syncGeneration({
        ...generation,
        resultUrl: localResultUrl,
        captureId: generation.captureId ?? capture.id,
        metadata: {
          ...generation.metadata,
          objectMatrixWorld: getImportedModelMatrixWorld(objectId),
          maskUrl: currentPaintMaskDataUrl,
        },
      });
      await saveGenerationStateBestEffort();
      setGenerateNotice(undefined);
      pushToast({
        tone: 'success',
        title: '局部重绘图已生成',
        description: '现在点击底部按钮 3，再刷哪里就替换哪里。',
      });
    } catch (error) {
      if (pendingGeneration && isCancelledGeneration(pendingGeneration)) return;
      const message = getUserFacingGenerationError(error, '局部重绘生成失败，请稍后重试。');
      if (pendingGeneration) syncGeneration(createFailedGeneration(pendingGeneration, message));
      setGenerateNotice({ tone: 'error', message });
      pushToast({ tone: 'error', title: t('localRepaintFailed'), description: message });
    } finally {
      if (
        pendingGeneration &&
        generationAbortControllersRef.current.get(pendingGeneration.id) === requestAbortController
      ) {
        generationAbortControllersRef.current.delete(pendingGeneration.id);
      }
      submitLocksRef.current.delete('repaint');
      finish();
    }
  }

  async function handleGenerate() {
    if (tab === 'repaint') {
      await handleLocalRepaintGenerate();
      return;
    }
    if (tab === 'multiview') {
      await handleTextureMapGenerate();
      return;
    }
    let pendingGeneration: Generation | undefined;
    try {
      if (submitLocksRef.current.has('single') || previewIsGenerating) {
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
      submitLocksRef.current.add('single');
      if (!(await requirePersonalLiclickAccount())) return;
      const submittedPrompt = buildMultiviewPrompt(prompt);
      const generationId = createId('liclick-image');
      const objectMatrixWorld = getImportedModelMatrixWorld(captureObjectId);
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
          visibleOnly: true,
          upscale: false,
          resolution,
          serverSubmitted: false,
          startedAt: new Date().toISOString(),
        },
      };
      start(pendingGeneration);
      addProjectGeneration(pendingGeneration);
      await saveCriticalProjectState({
        references: useReferenceStore.getState().references,
      });
      setGenerateNotice({
        tone: 'info',
        message: '正在提交莉刻生图任务，请等待。',
      });
      const generation = await createLiclickApiClient({
        onReferencePreprocessed: notifyReferencePreprocessed,
      }).generateTextureSingleView({
        clientGenerationId: generationId,
        projectId: currentProject?.id,
        workflow: 'liclick',
        mode: 'single',
        prompt: submittedPrompt,
        referenceIds: activeSelectedReferenceIds,
        referenceImages: activeReferences.filter((reference) =>
          activeSelectedReferenceIds.includes(reference.id),
        ),
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
        count,
      });
      const alignedGeneration: Generation = {
        ...pendingGeneration,
        ...generation,
        metadata: {
          ...pendingGeneration.metadata,
          ...generation.metadata,
          objectMatrixWorld,
          serverSubmitted: true,
          serverJobId: generation.metadata.serverJobId ?? generation.id,
        },
      };
      if (
        cancelledGenerationIdsRef.current.has(generationId) ||
        cancelledGenerationIdsRef.current.has(getGenerationJobId(alignedGeneration))
      ) {
        finish();
        return;
      }
      syncGeneration(alignedGeneration);
      await saveGenerationStateBestEffort();
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
      const message = getUserFacingGenerationError(error);
      setGenerateNotice({
        tone: 'error',
        message,
      });
      if (pendingGeneration) {
        syncGeneration(createFailedGeneration(pendingGeneration, message));
      }
      await saveGenerationStateBestEffort();
      finish();
      pushToast({
        tone: 'error',
        title: '图片生成失败',
        description: message,
      });
    } finally {
      submitLocksRef.current.delete('single');
    }
  }

  async function handleTextureMapGenerate() {
    let pendingGeneration: Generation | undefined;
    try {
      if (submitLocksRef.current.has('multiview') || previewIsGenerating) {
        setGenerateNotice({
          tone: 'warning',
          message: '当前工程已有纹理贴图任务在运行，完成前不能再次提交同类任务。',
        });
        pushToast({ tone: 'warning', title: '当前已有纹理贴图任务在运行，请完成后再试。' });
        return;
      }
      const materialReference = activeReferences.find(
        (reference) => reference.id === activeSelectedReferenceIds[0],
      );
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
      submitLocksRef.current.add('multiview');
      if (textureMapViewMode === 'multi-view') {
        await handleTextureMapMultiviewGenerate(materialReference);
        return;
      }
      if (!(await requirePersonalLiclickAccount())) return;
      const capture = await captureTextureMapReferenceView();
      // Keep the same capture/mask pairing used by local repaint so completed
      // texture generations can restore their exact silhouette preview after a
      // reload instead of falling back to color-based background removal.
      addProjectCapture(capture);
      const object = objects.find((item) => item.id === capture.objectId);
      const texturePrompt = buildTextureMapPrompt(prompt);
      const generationId = createId('texture-map');
      const objectMatrixWorld = getImportedModelMatrixWorld(capture.objectId);
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
      await saveCriticalProjectState({
        references: useReferenceStore.getState().references,
      });
      setGenerateNotice({
        tone: 'info',
        message: t('textureMapSubmitting'),
      });
      const generation = await createLiclickApiClient({
        onReferencePreprocessed: notifyReferencePreprocessed,
      }).generateTextureSingleView({
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
      if (isCancelledGeneration(pendingGeneration)) return;
      const textureMapGeneration: Generation = {
        ...pendingGeneration,
        ...generation,
        metadata: {
          ...pendingGeneration.metadata,
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
      await saveGenerationStateBestEffort();
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
      if (pendingGeneration && isCancelledGeneration(pendingGeneration)) {
        finish();
        return;
      }
      console.error('[Liclick 3D Texture] Texture map generation failed:', error);
      const message = getUserFacingGenerationError(error, '纹理贴图生成失败，请稍后重试。');
      setGenerateNotice({
        tone: 'error',
        message,
      });
      if (pendingGeneration) {
        syncGeneration(createFailedGeneration(pendingGeneration, message));
      }
      await saveGenerationStateBestEffort();
      finish();
      pushToast({
        tone: 'error',
        title: t('textureMapFailed'),
        description: message,
      });
    } finally {
      submitLocksRef.current.delete('multiview');
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
      isWorkspaceAssetUrl(url)
    )
      return url;
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
        const colorUrl = await persistGeneratedImage(
          'captures',
          capture.colorUrl,
          `${capture.id}-color.png`,
          undefined,
          targetProjectId,
        );
        const maskUrl = await persistGeneratedImage(
          'captures',
          capture.maskUrl,
          `${capture.id}-mask.png`,
          undefined,
          targetProjectId,
        );
        const depthUrl = capture.depthUrl
          ? await persistGeneratedImage(
              'captures',
              capture.depthUrl,
              `${capture.id}-depth.png`,
              undefined,
              targetProjectId,
            )
          : undefined;
        const normalUrl = capture.normalUrl
          ? await persistGeneratedImage(
              'captures',
              capture.normalUrl,
              `${capture.id}-normal.png`,
              undefined,
              targetProjectId,
            )
          : undefined;
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

  async function saveCriticalProjectState(overrides: {
    layers?: Layer[];
    references?: ReferenceImage[];
    captures?: Capture[];
  }) {
    const targetProjectId = currentProject?.id;
    if (!targetProjectId) return;
    let result: Awaited<ReturnType<typeof saveWorkspaceProject>> | undefined;
    let savedProjectSnapshot: ReturnType<typeof useProjectStore.getState>['projects'][number] | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const projectState = useProjectStore.getState();
      const project = projectState.projects.find((item) => item.id === targetProjectId);
      if (!project || project.workspaceMode !== 'local-server') return;
      const isTargetProjectActive = projectState.currentProjectId === targetProjectId;
      const captures = await persistCaptureAssets(
        attempt === 0 && overrides.captures ? overrides.captures : project.captures,
        targetProjectId,
      );
      const references = await persistReferenceAssets(
        attempt === 0 && overrides.references
          ? overrides.references
          : isTargetProjectActive
            ? useReferenceStore.getState().references
            : project.references,
        targetProjectId,
      );
      const targetGenerations = useGenerationStore
        .getState()
        .generations.filter((generation) =>
          generationBelongsToProject(generation, targetProjectId),
        );
      savedProjectSnapshot = {
        ...project,
        objects: isTargetProjectActive ? useSceneStore.getState().objects : project.objects,
        layers:
          attempt === 0 && overrides.layers
            ? overrides.layers
            : isTargetProjectActive
              ? useLayerStore.getState().layers
              : project.layers,
        references,
        generations: isTargetProjectActive ? targetGenerations : project.generations,
        captures,
        bakedTextures: project.bakedTextures,
        updatedAt: new Date().toISOString(),
        dirty: false,
        workspaceMode: 'local-server' as const,
      };
      try {
        result = await saveWorkspaceProject(savedProjectSnapshot);
        break;
      } catch (error) {
        const staleSnapshot =
          error instanceof WorkspaceApiError &&
          error.status === 409 &&
          error.message.includes('stale project snapshot');
        if (!staleSnapshot || attempt > 0) throw error;
      }
    }
    if (!result || !savedProjectSnapshot) return;
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
    });
    if (
      !savedLatestSnapshot &&
      typeof window !== 'undefined' &&
      useProjectStore.getState().currentProjectId === targetProjectId
    ) {
      window.dispatchEvent(new Event(IMMEDIATE_PROJECT_SAVE_EVENT));
    }
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
        ?.captures ?? currentProject?.captures ?? [];
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
    const maskedResultUrl = await createMaskedProjectedImage(
      generation.resultUrl.startsWith('http')
        ? await urlToDataUrl(generation.resultUrl)
        : generation.resultUrl,
      generationCapture.maskUrl,
    );
    // Image download and masking can outlive the editor route. Never apply the
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
      maskedResultUrl,
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
      maskedResultUrl: string;
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
      maskedResultUrl,
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
        persistGeneratedImage('layers', maskedResultUrl, `${layerId}.png`),
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
      pushToast({
        tone: 'warning',
        title: '图层保存失败',
        description: error instanceof Error ? error.message : '请确认工作区服务在线后再试。',
        dedupeKey: `layer-save-failed:${layerId}`,
      });
      throw error;
    }
    if (targetProjectId && useProjectStore.getState().currentProjectId !== targetProjectId) {
      return undefined;
    }
    const currentExisting = useLayerStore
      .getState()
      .layers.find(
        (layer) => layer.id === layerId || layer.generationId === generation.id,
      );
    // A manual replacement may target a layer that the user deleted while its
    // files were saving. New automatic layers have not entered the store yet,
    // so they can be committed safely only after every asset is durable.
    if (existingLayer && !currentExisting) return undefined;
    let layer: Layer;
    if (currentExisting) {
      layer = {
        ...currentExisting,
        imageUrl,
        maskUrl,
        depthUrl,
        camera: persistedGenerationCapture.camera,
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
            alphaMode: 'solid-background-cutout',
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
      pushToast({
        tone: 'warning',
        title: '图层已添加，但工程保存失败',
        description: error instanceof Error ? error.message : '请确认工作区服务在线后再试。',
        dedupeKey: `layer-save-failed:${layer.id}`,
      });
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
    if (!previewGeneration) return;
    await addGenerationAsProjectedLayer(previewGeneration);
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
      isPrimary: true,
    };
    addReferences([reference]);
    const nextReferences = [
      reference,
      ...useReferenceStore.getState().references.filter((item) => item.id !== reference.id),
    ];
    setProjectReferences(nextReferences);
    try {
      await saveCriticalProjectState({ references: nextReferences });
      const persistedUrl = await persistGeneratedImage(
        'references',
        reference.url,
        `${reference.id}.png`,
      );
      if (persistedUrl !== reference.url) {
        reference = { ...reference, url: persistedUrl };
        const persistedReferences = [
          reference,
          ...nextReferences.filter((item) => item.id !== reference.id),
        ];
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

  async function handleDownloadGenerationImage() {
    if (!previewGeneration?.resultUrl) return;
    const kind = isTextureMapGeneration(previewGeneration) ? 'texture_map' : 'liclick_generation';
    const downloaded = await downloadImageAsset(
      previewResultUrl ?? previewGeneration.resultUrl,
      `liclick_${kind}_${previewGeneration.id}`,
    );
    if (!downloaded) return;
    trackModuleAction(
      isLocalRepaintGeneration(previewGeneration) ? 'local_repaint' : 'texture_painting',
      'download',
    );
  }

  return (
    <>
      <Panel title={t('generatePanel')}>
        <SegmentedControl
          value={tab}
          options={[
            { value: 'multiview', label: t('multiview') },
            { value: 'repaint', label: t('localRepaint') },
            { value: 'single', label: t('single') },
          ]}
          onChange={setTab}
          className="mb-2"
        />
        {!isLocalRepaintTab && (
          <div
            className="mb-2 grid grid-cols-2 gap-1 rounded-md border border-white/10 bg-black/24 p-1"
            role="radiogroup"
            aria-label="生成模型"
          >
            <button
              type="button"
              role="radio"
              aria-checked={imageModel === 'gpt-image-2'}
              title="使用 GPT-Image 2"
              className={`flex h-9 items-center justify-center gap-2 rounded-md border text-xs font-semibold transition ${
                imageModel === 'gpt-image-2'
                  ? 'border-sky-300/48 bg-sky-400/18 text-sky-50 shadow-[0_0_18px_rgba(56,189,248,0.18)]'
                  : 'border-transparent text-white/58 hover:bg-white/8 hover:text-white/88'
              }`}
              onClick={() => updateGenerationSettings({ model: 'gpt-image-2' })}
            >
              <Bot className="h-4 w-4" />
              <span>GPT 2</span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={imageModel === 'nano_banana_2'}
              title="使用 Nano Banana 2"
              className={`flex h-9 items-center justify-center gap-2 rounded-md border text-xs font-semibold transition ${
                imageModel === 'nano_banana_2'
                  ? 'border-amber-300/48 bg-amber-300/18 text-amber-50 shadow-[0_0_18px_rgba(251,191,36,0.18)]'
                  : 'border-transparent text-white/58 hover:bg-white/8 hover:text-white/88'
              }`}
              onClick={() => updateGenerationSettings({ model: 'nano_banana_2' })}
            >
              <Banana className="h-4 w-4" />
              <span>Nano 2</span>
            </button>
          </div>
        )}
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
                <img
                  src={previewResultUrl ?? previewGeneration.resultUrl}
                  alt=""
                  className="h-full w-full object-contain"
                />
              </button>
            ) : (
              <div className="h-full w-full bg-[#1b1b1b]" />
            )}
            {previewGeneration?.resultUrl && (
              <div className="absolute right-2 top-2 flex gap-1 rounded-md border border-white/10 bg-black/68 p-1 shadow-xl backdrop-blur-sm">
                {tab === 'single' &&
                  !isTextureMapGeneration(previewGeneration) &&
                  !isLocalRepaintGeneration(previewGeneration) && (
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
                  onClick={() => void handleDownloadGenerationImage()}
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
            {previewIsGenerating && previewGeneration && (
              <div className="absolute inset-0 grid place-items-center bg-black/62 text-white backdrop-blur-[2px]">
                <GenerationProgressStatus generation={previewGeneration} title={t('generating')} />
              </div>
            )}
            {previewFailed && !previewIsGenerating && (
              <div className="absolute inset-0 grid place-items-center bg-rose-950/28 px-4 text-center text-white">
                <div className="grid gap-1">
                  <div className="text-sm font-semibold">
                    {previewCancelled ? '已终止' : '生成失败'}
                  </div>
                  <div className="text-xs text-white/66">
                    {previewCancelled
                      ? '当前生成任务已停止等待，本次结果已丢弃。'
                      : '请检查提示词、参考图或模型要求后重试。'}
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="space-y-3 p-2.5">
            {isTextureMapTab ? (
              <div className="grid grid-cols-2 gap-2 text-xs text-white/72">
                <button
                  type="button"
                  className={`h-9 rounded-md font-medium transition ${
                    textureMapViewMode === 'single-view'
                      ? 'bg-white text-black'
                      : 'bg-white/[0.045] text-white/78 hover:bg-white/10'
                  }`}
                  onClick={() => setTextureMapViewMode('single-view')}
                >
                  {t('singleView')}
                </button>
                <button
                  type="button"
                  className={`h-9 rounded-md font-medium transition ${
                    textureMapViewMode === 'multi-view'
                      ? 'bg-white text-black'
                      : 'bg-white/[0.045] text-white/78 hover:bg-white/10'
                  }`}
                  onClick={() => setTextureMapViewMode('multi-view')}
                >
                  {t('multiView')}
                </button>
              </div>
            ) : null}

            {isTextureMapTab && textureMapViewMode === 'multi-view' && (
              <section className="grid gap-2">
                <div className="flex items-center justify-between gap-2 text-sm font-semibold text-white/88">
                  <span>{t('cameraViews')}</span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      className="grid h-7 w-7 place-items-center rounded-md text-white/72 transition hover:bg-white/10 hover:text-white"
                      title="AI 一键生成六面贴图并上色"
                      aria-label="AI 一键生成六面贴图并上色"
                      onClick={requestAiOneClickTextureMap}
                    >
                      <Sparkles className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      className="grid h-7 w-7 place-items-center rounded-md text-white/72 transition hover:bg-white/10 hover:text-white"
                      title={t('addCameraView')}
                      aria-label={t('addCameraView')}
                      onClick={handleAddCurrentCameraView}
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                <div
                  className="grid grid-cols-3 gap-1 rounded-md border border-white/10 bg-black/24 p-1"
                  role="radiogroup"
                  aria-label="模型方向预设"
                >
                  {cameraViewPresets.map((preset) => {
                    const selected = selectedCameraViewPreset === preset.id;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        title={preset.description}
                        className={`grid min-h-10 place-items-center rounded px-1 py-1 text-[11px] font-semibold leading-4 transition ${
                          selected
                            ? 'bg-white text-black shadow-sm'
                            : 'text-white/62 hover:bg-white/10 hover:text-white'
                        }`}
                        onClick={() => handleCameraViewPresetSelect(preset.id)}
                      >
                        <span>{preset.label}</span>
                        <span className={selected ? 'text-black/56' : 'text-white/38'}>
                          {preset.views.length} 视角
                        </span>
                      </button>
                    );
                  })}
                </div>
                <p className="px-0.5 text-[11px] leading-4 text-white/45">
                  {selectedCameraViewPreset
                    ? getCameraViewPresetDefinition(selectedCameraViewPreset).description
                    : `自定义组合：${cameraViews.length} 个视角`}
                </p>
                <div className="grid grid-cols-3 gap-2">
                  {cameraViews.map((view) => (
                    <div key={view.id} className="group relative h-[76px]">
                      <button
                        type="button"
                        className={`h-full w-full overflow-hidden rounded-md border p-0.5 transition ${
                          activeCameraViewId === view.id
                            ? 'border-[#ff8a68] bg-[#ff8a68]/18 shadow-[0_0_0_2px_rgba(255,138,104,0.28)]'
                            : 'border-white/10 bg-white/[0.045] hover:border-white/28 hover:bg-white/10'
                        }`}
                        onClick={() => handleCameraViewSelect(view)}
                        title={view.label}
                        aria-label={view.label}
                      >
                        <CameraViewThumbnail
                          preview={cameraViewPreviews[view.id]}
                          loading={capturingCameraViews.has(view.id)}
                        />
                        <span className="pointer-events-none absolute bottom-1 left-1 z-10 rounded bg-black/68 px-1.5 py-0.5 text-[10px] font-medium leading-4 text-white/88 shadow">
                          {view.label}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="absolute right-1 top-1 grid h-6 w-6 place-items-center rounded-full border border-white/16 bg-black/72 text-white/72 opacity-0 shadow transition hover:bg-red-500 hover:text-white group-hover:opacity-100 focus:opacity-100"
                        title={`删除${view.label}视角`}
                        aria-label={`删除${view.label}视角`}
                        onClick={() => handleDeleteCameraView(view.id)}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            )}

            <label className="grid gap-1.5 text-xs font-semibold text-white/82">
              <span>{t('prompt')}</span>
              <textarea
                value={prompt}
                onChange={(event) =>
                  updateGenerationSettings(
                    isTextureMapTab
                      ? { textureMapPrompt: event.target.value }
                      : isLocalRepaintTab
                        ? { localRepaintPrompt: event.target.value }
                        : { liclickPrompt: event.target.value },
                  )
                }
                className="h-[104px] w-full resize-none rounded-md border border-white/18 bg-black/34 p-2.5 text-[13px] leading-5 text-white outline-none transition focus:border-liclick-pink"
              />
            </label>

            {!isLocalRepaintTab && (
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
            )}

            {generateNotice && (
              <div
                role={generateNotice.tone === 'error' ? 'alert' : 'status'}
                aria-live="polite"
                className={`rounded-md border px-2.5 py-2 text-xs leading-5 ${
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

            <div className={canCancelGeneration ? 'grid grid-cols-[1fr_52px] gap-2' : undefined}>
              <Button
                className="h-12 w-full text-base"
                variant="primary"
                disabled={previewIsGenerating}
                onClick={handleGenerate}
                icon={<Sparkles className="h-4 w-4" />}
              >
                {previewIsGenerating
                  ? t('generating')
                  : tab === 'multiview'
                    ? t('generateTextureMap')
                    : tab === 'repaint'
                      ? '局部生图'
                      : t('generateImage')}
              </Button>
              {canCancelGeneration && (
                <Button
                  className="h-12 w-full px-0"
                  variant="danger"
                  onClick={cancelCurrentGeneration}
                  title={
                    isTextureMapTab
                      ? '终止纹理贴图生成'
                      : isLocalRepaintTab
                        ? '终止局部重绘生成'
                        : '终止莉刻生图'
                  }
                  aria-label={
                    isTextureMapTab
                      ? '终止纹理贴图生成'
                      : isLocalRepaintTab
                        ? '终止局部重绘生成'
                        : '终止莉刻生图'
                  }
                  icon={<Square className="h-4 w-4 fill-current" />}
                />
              )}
            </div>
          </div>
        </div>
      </Panel>
      {portalRoot &&
        aiOneClickConfirmOpen &&
        createPortal(
          <div className="fixed inset-0 z-[145] grid place-items-center bg-black/62 px-4 backdrop-blur-sm">
            <div className="w-full max-w-[440px] rounded-lg border border-white/16 bg-[#151520] p-4 text-white shadow-2xl">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-liclick-pink">
                    AI 一键生成贴图并上色
                  </div>
                  <div className="mt-1 text-lg font-bold">确认生成六个标准面？</div>
                </div>
                <button
                  type="button"
                  className="grid h-8 w-8 place-items-center rounded-md text-white/70 transition hover:bg-white/10 hover:text-white"
                  onClick={() => setAiOneClickConfirmOpen(false)}
                  aria-label={t('close')}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <p className="mt-3 text-sm leading-6 text-white/72">
                将自动拍摄正面、背面、左面、右面、顶面和底面，分别提交纹理贴图任务。每张完成后会立即自动扣图并加入右侧图层，之后可人工检查和修改。
              </p>
              <div className="mt-4 grid grid-cols-2 gap-2">
                <Button
                  variant="secondary"
                  className="h-10"
                  onClick={() => setAiOneClickConfirmOpen(false)}
                >
                  取消
                </Button>
                <Button
                  className="h-10"
                  onClick={() => void confirmAiOneClickTextureMap()}
                  icon={<Sparkles className="h-4 w-4" />}
                >
                  确认并开始
                </Button>
              </div>
            </div>
          </div>,
          portalRoot,
        )}
      {portalRoot &&
        cancelConfirmGeneration &&
        createPortal(
          <div className="fixed inset-0 z-[140] grid place-items-center bg-black/62 px-4 backdrop-blur-sm">
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
                  : cancelConfirmGeneration.metadata.provider === 'modelview-seedvr2'
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
        previewGeneration?.resultUrl &&
        createPortal(
          <button
            type="button"
            className="fixed inset-0 z-[135] grid cursor-zoom-out place-items-center bg-black/72 p-4 backdrop-blur-sm"
            onClick={() => setPreviewImageOpen(false)}
            aria-label={t('close')}
          >
            <img
              src={previewResultUrl ?? previewGeneration.resultUrl}
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
