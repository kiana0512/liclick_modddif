import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Banana,
  Bot,
  Download,
  Image,
  ImagePlus,
  Layers,
  Maximize2,
  Plus,
  Settings,
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
import {
  createLiclickApiClient,
  type LiclickAspectRatio,
  type LiclickImageModel,
  type LiclickImageSize,
} from '@/services/liclickApiClient';
import { getUserFacingGenerationError } from '@/services/generationErrorMessage';
import type { ReferencePreprocessingResult } from '@/services/referenceImagePreprocessor';
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
import type { CaptureNormalPreview, CaptureResolution } from '@/engine/capture/captureTypes';
import type { Generation } from '@/types/generation';
import type { Layer } from '@/types/layer';
import type { ReferenceImage } from '@/types/project';
import { getRegisteredObjectUrlBlob } from '@/utils/blobUrlRegistry';
import { createId } from '@/utils/id';
import { downloadImageAsset } from '@/utils/downloadImage';
import { encodeRgbaPngDataUrl } from '@/utils/encodeRgbaPng';
import {
  isWorkspaceAssetUrl,
  saveBlobAsset,
  saveDataUrlAsset,
  saveProject as saveWorkspaceProject,
  saveRemoteUrlAsset,
  urlToDataUrl,
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
    | 'frontLeftView'
    | 'frontLeftTopView'
    | 'frontRightView'
    | 'frontRightBottomView'
    | 'backView'
    | 'backLeftView'
    | 'backLeftBottomView'
    | 'backRightView'
    | 'backRightTopView'
    | 'leftView'
    | 'rightView'
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

const imageModels: { value: LiclickImageModel; label: string }[] = [
  { value: 'gpt-image-2', label: 'GPT-Image 2' },
  { value: 'nano_banana_2', label: 'Nano Banana 2' },
  { value: 'nano_banana_pro', label: 'Nano Banana Pro' },
  { value: 'gpt-image-1.5', label: 'GPT-Image 1.5' },
  { value: 'doubao-seedream-4-5-251128', label: 'Seedream 4.5' },
  { value: 'midjourney-7', label: 'Midjourney V7' },
];

const cameraViewOptions: Record<ObjectViewPreset, CameraViewOption> = {
  front: { value: 'front', labelKey: 'frontView' },
  back: { value: 'back', labelKey: 'backView' },
  left: { value: 'left', labelKey: 'leftView' },
  right: { value: 'right', labelKey: 'rightView' },
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
    description: '上、下、左、右、前、后，加左前上、右后上、左后下、右前下 45° 视角',
    views: [
      'top',
      'bottom',
      'left',
      'right',
      'front',
      'back',
      'front-left-top',
      'back-right-top',
      'back-left-bottom',
      'front-right-bottom',
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

const aspectRatios: LiclickAspectRatio[] = [
  'auto',
  '1:1',
  '4:3',
  '3:4',
  '3:2',
  '2:3',
  '16:9',
  '9:16',
];
const imageSizes: LiclickImageSize[] = ['auto', '1K', '2K', '4K'];
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

function buildLiclickPrompt(userPrompt: string, model: LiclickImageModel) {
  const trimmedPrompt = userPrompt.trim();
  if (trimmedPrompt) return trimmedPrompt;
  if (model === 'nano_banana_2' || model === 'nano_banana_pro') return '生成一张高质量的参考图。';
  return '';
}

function isTextureMapGeneration(generation: Generation) {
  return generation.metadata.workflow === 'texture-map';
}

function isLocalRepaintGeneration(generation: Generation) {
  return generation.metadata.workflow === 'local-repaint';
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

function getGenerationStartedAt(generation: Generation) {
  const startedAt = generation.metadata.startedAt;
  return typeof startedAt === 'string' ? Date.parse(startedAt) : Number.NaN;
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
  const [settingsOpen, setSettingsOpen] = useState(false);
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
  const [generateNotice, setGenerateNotice] = useState<GenerateNotice | undefined>();
  const [cancelConfirmGeneration, setCancelConfirmGeneration] = useState<Generation | undefined>();
  const currentProject = useProjectStore((state) =>
    state.projects.find((project) => project.id === state.currentProjectId),
  );
  const currentProjectId = currentProject?.id;
  const isTextureMapTab = tab === 'multiview';
  const isLocalRepaintTab = tab === 'repaint';
  const updateCurrentProject = useProjectStore((state) => state.updateCurrentProject);
  const setWorkspaceState = useProjectStore((state) => state.setWorkspaceState);
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
  const generations = useGenerationStore((state) => state.generations);
  const lastCapture = useGenerationStore((state) => state.lastCapture);
  const start = useGenerationStore((state) => state.start);
  const finish = useGenerationStore((state) => state.finish);
  const addGeneration = useGenerationStore((state) => state.addGeneration);
  const setLastCapture = useGenerationStore((state) => state.setLastCapture);
  const addProjectGeneration = useProjectStore((state) => state.addGeneration);
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
  const submitLockRef = useRef(false);
  const cancelledGenerationIdsRef = useRef(new Set<string>());
  const generationPollFailureCountsRef = useRef(new Map<string, number>());
  const comfyGenerationAbortRef = useRef<AbortController | undefined>();
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
      addGeneration(generation);
      addProjectGeneration(generation);
    },
    [addGeneration, addProjectGeneration],
  );

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
    [finish, pushToast, syncGeneration, t],
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
      if (Number.isFinite(startedAt) && Date.now() - startedAt < pendingSubmissionTimeoutMs)
        return undefined;
      markGenerationFailed(generationToPoll, '生图任务没有成功提交到莉刻后台，请重新生成。');
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
    const jobId = taskId ?? serverJobId ?? clientGenerationId ?? generationToPoll.id;
    if (cancelledGenerationIdsRef.current.has(jobId)) return undefined;
    let cancelled = false;
    let timeoutId: number | undefined;
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
      try {
        const result = await client.getGenerationJob(jobId);
        if (cancelled) return;
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
      }
      if (!cancelled) timeoutId = window.setTimeout(pollJob, generationPollIntervalMs);
    }

    void pollJob();
    return () => {
      cancelled = true;
      if (timeoutId) window.clearTimeout(timeoutId);
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
    return taskId ?? serverJobId ?? clientGenerationId ?? generation.id;
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
    if (isComfyGeneration || isModelviewGeneration) comfyGenerationAbortRef.current?.abort();
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
    submitLockRef.current = false;
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
        const result = await devLogin({
          displayName: 'Liclick Dev User',
          email: 'dev@liclick.local',
        });
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
    const objectId = captureObjectId;
    const object = objects.find((item) => item.id === objectId);
    const texturePrompt = buildTextureMapPrompt(prompt);
    const objectMatrixWorld = getImportedModelMatrixWorld(objectId);
    const viewCaptures = await getTextureMapMultiviewCaptures(requestedViews);
    if (viewCaptures.length === 0) throw new Error('无法捕获多视图模型方向。');
    viewCaptures.forEach(({ capture }) => addProjectCapture(capture));
    if (!(await requireAiLogin())) return;

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
    const submittedGenerations: Generation[] = [];
    results.forEach((result, index) => {
      const pending = pendingGenerations[index];
      if (!pending) return;
      if (result.status === 'fulfilled') {
        const submittedGeneration: Generation = {
          ...result.value,
          mode: 'multiview',
          metadata: {
            ...result.value.metadata,
            workflow: 'texture-map',
            objectMatrixWorld,
            materialReferenceId: materialReference.id,
            modelViewReferenceId: pending.modelViewReference.id,
            multiview: true,
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

    const completionResults = await Promise.allSettled(
      submittedGenerations.map(async (generation) => {
        const completed = await waitForLiclickGeneration(generation);
        syncGeneration(completed);
        await addGenerationAsProjectedLayer(completed, { automatic: true });
        pushToast({
          tone: 'success',
          title: `${String(completed.metadata.cameraViewLabel ?? '当前')}视角已上图层`,
          description: '已自动扣图并加入右侧图层，可继续人工检查和修改。',
          dedupeKey: `texture-map-view-complete:${completed.id}`,
        });
        return completed;
      }),
    );
    completionResults.forEach((result, index) => {
      const submitted = submittedGenerations[index];
      if (!submitted) return;
      if (result.status === 'fulfilled') {
        completedGenerations.push(result.value);
      } else {
        syncGeneration(
          createFailedGeneration(
            submitted,
            result.reason instanceof Error ? result.reason.message : '多视角纹理贴图任务失败。',
          ),
        );
      }
    });

    setGenerateNotice(undefined);
    pushToast({
      tone: completedGenerations.length > 0 ? 'success' : 'error',
      title: completedGenerations.length > 0 ? t('textureMapGenerated') : t('textureMapFailed'),
      description:
        completedGenerations.length > 0
          ? `已完成并自动扣图入层 ${completedGenerations.length}/${pendingGenerations.length} 个多视图纹理贴图。`
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
    if (submitLockRef.current || previewIsGenerating) {
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
    if (!materialReference || submitLockRef.current) return;
    const cubeViews = createCameraViewsForPreset('preset-1', t);
    setSelectedCameraViewPreset('preset-1');
    setCameraViews(cubeViews);
    setActiveCameraViewId(cubeViews[0]?.id ?? '');
    submitLockRef.current = true;
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
      submitLockRef.current = false;
      finish();
    }
  }

  async function handleLocalRepaintGenerate() {
    let pendingGeneration: Generation | undefined;
    try {
      if (submitLockRef.current || previewIsGenerating) {
        setGenerateNotice({
          tone: 'warning',
          message: '当前工程已有生图任务在运行，请等待任务完成。',
        });
        pushToast({ tone: 'warning', title: '当前已有生图任务在运行，请完成后再试。' });
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
      submitLockRef.current = true;
      if (authStatus !== 'authenticated' && !(await requireAiLogin())) return;
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
      const abortController = new AbortController();
      comfyGenerationAbortRef.current = abortController;
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
        { signal: abortController.signal },
      );
      if (isCancelledGeneration(pendingGeneration)) return;
      syncGeneration({
        ...generation,
        captureId: generation.captureId ?? capture.id,
        metadata: {
          ...generation.metadata,
          objectMatrixWorld: getImportedModelMatrixWorld(objectId),
          maskUrl: currentPaintMaskDataUrl,
        },
      });
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
      comfyGenerationAbortRef.current = undefined;
      submitLockRef.current = false;
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
        visibleOnly: generateMode === 'visible',
        upscale: generateMode === 'upscale',
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
        ...generation,
        metadata: {
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
      finish();
      pushToast({
        tone: 'error',
        title: '图片生成失败',
        description: message,
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
        pushToast({ tone: 'warning', title: '当前已有生图任务在运行，请完成后再试。' });
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
      submitLockRef.current = true;
      if (textureMapViewMode === 'multi-view') {
        await handleTextureMapMultiviewGenerate(materialReference);
        return;
      }
      const capture = await captureTextureMapReferenceView();
      // Keep the same capture/mask pairing used by local repaint so completed
      // texture generations can restore their exact silhouette preview after a
      // reload instead of falling back to color-based background removal.
      addProjectCapture(capture);
      const object = objects.find((item) => item.id === capture.objectId);
      if (!(await requireAiLogin())) return;
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
      finish();
      pushToast({
        tone: 'error',
        title: t('textureMapFailed'),
        description: message,
      });
    } finally {
      comfyGenerationAbortRef.current = undefined;
      submitLockRef.current = false;
    }
  }

  async function persistGeneratedImage(
    category: AssetCategory,
    url: string,
    filename: string,
    blob?: Blob,
  ) {
    if (
      !currentProject ||
      currentProject.workspaceMode !== 'local-server' ||
      isWorkspaceAssetUrl(url)
    )
      return url;
    if (blob) {
      const result = await saveBlobAsset({
        projectId: currentProject.id,
        category,
        blob,
        filename,
      });
      return result.asset.url;
    }
    if (url.startsWith('http')) {
      const result = await saveRemoteUrlAsset({
        projectId: currentProject.id,
        category,
        url,
        filename,
      });
      return result.asset.url;
    }
    if (url.startsWith('blob:')) {
      const registeredBlob = getRegisteredObjectUrlBlob(url);
      if (registeredBlob) {
        const result = await saveBlobAsset({
          projectId: currentProject.id,
          category,
          blob: registeredBlob,
          filename,
        });
        return result.asset.url;
      }
    }
    const dataUrl = url.startsWith('data:') ? url : await urlToDataUrl(url);
    const result = await saveDataUrlAsset({
      projectId: currentProject.id,
      category,
      dataUrl,
      filename,
    });
    return result.asset.url;
  }

  async function persistCaptureAssets(captures: Capture[]) {
    if (!currentProject || currentProject.workspaceMode !== 'local-server') return captures;
    let changed = false;
    const persistedCaptures = await Promise.all(
      captures.map(async (capture) => {
        const colorUrl = await persistGeneratedImage(
          'captures',
          capture.colorUrl,
          `${capture.id}-color.png`,
        );
        const maskUrl = await persistGeneratedImage(
          'captures',
          capture.maskUrl,
          `${capture.id}-mask.png`,
        );
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

  async function saveCriticalProjectState(overrides: {
    layers?: Layer[];
    references?: ReferenceImage[];
  }) {
    const project = useProjectStore.getState().getCurrentProject() ?? currentProject;
    if (!project || project.workspaceMode !== 'local-server') return;
    const captures = await persistCaptureAssets(
      useProjectStore.getState().getCurrentProject()?.captures ?? project.captures,
    );
    const projectForSave = {
      ...project,
      objects: useSceneStore.getState().objects,
      layers: overrides.layers ?? useLayerStore.getState().layers,
      references: overrides.references ?? useReferenceStore.getState().references,
      generations: useGenerationStore.getState().generations,
      captures,
      bakedTextures:
        useProjectStore.getState().getCurrentProject()?.bakedTextures ?? project.bakedTextures,
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

  async function addGenerationAsProjectedLayer(
    generation: Generation,
    options: { automatic?: boolean } = {},
  ) {
    if (!generation.resultUrl || !isTextureMapGeneration(generation)) return undefined;
    const existing = useLayerStore
      .getState()
      .layers.find((layer) => layer.generationId === generation.id);
    if (existing && options.automatic) return existing;
    const generationCapture =
      lastCapture?.id === generation.captureId
        ? lastCapture
        : (useProjectStore
            .getState()
            .getCurrentProject()
            ?.captures.find((capture) => capture.id === generation.captureId) ??
          currentProject?.captures.find((capture) => capture.id === generation.captureId) ??
          lastCapture);
    let persistedGenerationCapture = generationCapture;
    if (currentProject?.workspaceMode === 'local-server' && generationCapture) {
      const captures = await persistCaptureAssets(
        useProjectStore.getState().getCurrentProject()?.captures ?? currentProject.captures,
      );
      persistedGenerationCapture =
        captures.find((capture) => capture.id === generationCapture.id) ?? generationCapture;
    }
    const layerGeneration = {
      ...generation,
      resultUrl: await createMaskedProjectedImage(
        generation.resultUrl.startsWith('http')
          ? await urlToDataUrl(generation.resultUrl)
          : generation.resultUrl,
        persistedGenerationCapture?.maskUrl,
      ),
      metadata: {
        ...generation.metadata,
        alphaMode: 'solid-background-cutout',
      },
    };
    let layer: Layer;
    if (existing) {
      layer = {
        ...existing,
        imageUrl: layerGeneration.resultUrl,
        maskUrl: persistedGenerationCapture?.maskUrl,
        depthUrl: persistedGenerationCapture?.depthUrl,
        camera: persistedGenerationCapture?.camera,
        contentRevision: (existing.contentRevision ?? 0) + 1,
        isBaked: false,
        needsRebake: true,
      };
      useLayerStore.getState().updateLayer(existing.id, layer);
    } else {
      layer = addProjectedLayerFromGeneration(
        layerGeneration,
        persistedGenerationCapture,
        persistedGenerationCapture?.objectId,
      );
    }
    let nextLayers = useLayerStore.getState().layers;
    setProjectLayers(nextLayers);
    try {
      const imageUrl = await persistGeneratedImage('layers', layer.imageUrl, `${layer.id}.png`);
      const maskUrl = layer.maskUrl
        ? await persistGeneratedImage('layers', layer.maskUrl, `${layer.id}-mask.png`)
        : undefined;
      const depthUrl = layer.depthUrl
        ? await persistGeneratedImage('layers', layer.depthUrl, `${layer.id}-depth.png`)
        : undefined;
      layer = { ...layer, imageUrl, maskUrl, depthUrl };
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
    if (!options.automatic) {
      pushToast({
        tone: 'success',
        title: t('autoBakeLayerAdded'),
        description: `${layer.name} ${t('projectedLayerPreviewOnlyHelp')}`,
      });
    }
    return layer;
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

  function handleDownloadGenerationImage() {
    if (!previewGeneration?.resultUrl) return;
    const kind = isTextureMapGeneration(previewGeneration) ? 'texture_map' : 'liclick_generation';
    void downloadImageAsset(
      previewResultUrl ?? previewGeneration.resultUrl,
      `liclick_${kind}_${previewGeneration.id}`,
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
            {tab === 'single' && generateMode === 'upscale' && (
              <div className="absolute right-2 top-2 flex overflow-hidden rounded-md bg-black/62 text-white shadow-lg">
                <button
                  type="button"
                  className="grid h-8 w-8 place-items-center hover:bg-white/10"
                  title={t('captureCurrentView')}
                >
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
            ) : tab === 'single' ? (
              <div
                className={`relative grid gap-2 text-xs text-white/72 ${generateMode === 'visible' ? 'grid-cols-[1fr_1fr_32px]' : 'grid-cols-2'}`}
              >
                <button
                  type="button"
                  className={`h-9 rounded-md font-medium transition ${
                    generateMode === 'visible'
                      ? 'bg-white text-black'
                      : 'bg-white/[0.045] text-white/78 hover:bg-white/10'
                  }`}
                  onClick={() => updateGenerationSettings({ mode: 'visible' })}
                >
                  {t('visible')}
                </button>
                <button
                  type="button"
                  className={`h-9 rounded-md font-medium transition ${
                    generateMode === 'upscale'
                      ? 'bg-white text-black'
                      : 'bg-white/[0.045] text-white/78 hover:bg-white/10'
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

            {tab !== 'single' || generateMode === 'visible' ? (
              <>
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
              </>
            ) : (
              <label className="grid gap-2 text-sm font-semibold text-white/88">
                <span className="flex items-center gap-2">
                  Strength
                  <span className="grid h-4 w-4 place-items-center rounded-full border border-white/48 text-[10px] text-white/70">
                    i
                  </span>
                </span>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={upscaleStrength}
                  onChange={(event) =>
                    updateGenerationSettings({ upscaleStrength: Number(event.target.value) })
                  }
                  className="w-full accent-liclick-orange"
                />
              </label>
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
      {portalRoot &&
        settingsOpen &&
        generateMode === 'visible' &&
        createPortal(
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
                    onChange={(event) =>
                      updateGenerationSettings({ model: event.target.value as LiclickImageModel })
                    }
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
