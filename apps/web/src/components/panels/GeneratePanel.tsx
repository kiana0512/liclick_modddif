import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, Layers, Maximize2, Plus, Sparkles, Square, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Panel } from '@/components/ui/Panel';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { useWorkspaceLayoutStore } from '@/components/workspace/workspaceLayoutStore';
import {
  captureCurrentColorPreview,
  captureCurrentNormalPreview,
  captureCurrentView,
  snapshotCurrentCaptureCamera,
} from '@/engine/capture/captureCurrentView';
import { requestContentAwareRepair } from '@/engine/contentAware';
import { createMaskedProjectedImage } from '@/engine/projection/createMaskedProjectedImage';
import {
  createCaptureMaskedPreview,
  createSubjectFilledPreview,
} from '@/engine/localRepaint/resultPreviewUtils';
import { ensureLocalRepaintSessionLayer as ensurePersistentLocalRepaintSessionLayer } from '@/engine/localRepaint/sessionLayer';
import { generationBelongsToObject } from '@/engine/localRepaint/objectBinding';
import {
  getObjectViewPresetDirection,
  type ObjectViewPreset,
} from '@/engine/scene/transformActions';
import {
  ReferenceGroupPicker,
  referenceGroupId,
  type ReferenceGroupGenerationState,
} from '@/components/panels/ReferenceGroupPicker';
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

type GenerateTab = 'multiview' | 'repaint';
type TextureViewMode = 'single' | 'multi';
type TexturePreviewMode = TextureViewMode | 'repaint';
type GenerateChannel = GenerateTab | 'single';
type GenerateMode = 'visible' | 'upscale';
type TexturePipelineProgress = {
  active: boolean;
  progress: number;
  label: string;
};
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
- 多视角排版、视图名称、画面说明文字、边框和拼图结构

注意：这里只忽略模型外部用于标注视角的说明文字，例如“正面”“左侧”“45度”等。
印刷在目标物体表面的文字、数字、Logo、标签、贴纸、警示符号和装饰图案属于材质内容，必须保留，不能按说明文字删除。

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

【物理表面归属与位置锁定（最高优先级）】

迁移任何文字、Logo、标签、贴纸、标识或装饰图案之前，必须先在内部完成“视图 → 物理表面 → 图案”的对应判断，再生成结果：

1. 利用参考图二中的视图名称和观察方向识别正面、背面、左侧、右侧、顶部、底部及斜视图分别展示的物理表面；视图名称本身不属于材质，不得输出。
2. 找出参考图一当前可见的每一个物理表面，并只从参考图二中展示同一物理表面的视图提取内容。正面内容只能到正面，背面只能到背面，侧面只能到对应侧面，顶面或箱盖内容只能到顶面或箱盖；禁止跨面移动、借用、交换或复制。
3. 以每个物理表面自身的四条边界和部件边界为坐标系，保持图案中心点的横向与纵向相对位置、距各边缘的相对边距、占该表面的面积比例、长宽比、旋转方向及与相邻图案的间距。不得为了画面美观而居中、对齐、放大、缩小或重新排版。
4. 斜视图只用于确认同一图案跨视角的一致身份及透视关系，不得把斜视图里看到的图案当作新图案再次添加。多视图中同一物理图案只能在其原始表面出现一次。
5. 当图案位于折板、箱盖、门板、面板、边框或其他可动部件上时，必须跟随该具体部件，不能转移到相邻主体外壳；部件开合或透视变化时只做相应透视变换，不改变其部件内相对坐标。
6. 如果无法可靠判断某个图案属于哪个物理表面，或当前视角看不到该表面，则不要在当前结果中显示该图案；禁止猜测位置或放到最接近的可见表面。

位置正确性高于构图美观和图案完整展示。最终结果应像同一个已经贴好标识的三维物体从参考图一相机拍摄，而不是把参考图二的图案重新设计后贴到画面上。

【表面文字、标识与图案保真（高优先级）】

参考图二中印刷或附着在主体表面的文字、数字、字母、Logo、邮票、标签、贴纸、警示标识、运输符号、装饰图案和其他平面图形，均属于必须迁移的 Base Color 材质细节，不是需要删除的新增文字。

- 对应表面在参考图二中存在这些内容时，必须同时迁移材质与图案，不得只生成无图案的纯材质
- 对清晰可辨的内容，逐字保留原始拼写、大小写、数字、标点和 Logo 形状，不得改写、乱码、镜像或倒置
- 保持原有颜色、轮廓、排版、方向、大小比例，以及按照上方“物理表面归属与位置锁定”规则确定的对应部件内相对位置
- 文字和图案应随目标表面的透视、朝向和尺度自然贴合，但不得被过度拉伸、重复平铺、跨部件串贴或改变模型几何
- 多个视角中重复出现的同一处标识只迁移一次到对应表面，不得因为多视图而复制多份
- 不同表面上的内容必须依据各视角分别识别，例如正面的图案只放在正面，侧面的运输标识只放在对应侧面
- 只有参考图二中确实存在且能对应到目标部件的内容才迁移；模糊或不可辨认的细小字符不要臆造，也不得添加参考图之外的新文字、Logo 或水印

【Base Color / Albedo 输出要求】

输出为目标模型当前视角下的无光照 Base Color／Albedo 材质投射结果。

保留：
- 材料自身固有颜色
- 颜色斑驳、颗粒、纤维、木纹、石纹、磨损、污渍等真实颜色细节
- 与材料固有颜色有关的细微变化
- 物体表面原有的印刷文字、数字、Logo、标签、贴纸、警示符号和装饰图案

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
不得出现新物体、内容物、地面、网格、边框、拼图或多视角结果。
不得添加参考图二中不存在的新文字、Logo、水印或说明标注；参考图二中已有且能对应到目标表面的文字、标识与图案必须保留。
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

function createFullFrameMaskDataUrl(width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法创建全图局部重绘蒙版。');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
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
  onLocalImageGenerationSettled?: (succeeded: boolean) => void;
};

export function GeneratePanel({
  localImageGenerationRequestKey = 0,
  onLocalImageGenerationSettled,
}: GeneratePanelProps) {
  const t = useT();
  const [tab, setTab] = useState<GenerateTab>('multiview');
  const [textureViewMode, setTextureViewMode] = useState<TextureViewMode>('multi');
  const [texturePreviewMode, setTexturePreviewMode] = useState<TexturePreviewMode>('multi');
  const [previewImageOpen, setPreviewImageOpen] = useState(false);
  const [subjectFilledPreview, setSubjectFilledPreview] = useState<{
    sourceUrl: string;
    maskUrl?: string;
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
  const handledLocalImageGenerationRequestKeyRef = useRef(0);
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
      (succeeded) => onLocalImageGenerationSettled?.(succeeded),
      () => onLocalImageGenerationSettled?.(false),
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
  const prompt = isTextureMapTab ? textureMapPrompt : isLocalRepaintTab ? '' : liclickPrompt;
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
      generationBelongsToObject(
        generation,
        captureObjectId,
        currentProject?.captures ?? [],
      ),
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
    (generationId = latestLocalRepaintGenerationId) => {
      if (!currentProjectId || !captureObjectId) return undefined;
      return ensurePersistentLocalRepaintSessionLayer({
        objectId: captureObjectId,
        generationId,
      }).layer;
    },
    [captureObjectId, currentProjectId, latestLocalRepaintGenerationId],
  );
  useEffect(() => {
    if (!isLocalRepaintTab) return;
    ensureLocalRepaintSessionLayer();
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
  useEffect(() => {
    if (authStatus !== 'authenticated' || !usesPersonalLiclickAccount(providerStatus)) return;
    void getPersonalLiclickAccountStatus().catch(() => undefined);
  }, [authStatus, providerStatus]);
  // Each workflow owns its submission lifecycle. A repaint request must not
  // block texture-map or ordinary image generation (and vice versa).
  const submitLocksRef = useRef(new Set<GenerateChannel>());
  const cancelledGenerationIdsRef = useRef(new Set<string>());
  const cancelledTextureBatchIdsRef = useRef(new Set<string>());
  const generationPollFailureCountsRef = useRef(new Map<string, number>());
  const generationAbortControllersRef = useRef(new Map<string, AbortController>());
  const projectedLayerCommitQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pairedGenerationPersistenceRef = useRef(new Set<string>());
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
  const activeWorkflowGeneration = activeReferenceGeneration ?? activeProjectGeneration;
  const activeReferenceGroupId =
    typeof activeReferenceGeneration?.metadata.referenceGroupId === 'string'
      ? activeReferenceGeneration.metadata.referenceGroupId
      : undefined;
  const displayedReferenceGroupGenerationState =
    referenceGroupGenerationState ??
    (activeReferenceGroupId
      ? ({ groupId: activeReferenceGroupId, status: 'generating' } as const)
      : undefined);
  const previewGeneration = activeProjectGeneration ?? tabGenerations[0];
  const previewIsGenerating = isRunningGeneration(previewGeneration);
  const displayedPreviewGeneration =
    isTextureMapTab && texturePreviewMode === 'repaint'
      ? latestLocalRepaintGeneration
      : previewGeneration;
  const displayedPreviewIsGenerating = isRunningGeneration(displayedPreviewGeneration);
  const displayedPreviewFailed = displayedPreviewGeneration?.status === 'failed';
  const displayedPreviewCancelled = displayedPreviewGeneration?.metadata.cancelled === true;
  const canCancelGeneration = Boolean(activeWorkflowGeneration);
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
      ? capturePreviewMaskUrl
        ? 'capture-mask'
        : 'dark-background'
      : isTextureMapGeneration(displayedPreviewGeneration)
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
    (generationToFail: Generation, message: string) => {
      const userMessage = getUserFacingGenerationError(message);
      syncGeneration(createFailedGeneration(generationToFail, userMessage));
      finish();
      setGenerateNotice({
        tone: 'error',
        message: userMessage,
      });
      console.error('[Liclick 3D Texture] Background generation failed:', userMessage);
    },
    [finish, setGenerateNotice, syncGeneration],
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
  }, [cameraViews, captureObjectId, isTextureMapTab, pushToast, viewport]);

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
    markGenerationFailed,
    previewGeneration,
    pushToast,
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

  function handleCameraViewPresetSelect(selection: CameraViewPresetSelection) {
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
      generationIdentityIds(generation).some((id) =>
        cancelledGenerationIdsRef.current.has(id),
      ) ||
      cancelledGenerationIdsRef.current.has(jobId)
    );
  }

  function cancelCurrentGeneration() {
    const generationToCancel = activeWorkflowGeneration;
    if (!generationToCancel) return;
    setCancelConfirmGeneration(generationToCancel);
  }

  function confirmCancelCurrentGeneration() {
    const generationToCancel = cancelConfirmGeneration ?? activeWorkflowGeneration;
    if (!generationToCancel) return;
    setCancelConfirmGeneration(undefined);
    if (!isRunningGeneration(generationToCancel)) return;
    const isTextureMap = isTextureMapGeneration(generationToCancel);
    const textureBatchId =
      typeof generationToCancel.metadata.textureBatchId === 'string'
        ? generationToCancel.metadata.textureBatchId
        : undefined;
    if (textureBatchId) cancelledTextureBatchIdsRef.current.add(textureBatchId);

    const liveGenerations = useGenerationStore.getState().generations;
    const generationsToCancel = isTextureMap
      ? liveGenerations.filter((generation) => {
          if (!isTextureMapGeneration(generation) || !isRunningGeneration(generation)) return false;
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
      generationIdentityIds(generation).forEach((id) =>
        cancelledGenerationIdsRef.current.add(id),
      );
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
        generation.metadata.provider === 'modelview-int8'
      )
        return;
      cancelRequests.push(
        generation.metadata.provider === 'comfyui-local'
          ? createComfyuiApiClient().cancelTextureMap(jobId)
          : createLiclickApiClient().cancelGenerationJob(jobId),
      );
    });

    const cancelsTexturePipeline = isTextureMap || texturePipelineProgress?.active === true;
    if (!isTextureMap) {
      submitLocksRef.current.delete(getGenerationChannel(generationToCancel));
    }
    finish();
    if (cancelsTexturePipeline) setTexturePipelineProgress(undefined);
    setGenerateNotice(undefined);
    void Promise.allSettled(cancelRequests).then((results) => {
      results.forEach((result) => {
        if (result.status === 'rejected') {
          console.warn('[Liclick 3D Texture] Could not cancel remote generation job:', result.reason);
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
    // The local build follows 7515224: its Atlas session owns both identity
    // and generation, so it must never enter the server-only account binder.
    if (authStrategy === 'atlas-workspace') {
      if (activeProviderStatus.atlas?.valid !== false) return true;
      setGenerateNotice({
        tone: 'info',
        message: '生图凭证已失效，正在重新打开飞书 / Atlas 授权。完成后会继续当前生成流程。',
      });
      pushToast({
        tone: 'warning',
        title: '需要重新授权生图服务',
        description: '当前登录仍有效，但生图凭证已过期。请在弹出的窗口完成授权。',
        dedupeKey: 'liclick-atlas-credential-refresh',
      });
      try {
        const result = await runFeishuLoginFlow({
          forceReauthorize: true,
          onStatus: (message) => {
            setGenerateNotice({ tone: 'info', message });
          },
        });
        if (!result.user) {
          throw new Error('授权服务没有返回用户信息，请重新尝试。');
        }
        setAuthenticated(
          result.user,
          result.authMode ?? 'feishu-oauth',
          result.providerStatus ?? activeProviderStatus,
        );
        const refreshedProviderStatus = await useAuthStore.getState().refreshProviderStatus();
        if (refreshedProviderStatus.atlas?.valid === false) {
          throw new Error('飞书 / Atlas 授权尚未生效，请完成授权后重试。');
        }
        setGenerateNotice({
          tone: 'info',
          message: '生图凭证已恢复，正在继续生成。',
        });
        return true;
      } catch (error) {
        const message = getUserFacingGenerationError(error, '生图凭证恢复失败，请重新授权后再试。');
        setGenerateNotice({ tone: 'error', message });
        pushToast({
          tone: 'error',
          title: '生图服务授权失败',
          description: message,
          dedupeKey: 'liclick-atlas-credential-refresh-failed',
        });
        throw new Error(message);
      }
    }
    if (authStrategy !== 'personal-local-component') {
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
    const authenticatedUser = useAuthStore.getState().user;
    if (!authenticatedUser) {
      throw new Error('飞书登录已完成，但没有读取到当前用户，请刷新页面后重试。');
    }
    const expectedEmail = authenticatedUser.email?.trim();
    if (
      isPersonalLiclickAccountForEmail(
        getCachedPersonalLiclickAccountStatus(),
        authenticatedUser.authSource === 'dev-mock' ? undefined : expectedEmail,
      )
    )
      return true;

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
      const message = error instanceof Error ? error.message : '个人莉刻账号绑定失败，请重新尝试。';
      setGenerateNotice({ tone: 'error', message });
      pushToast({
        tone: 'error',
        title: '个人莉刻账号不可用',
        description: message,
        dedupeKey: 'liclick-account-binding-failed',
      });
      throw error instanceof Error ? error : new Error(message);
    }
  }

  async function getTextureMapMultiviewCaptures(views: CameraViewItem[]) {
    const captures: Partial<Record<string, Capture>> = {};
    for (let index = 0; index < views.length; index += 1) {
      const view = views[index];
      if (!view) continue;
      if (captures[view.id]) continue;
      setCapturingCameraViews((current) => new Set([...current, view.id]));
      try {
        const capture = await captureTextureMapCameraView(view, { setAsLastCapture: false });
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
    requestedViewMode: TextureViewMode = 'multi',
  ) {
    if (!captureObjectId) throw new Error(t('importModelFirst'));
    if (requestedViews.length === 0) throw new Error('请先添加至少一个模型视角。');
    const isMultiviewRequest = requestedViewMode === 'multi';
    await requirePersonalLiclickAccount();
    const objectId = captureObjectId;
    const object = objects.find((item) => item.id === objectId);
    const texturePrompt = buildTextureMapPrompt(prompt);
    const objectMatrixWorld = getImportedModelMatrixWorld(objectId);
    updateTexturePipelineProgress(20, '准备多视角快照');
    const capturedViews = await getTextureMapMultiviewCaptures(requestedViews);
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
    updateProjectById(currentProject.id, { captures: persistedCaptures });
    const persistedCapturesById = new Map(
      persistedCaptures.map((capture) => [capture.id, capture]),
    );
    const viewCaptures = capturedViews.map((view) => ({
      ...view,
      capture: persistedCapturesById.get(view.capture.id) ?? view.capture,
    }));
    updateTexturePipelineProgress(40, '提交纹理任务');
    setGenerateNotice({
      tone: 'info',
      message: isMultiviewRequest
        ? `正在提交 ${viewCaptures.length} 个多视图纹理贴图任务。`
        : '正在提交当前单视图纹理贴图任务。',
    });

    const client = createLiclickApiClient();
    const textureBatchId = createId('texture-map-batch');
    const textureBatchWasCancelled = () =>
      cancelledTextureBatchIdsRef.current.has(textureBatchId);
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
          provider: 'liclick-atlas',
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
          void client
            .cancelGenerationJob(getGenerationJobId(cancelledSubmittedGeneration))
            .catch((error) =>
              console.warn(
                '[Liclick 3D Texture] Could not cancel late-submitted texture job:',
                error,
              ),
            );
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
    let pendingGeneration: Generation | undefined;
    let requestAbortController: AbortController | undefined;
    try {
      if (submitLocksRef.current.has('repaint') || previewIsGenerating) {
        setGenerateNotice({
          tone: 'warning',
          message: '当前工程已有局部重绘任务在运行，请等待该任务完成。',
        });
        pushToast({ tone: 'warning', title: '当前已有局部重绘任务在运行，请完成后再试。' });
        return false;
      }
      if (!currentProject || !captureObjectId) throw new Error(t('importModelFirst'));
      // Freeze the authored view synchronously at the click boundary. Login,
      // mask encoding and cold GPU preparation may take several seconds; the
      // user can keep orbiting without changing any of the three model inputs.
      const captureAspect = 1;
      const captureCameraSnapshot = snapshotCurrentCaptureCamera(captureAspect);
      submitLocksRef.current.add('repaint');
      if (authStatus !== 'authenticated' && !(await requireFeishuLogin())) return false;
      const objectId = captureObjectId;
      const textureMapCandidates = generations
        .filter((generation) => {
          if (!isTextureMapGeneration(generation)) return false;
          const generationProjectId = generation.metadata.projectId;
          if (typeof generationProjectId === 'string' && generationProjectId !== currentProject.id)
            return false;
          const generationObjectId = generation.metadata.objectId;
          if (
            typeof generationObjectId === 'string'
              ? generationObjectId !== objectId
              : !generationBelongsToObject(
                  generation,
                  objectId,
                  currentProject.captures,
                )
          )
            return false;
          const referenceId = generation.metadata.materialReferenceId;
          return (
            typeof referenceId === 'string' &&
            references.some(
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
      const textureMaterialReferenceId = textureMapCandidates[0]?.metadata.materialReferenceId;
      const materialReference =
        (typeof textureMaterialReferenceId === 'string'
          ? references.find((reference) => reference.id === textureMaterialReferenceId)
          : undefined) ?? selectedMultiviewReference;
      if (!materialReference || !isMultiviewReference(materialReference)) {
        setGenerateNotice({
          tone: 'warning',
          message: '请先在纹理贴图中选择或使用一张多视图材质参考图。',
        });
        pushToast({
          tone: 'warning',
          title: '缺少多视图材质参考',
          description: '局部重绘会自动使用当前模型最近一次纹理贴图对应的多视图参考图。',
          dedupeKey: 'generate-local-repaint-material-reference-required',
        });
        return false;
      }
      const initialMaskState = useSceneStore.getState();
      const hasUserPaintMask = initialMaskState.paintMaskHasContent;
      setGenerateNotice({
        tone: 'info',
        message: hasUserPaintMask
          ? '正在准备当前蒙版与视角。'
          : '正在准备当前视角；未绘制蒙版时将使用全图范围。',
      });
      // Commit the button state and progress text before any GPU capture work.
      // This guarantees an immediate visual response even on a cold renderer.
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      let currentPaintMaskDataUrl: string | undefined;
      // ModelView INT8 receives square 2K white-model and textured-preview
      // frames. The selection mask remains local-only and is never submitted.
      if (hasUserPaintMask) {
        // The selection accumulates camera-specific projections instead of using
        // model UVs. Reproject their union from the current camera immediately
        // before submission so it matches the captured frame.
        document.body.dataset.perfLocalRepaintPhase = 'button2-mask-capture';
        const maskCaptureStartedAt = performance.now();
        currentPaintMaskDataUrl =
          (await useSceneStore.getState().paintMaskCapture?.({
            aspect: captureAspect,
            camera: captureCameraSnapshot.camera,
          })) ??
          useSceneStore.getState().paintMaskDataUrl;
        document.body.dataset.localRepaintButton2MaskCaptureMs = (
          performance.now() - maskCaptureStartedAt
        ).toFixed(1);
        if (!currentPaintMaskDataUrl) throw new Error('无法读取已绘制的局部重绘蒙版。');
        useSceneStore.getState().setPaintMaskDataUrl(currentPaintMaskDataUrl, true);
        const maskSize = await getImageSize(currentPaintMaskDataUrl);
        if (!maskSize.width || !maskSize.height) throw new Error('无法读取当前局部重绘蒙版尺寸。');
      }
      document.body.dataset.perfLocalRepaintPhase = 'button2-view-capture';
      const viewCaptureStartedAt = performance.now();
      const capture = await captureCurrentView({
        objectId,
        resolution: 2048,
        framing: 'current',
        // Match the texture-map white-model input while retaining the authored
        // viewport framing so the local-only selection mask stays pixel aligned.
        colorMode: 'clay-target',
        aspect: captureAspect,
        cameraSnapshot: captureCameraSnapshot,
      });
      document.body.dataset.localRepaintButton2ViewCaptureMs = (
        performance.now() - viewCaptureStartedAt
      ).toFixed(1);
      setLastCapture(capture);
      document.body.dataset.perfLocalRepaintPhase = 'button2-viewport-reference-capture';
      const viewportReferenceCaptureStartedAt = performance.now();
      const viewportReference = await captureCurrentColorPreview({
        objectId,
        resolution: 2048,
        framing: 'current',
        // ModelView must receive authored BaseColor rather than a PBR-lit
        // presentation. The generated result is painted back as BaseColor and
        // receives lighting exactly once from the PBR viewport afterwards.
        colorMode: 'flat-target',
        aspect: captureAspect,
        cameraSnapshot: captureCameraSnapshot,
      });
      document.body.dataset.localRepaintButton2ViewportReferenceCaptureMs = (
        performance.now() - viewportReferenceCaptureStartedAt
      ).toFixed(1);
      // When no selection was painted, archive an opaque full-frame mask that
      // exactly matches this capture. It is used only by the returned result's
      // apply step and deliberately does not become the current canvas mask.
      currentPaintMaskDataUrl ??= createFullFrameMaskDataUrl(capture.width, capture.height);
      const currentPaintMaskRevision = useSceneStore.getState().paintMaskRevision;
      // captureCurrentView already archives the exact capture in projectStore.
      // Writing it a second time duplicated a large four-pass capture record and
      // forced avoidable subscribers/renders at the hottest point of button 2.
      const generationId = createId('local-repaint');
      // `renderScenePassesToPngUrl` intentionally returns a fast Blob URL for
      // immediate submission. A Blob URL dies on reload, so persist the exact
      // lossless mask in parallel and archive that durable URL with the finished
      // generation. This prevents repeated background staging failures after a
      // refresh without adding latency in front of the model request.
      const persistedPaintMaskUrlPromise = persistGeneratedImage(
        'generations',
        currentPaintMaskDataUrl,
        `${generationId}-mask.png`,
        undefined,
        currentProject.id,
      ).catch((error) => {
        console.warn('[Liclick 3D Texture] Could not persist local repaint mask:', error);
        return currentPaintMaskDataUrl;
      });
      pendingGeneration = {
        id: generationId,
        mode: 'inpaint',
        prompt: '',
        referenceIds: [materialReference.id],
        captureId: capture.id,
        status: 'running',
        metadata: {
          provider: 'modelview-int8',
          workflow: 'local-repaint',
          modelviewWorkflow: '2026.08.17-a9dbbca-flux2-klein-truev3-3input-r2',
          clientGenerationId: generationId,
          projectId: currentProject.id,
          objectId,
          materialReferenceId: materialReference.id,
          paintMaskRevision: currentPaintMaskRevision,
          paintMaskSource: hasUserPaintMask ? 'user' : 'full-frame-default',
          sourceColorMode: 'clay-target',
          viewportReferenceColorMode: 'flat-target',
          objectMatrixWorld: getImportedModelMatrixWorld(objectId),
          serverSubmitted: false,
          startedAt: new Date().toISOString(),
        },
      };
      start(pendingGeneration);
      addProjectGeneration(pendingGeneration);
      setGenerateNotice({
        tone: 'info',
        message: hasUserPaintMask
          ? '正在提交当前视角白模、多视图材质参考和当前视角预览；已绘蒙版仅用于结果回贴。'
          : '正在提交当前视角白模、多视图材质参考和当前视角预览；结果将按全图范围回贴。',
      });
      requestAbortController = new AbortController();
      generationAbortControllersRef.current.set(generationId, requestAbortController);
      const [whiteModelDataUrl, materialReferenceDataUrl, viewportReferenceDataUrl] =
        await Promise.all([
        urlToDataUrl(capture.colorUrl),
        urlToDataUrl(materialReference.url),
          urlToDataUrl(viewportReference.colorUrl),
        ]);
      const generation = await createModelviewApiClient().generateInpaint(
        {
          clientGenerationId: generationId,
          projectId: currentProject.id,
          captureId: capture.id,
          objectId,
          materialReferenceId: materialReference.id,
          image: { path: 'white-model.png', dataUrl: whiteModelDataUrl },
          materialImage: {
            path: 'multiview-material-reference.png',
            dataUrl: materialReferenceDataUrl,
          },
          viewportReference: {
            path: 'viewport-reference.png',
            dataUrl: viewportReferenceDataUrl,
          },
        },
        { signal: requestAbortController.signal },
      );
      if (isCancelledGeneration(pendingGeneration)) return false;
      // A returned image is the terminal foreground event. Local asset writes
      // can cold-start the desktop component and occasionally take seconds (or
      // stall while it reconnects); they must never keep the generate button,
      // submit lock or progress spinner alive after the server result exists.
      const completedGeneration: Generation = {
        ...generation,
        captureId: generation.captureId ?? capture.id,
        metadata: {
          ...pendingGeneration.metadata,
          ...generation.metadata,
          objectMatrixWorld: getImportedModelMatrixWorld(objectId),
          maskUrl: currentPaintMaskDataUrl,
          paintMaskRevision: currentPaintMaskRevision,
          sourceColorMode: 'clay-target',
          completedAt: generation.metadata.completedAt ?? new Date().toISOString(),
        },
      };
      syncGeneration(completedGeneration);
      if (completedGeneration.resultUrl) {
        ensureLocalRepaintSessionLayer(completedGeneration.id);
      }
      setGenerateNotice(undefined);
      setTexturePreviewMode('repaint');
      setTab('multiview');
      pushToast({
        tone: 'success',
        title: '局部生图已生成',
        description: '结果已显示在重绘效果图中。',
      });
      const persistedResultUrlPromise = completedGeneration.resultUrl
        ? persistGeneratedImage(
            'generations',
            completedGeneration.resultUrl,
            `${generationId}.png`,
            undefined,
            currentProject.id,
          ).catch((error) => {
            console.warn('[Liclick 3D Texture] Could not localize repaint result:', error);
            return completedGeneration.resultUrl;
          })
        : Promise.resolve(undefined);
      void Promise.all([persistedResultUrlPromise, persistedPaintMaskUrlPromise])
        .then(async ([persistedResultUrl, persistedPaintMaskUrl]) => {
          const durableGeneration: Generation = {
            ...completedGeneration,
            resultUrl: persistedResultUrl ?? completedGeneration.resultUrl,
            metadata: {
              ...completedGeneration.metadata,
              maskUrl: persistedPaintMaskUrl,
            },
          };
          syncGeneration(durableGeneration);
          await saveGenerationStateBestEffort();
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
      delete document.body.dataset.localRepaintGenerationBusy;
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
    useReferenceStore.getState().setSelectedReferences([singleReference.id]);
    setProjectReferences(nextReferences);
    await saveCriticalProjectState({ references: nextReferences });
    return multiviewReference;
  }

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
    if (submitLocksRef.current.has('single') || submitLocksRef.current.has('multiview')) {
      pushToast({ tone: 'warning', title: '当前已有生成任务在运行，请完成后再试。' });
      return;
    }
    submitLocksRef.current.add('single');
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
    }
  }

  async function handleGenerate() {
    if (tab === 'repaint') {
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
    try {
      if (submitLocksRef.current.has('multiview') || previewIsGenerating) {
        setGenerateNotice({
          tone: 'warning',
          message: '当前工程已有纹理贴图任务在运行，完成前不能再次提交同类任务。',
        });
        pushToast({ tone: 'warning', title: '当前已有纹理贴图任务在运行，请完成后再试。' });
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
      await handleTextureMapMultiviewGenerate(materialReference, resolvedViews, requestedViewMode);
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
      submitLocksRef.current.delete('multiview');
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
    let savedProjectSnapshot:
      | ReturnType<typeof useProjectStore.getState>['projects'][number]
      | undefined;
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
          (tab === 'multiview' && texturePipelineProgress?.active) ||
          previewIsGenerating ||
          displayedReferenceGroupGenerationState?.status === 'generating'
        }
        onClick={handleGenerate}
        icon={<Sparkles className="relative z-10 h-4 w-4" />}
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
            : previewIsGenerating
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
  );

  return (
    <>
      <Panel
        title={t('generatePanel')}
        className="generate-panel-adaptive flex h-full min-h-0 flex-col overflow-hidden"
      >
        {(isTextureMapTab || isLocalRepaintTab) && (
          <div
            data-texture-onboarding="single-view"
            data-onboarding-complete={displayedTexturePreviewMode === 'single' ? 'true' : 'false'}
          >
            <SegmentedControl<TexturePreviewMode>
              value={displayedTexturePreviewMode}
              options={[
                { value: 'multi', label: '多视图' },
                { value: 'single', label: '单视图' },
                { value: 'repaint', label: '重绘效果图' },
              ]}
              onChange={(value) => {
                setTexturePreviewMode(value);
                if (value !== 'repaint') {
                  setTextureViewMode(value);
                  setTab('multiview');
                }
              }}
              className="mb-2"
            />
          </div>
        )}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-white/10 bg-black/24">
          {displayedTexturePreviewMode !== 'multi' && (
            <div className="generate-preview-adaptive relative shrink-0 overflow-hidden bg-[#1b1b1b]">
              {displayedPreviewGeneration?.resultUrl ? (
                <button
                  type="button"
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
                    <div className="text-sm font-semibold text-white/72">暂无重绘效果图</div>
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
                <div className="absolute inset-0 grid place-items-center bg-black/62 text-white backdrop-blur-[2px]">
                  <GenerationProgressStatus
                    generation={displayedPreviewGeneration}
                    title={t('generating')}
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
                <div className="grid grid-cols-3 gap-2" role="tablist" aria-label="多视图预设">
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

            <label className="order-3 grid shrink-0 gap-1.5 text-xs font-semibold text-white/82">
              <span className="text-sm font-semibold text-white/88">纹理提示词</span>
              <textarea
                value={isLocalRepaintTab ? '' : prompt}
                readOnly={isLocalRepaintTab}
                aria-readonly={isLocalRepaintTab}
                placeholder={isLocalRepaintTab ? '使用固定材质迁移提示词，无需填写' : undefined}
                onChange={(event) => {
                  if (isLocalRepaintTab) return;
                  updateGenerationSettings(
                    isTextureMapTab
                      ? { textureMapPrompt: event.target.value }
                      : { liclickPrompt: event.target.value },
                  );
                }}
                className={`generate-prompt-adaptive w-full resize-none rounded-md border border-white/18 bg-black/34 p-2.5 text-[13px] leading-5 text-white outline-none transition placeholder:text-white/38 focus:border-liclick-pink ${
                  isLocalRepaintTab ? 'cursor-default' : ''
                }`}
              />
            </label>

            {(isTextureMapTab || isLocalRepaintTab) && (
              <section
                data-texture-onboarding="reference-images"
                data-onboarding-complete={
                  activeSelectedReferenceIds.length > 0 ? 'true' : 'false'
                }
                className="order-2 grid shrink-0 gap-2"
              >
                <ReferenceGroupPicker
                  disabled={
                    previewIsGenerating ||
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
