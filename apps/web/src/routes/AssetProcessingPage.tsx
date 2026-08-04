import {
  ArrowLeft,
  Box,
  ChevronDown,
  Check,
  CheckCircle2,
  Download,
  FileBox,
  FileImage,
  Gauge,
  ImagePlus,
  LoaderCircle,
  Map as MapIcon,
  Network,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  TriangleAlert,
  UploadCloud,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  type ChangeEvent,
  type DragEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';
import { UserMenu } from '@/components/auth/UserMenu';
import { BrandMark } from '@/components/common/BrandMark';
import { HistorySidePanel } from '@/components/history/HistorySidePanel';
import {
  assetJobArtifacts,
  assetJobError,
  assetJobErrorCode,
  assetJobId,
  cancelAssetJob,
  downloadVerifiedArtifact,
  getAssetJob,
  getAssetProcessingStatus,
  submitPreparedRetopologyProcessing,
  submitUvProcessing,
  subscribeAssetJobEvents,
  AssetProcessingHttpError,
  type AssetArtifact,
  type AssetJob,
  type AssetJobStatus,
  type AssetProcessingMode,
  type AssetProcessingStatus,
} from '@/services/assetProcessingApiClient';
import {
  assetProcessingStatusNeedsRetry,
  assetProcessingStatusRetryDelay,
} from '@/services/assetProcessingStatusRetry';
import {
  hasTrackedModuleAction,
  trackModuleAction,
  trackModuleActionOnce,
  type TelemetryModule,
} from '@/services/telemetryClient';
import { createId } from '@/utils/id';

type AssetProcessingPageProps = {
  mode: AssetProcessingMode;
  onBack: () => void;
  onLogout: () => void;
};

const terminalStatuses = new Set<AssetJobStatus>([
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
]);

const modeCopy = {
  uv: {
    eyebrow: 'AUTOMATIC UV',
    title: '自动展 UV',
    description: '自动分析模型结构，完成切缝、展开、统一密度与排布。',
    accent: 'emerald',
    Icon: MapIcon,
  },
  retopology: {
    eyebrow: 'AI RETOPOLOGY',
    title: '自动拓扑',
    description: '导入高模并设置目标面数，严格 QA 通过后自动交付生产级低模。',
    accent: 'blue',
    Icon: Network,
  },
} as const;

function telemetryModuleForMode(mode: AssetProcessingMode): TelemetryModule {
  return mode === 'uv' ? 'auto_uv' : 'auto_retopology';
}

function fileStem(fileName: string) {
  return fileName
    .replace(/\.[^.]+$/, '')
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72) || 'asset';
}

function externalAssetId(mode: AssetProcessingMode, file: File) {
  return `li3d:${fileStem(file.name)}:${mode}:${createId()}`;
}

function pendingSubmissionStorageKey(mode: AssetProcessingMode) {
  return `li3d:asset-processing:${mode}:pending-submission`;
}

function stableSubmissionKey(
  mode: AssetProcessingMode,
  file: File,
  fingerprint: string,
) {
  const storageKey = pendingSubmissionStorageKey(mode);
  try {
    const stored = JSON.parse(window.sessionStorage.getItem(storageKey) ?? 'null') as {
      fingerprint?: string;
      key?: string;
    } | null;
    if (stored?.fingerprint === fingerprint && stored.key) {
      return { fingerprint, key: stored.key };
    }
  } catch {
    // Invalid stale state is replaced below.
  }
  const pending = { fingerprint, key: externalAssetId(mode, file) };
  try {
    window.sessionStorage.setItem(storageKey, JSON.stringify(pending));
  } catch {
    // Restricted browser contexts may disable session storage. The in-memory
    // submission key is still stable for the current request attempt.
  }
  return pending;
}

function clearPendingSubmission(mode: AssetProcessingMode) {
  try {
    window.sessionStorage.removeItem(pendingSubmissionStorageKey(mode));
  } catch {
    // Storage cleanup is best-effort in restricted browser contexts.
  }
}

function submissionErrorMessage(error: unknown, fallback: string) {
  if (!(error instanceof AssetProcessingHttpError)) {
    return error instanceof Error ? error.message : fallback;
  }
  const guidance =
    error.status === 422 && error.code === 'ASSET_INPUT_INVALID'
      ? '请修正模型格式、对象或参数后重新提交。'
      : error.code === 'RETOPOLOGY_QUALITY_GATE_FAILED'
        ? '候选低模未通过轮廓、组件或拓扑硬性检查，未发布为最终模型。'
      : undefined;
  const diagnostics = [
    error.code,
    error.requestId ? `Request ${error.requestId}` : undefined,
  ].filter(Boolean).join(' · ');
  return [error.message, guidance, diagnostics].filter(Boolean).join(' ');
}

function formatBytes(bytes?: number) {
  if (!bytes || bytes < 1) return '';
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatSeconds(seconds?: number) {
  if (seconds === undefined || seconds < 0) return '计算中';
  if (seconds < 60) return `约 ${Math.ceil(seconds)} 秒`;
  return `约 ${Math.ceil(seconds / 60)} 分钟`;
}

function jobStatusLabel(status?: AssetJobStatus) {
  if (!status) return '等待提交';
  return {
    QUEUED: '等待调度',
    CLAIMED: 'Worker 已接单',
    RUNNING: '正在处理',
    SUCCEEDED: '处理完成',
    FAILED: '处理失败',
    CANCELLED: '已取消',
  }[status];
}

function artifactName(artifact: AssetArtifact) {
  return artifact.filename ?? artifact.name ?? artifact.kind ?? artifact.artifact_id ?? artifact.id ?? '交付文件';
}

function artifactToken(artifact: AssetArtifact) {
  return `${artifactName(artifact)} ${artifact.kind ?? ''} ${artifact.role ?? ''}`.toLowerCase();
}

function primaryArtifacts(artifacts: AssetArtifact[]) {
  return artifacts.filter((artifact) => {
    const token = artifactToken(artifact);
    return (
      /\.(blend|fbx)$/i.test(artifactName(artifact)) &&
      !/(baseline|source|audit|report|manifest)/.test(token)
    );
  });
}

function finalRetopologyArtifacts(artifacts: AssetArtifact[]) {
  return artifacts.filter((artifact) => {
    const name = artifactName(artifact);
    if (!/\.(blend|fbx)$/i.test(name)) return false;
    const token = artifactToken(artifact);
    return !/(candidate|baseline|reference|source|current|input|high(?:[_ -]?poly)?|audit|report|manifest|comparison|prompt|plan|events?|diagnostic)/.test(
      token,
    );
  });
}

const requiredUvArtifactSuffixes = [
  '_pbr_uv.blend',
  '_pbr_uv.fbx',
  '_pbr_uv_report.json',
  '_pbr_uv_qa.json',
  '_pbr_uv_fbx_qa.json',
] as const;

function artifactMetadataReady(artifact: AssetArtifact) {
  return Boolean(
    artifact.filename &&
    artifact.kind &&
    Number.isFinite(artifact.size_bytes) &&
    artifact.size_bytes >= 0 &&
    /^[a-f0-9]{64}$/i.test(artifact.sha256) &&
    artifact.download_url,
  );
}

function deliveryContract(mode: AssetProcessingMode, job: AssetJob | undefined, artifacts: AssetArtifact[]) {
  const invalidMetadata = artifacts.filter((artifact) => !artifactMetadataReady(artifact));
  if (mode === 'uv') {
    const names = artifacts.map((artifact) => artifact.filename.toLowerCase());
    const missing = requiredUvArtifactSuffixes.filter(
      (suffix) => names.filter((name) => name.endsWith(suffix)).length !== 1,
    );
    return {
      ready: artifacts.length === 5 && missing.length === 0 && invalidMetadata.length === 0,
      summary:
        missing.length > 0
          ? `UV 交付缺少或重复：${missing.join('、')}`
          : artifacts.length !== 5
            ? `UV 交付应为固定 5 项，当前为 ${artifacts.length} 项。`
            : invalidMetadata.length > 0
              ? '部分 UV 制品缺少 V4 文件名、类型、大小、SHA 或下载地址。'
              : '',
      };
  }
  const featured = finalRetopologyArtifacts(artifacts);
  const hasBlend = featured.some((artifact) => /\.blend$/i.test(artifact.filename));
  const hasFbx = featured.some((artifact) => /\.fbx$/i.test(artifact.filename));
  const qualitySource = {
    summary: job?.result?.summary,
    resultQa: job?.result?.qa,
    qa: job?.qa,
  };
  const failedQualityGates = [
    ['审计', 'audit_passed'],
    ['拓扑目标', 'topology_goal_met'],
    ['自动发布', 'automatic_final_promotion_allowed'],
  ].filter(([, key]) => findSummaryValue(qualitySource, [key]) === false);
  const invalidFinalMetadata = featured.filter((artifact) => !artifactMetadataReady(artifact));
  return {
    ready:
      hasBlend &&
      hasFbx &&
      failedQualityGates.length === 0 &&
      invalidFinalMetadata.length === 0,
    summary:
      !hasBlend || !hasFbx
        ? '重拓扑交付缺少 V5 最终 BLEND 或 FBX；候选模型和诊断文件不能作为正式交付。'
        : failedQualityGates.length > 0
          ? `重拓扑未通过 V5 质量门：${failedQualityGates.map(([label]) => label).join('、')}。`
        : invalidFinalMetadata.length > 0
          ? '最终重拓扑制品缺少 V5 文件名、类型、大小、SHA 或下载地址。'
          : '',
  };
}

function findSummaryValue(
  source: unknown,
  keys: string[],
  depth = 0,
): string | number | boolean | undefined {
  if (!source || typeof source !== 'object' || depth > 4) return undefined;
  const record = source as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      (typeof value === 'string' && value.length <= 80)
    ) {
      return value;
    }
  }
  for (const value of Object.values(record)) {
    const nested = findSummaryValue(value, keys, depth + 1);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function qualityFacts(mode: AssetProcessingMode, job: AssetJob) {
  const source = {
    summary: job.result?.summary,
    resultQa: job.result?.qa,
    qa: job.qa,
  };
  const candidates =
    mode === 'uv'
      ? [
          ['UV 岛', ['uv_islands', 'island_count']],
          ['重叠', ['overlap_count', 'overlapping_faces']],
          ['翻转', ['flipped_count', 'flipped_faces']],
          ['拉伸', ['stretch_ratio', 'max_stretch']],
        ]
      : [
          ['目标面数', ['target_faces']],
          ['实际面数', ['final_faces', 'final_face_count', 'face_count']],
          ['四边面', ['quad_faces', 'quad_count']],
          ['三角面', ['triangle_faces', 'triangle_count']],
          ['N-gon', ['ngon_faces', 'ngon_count']],
          ['执行算法', ['resolved_algorithm']],
        ];
  return candidates
    .map(([label, keys]) => ({
      label: label as string,
      value: findSummaryValue(source, keys as string[]),
    }))
    .filter((fact) => fact.value !== undefined)
    .slice(0, 6);
}

function inferReferenceView(
  fileName: string,
  index: number,
): 'front' | 'side' | 'top' | 'perspective' | 'detail' | 'other' {
  const name = fileName.toLowerCase();
  if (/(front|正面|前)/.test(name)) return 'front';
  if (/(side|left|right|侧面|侧)/.test(name)) return 'side';
  if (/(top|俯视|顶)/.test(name)) return 'top';
  if (/(detail|close|细节|特写)/.test(name)) return 'detail';
  if (/(back|rear|背面|后)/.test(name)) return 'other';
  if (/(perspective|three|透视|45)/.test(name)) return 'perspective';
  return (['front', 'side', 'top', 'perspective'] as const)[index % 4];
}

function FileDropCard({
  file,
  accept,
  title,
  description,
  extensions,
  icon: Icon,
  tone,
  onFile,
  disabled = false,
  compact = false,
  horizontal = false,
}: {
  file?: File;
  accept: string;
  title: string;
  description: string;
  extensions: string;
  icon: LucideIcon;
  tone: 'blue' | 'emerald';
  onFile: (file?: File) => void;
  disabled?: boolean;
  compact?: boolean;
  horizontal?: boolean;
}) {
  const [dragging, setDragging] = useState(false);
  const [fileError, setFileError] = useState<string>();
  const toneClass =
    tone === 'blue'
      ? 'border-blue-300/24 bg-blue-400/[0.055] text-blue-100 hover:border-blue-300/42'
      : 'border-emerald-300/24 bg-emerald-400/[0.055] text-emerald-100 hover:border-emerald-300/42';

  function acceptFile(nextFile: File) {
    const extension = `.${nextFile.name.split('.').pop()?.toLowerCase() ?? ''}`;
    const accepted = accept
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
    if (!accepted.includes(extension)) {
      setFileError(`不支持 ${extension || '该'} 文件，请选择 ${extensions}`);
      return;
    }
    setFileError(undefined);
    onFile(nextFile);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    const dropped = event.dataTransfer.files[0];
    if (dropped) acceptFile(dropped);
  }

  return (
    <div
      onDragEnter={(event) => {
        event.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={handleDrop}
      className={`group relative overflow-hidden rounded-2xl border text-left outline-none transition duration-200 ${
        horizontal
          ? 'min-h-[108px] p-4'
          : compact
            ? 'flex min-h-[138px] flex-col justify-between p-4'
            : 'flex min-h-[190px] flex-col justify-between p-6'
      } ${toneClass} ${dragging ? 'scale-[1.01] border-white/55 bg-white/[0.08]' : ''} ${disabled ? 'cursor-not-allowed opacity-55' : ''}`}
    >
      <input
        type="file"
        aria-label={file ? `替换${title}` : title}
        data-testid={`asset-file-${title}`}
        accept={accept}
        disabled={disabled}
        className="absolute inset-0 z-[1] h-full w-full cursor-pointer rounded-2xl opacity-[0.01] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/45 disabled:cursor-not-allowed"
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          const selected = event.target.files?.[0];
          if (selected) acceptFile(selected);
          event.target.value = '';
        }}
      />
      <div className="pointer-events-none absolute -right-14 -top-16 h-52 w-52 rounded-full border border-current opacity-[0.06]" />
      {horizontal ? (
        <div className="relative flex min-h-[74px] items-center gap-4 pr-1">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-current/20 bg-black/18">
            {file ? <Check className="h-5 w-5" /> : <Icon className="h-5 w-5" />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold tracking-[-0.02em] text-white">{title}</div>
            {file ? (
              <>
                <div className="mt-1 truncate text-sm font-medium text-white/68" title={file.name}>
                  {file.name}
                </div>
                <div className="mt-1 text-[11px] text-white/30">{formatBytes(file.size)} · 点击或拖入可替换</div>
              </>
            ) : (
              <>
                <p className="mt-1 text-xs leading-5 text-white/38">{description}</p>
                <div className="mt-1.5 text-[10px] tracking-wide text-white/25">{extensions}</div>
              </>
            )}
            {fileError && <p className="mt-2 text-xs text-rose-200/72">{fileError}</p>}
          </div>
          {file && (
            <button
              type="button"
              aria-label={`清除${title}`}
              disabled={disabled}
              onClick={(event) => {
                event.stopPropagation();
                setFileError(undefined);
                onFile(undefined);
              }}
              className="relative z-10 grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-white/10 bg-black/18 text-white/42 transition hover:bg-white/10 hover:text-white disabled:cursor-not-allowed"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      ) : (
        <>
      <div className="relative flex items-start justify-between gap-5">
        <span className={`grid place-items-center rounded-xl border border-current/20 bg-black/18 ${compact ? 'h-10 w-10' : 'h-12 w-12'}`}>
          {file ? <Check className="h-5 w-5" /> : <Icon className="h-5 w-5" />}
        </span>
        {file && (
          <button
            type="button"
            aria-label={`清除${title}`}
            disabled={disabled}
            onClick={(event) => {
              event.stopPropagation();
              setFileError(undefined);
              onFile(undefined);
            }}
            className="relative z-10 grid h-9 w-9 place-items-center rounded-lg border border-white/10 bg-black/18 text-white/42 transition hover:bg-white/10 hover:text-white disabled:cursor-not-allowed"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      <div className={`relative min-w-0 ${compact ? 'mt-4' : 'mt-8'}`}>
        <div className={`${compact ? 'text-sm' : 'text-lg'} font-semibold tracking-[-0.02em] text-white`}>{title}</div>
        {file ? (
          <>
            <div className="mt-2 truncate text-sm font-medium text-white/72" title={file.name}>
              {file.name}
            </div>
            <div className="mt-1 text-xs text-white/34">{formatBytes(file.size)} · 点击或拖入可替换</div>
          </>
        ) : (
          <>
            <p className={`${compact ? 'mt-1 text-xs leading-5' : 'mt-2 text-sm leading-6'} text-white/42`}>{description}</p>
            <div className="mt-3 inline-flex items-center gap-2 text-xs text-white/32">
              <UploadCloud className="h-3.5 w-3.5" />
              {extensions}
            </div>
          </>
        )}
        {fileError && <p className="mt-3 text-xs text-rose-200/72">{fileError}</p>}
      </div>
        </>
      )}
    </div>
  );
}

function SettingLabel({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col justify-between gap-3 border-b border-white/[0.055] py-4 last:border-0 sm:flex-row sm:items-center">
      <div>
        <div className="text-sm font-medium text-white/76">{label}</div>
        {description && <div className="mt-1 text-xs leading-5 text-white/30">{description}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function MiniSwitch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`inline-flex h-8 items-center gap-2 rounded-full border px-2.5 text-xs transition ${
        checked
          ? 'border-blue-300/24 bg-blue-400/10 text-blue-100/78'
          : 'border-white/10 bg-white/[0.035] text-white/38'
      }`}
    >
      <span className={`h-2 w-2 rounded-full ${checked ? 'bg-blue-300' : 'bg-white/20'}`} />
      {label}
    </button>
  );
}

function Segment<T extends string | number>({
  value,
  values,
  onChange,
  tone,
  label,
}: {
  value: T;
  values: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  tone: 'blue' | 'emerald';
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-xl border border-white/[0.075] bg-black/18 p-1">
      {values.map((item) => {
        const selected = item.value === value;
        return (
          <button
            key={String(item.value)}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(item.value)}
            className={`min-w-11 rounded-lg px-3 py-2 text-xs font-medium transition ${
              selected
                ? tone === 'blue'
                  ? 'bg-blue-400/16 text-blue-50 shadow-[0_6px_18px_rgba(59,130,246,.12)]'
                  : 'bg-emerald-400/15 text-emerald-50 shadow-[0_6px_18px_rgba(16,185,129,.11)]'
                : 'text-white/32 hover:bg-white/[0.045] hover:text-white/62'
            }`}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

function AdvancedSection({
  title = '高级设置',
  hint,
  children,
}: {
  title?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <details className="group rounded-2xl border border-white/[0.07] bg-[#111321]/72">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 outline-none">
        <span className="inline-flex items-center gap-2 text-sm font-medium text-white/58">
          <SlidersHorizontal className="h-4 w-4 text-white/34" />
          {title}
          {hint && <span className="text-xs font-normal text-white/24">{hint}</span>}
        </span>
        <ChevronDown className="h-4 w-4 text-white/28 transition group-open:rotate-180" />
      </summary>
      <div className="border-t border-white/[0.055] px-5 pb-1">{children}</div>
    </details>
  );
}

function backendFailureMessage(status: AssetProcessingStatus) {
  const message = status.message.trim();
  if (!message || /(?:已连接|服务可用|connected|\bready\b)/i.test(message)) return '';
  return message;
}

function serviceUnavailableReason(
  status: AssetProcessingStatus | undefined,
  loading: boolean,
  mode: AssetProcessingMode,
  requestError?: string,
) {
  if (loading) return '正在检查 Asset V4 服务，请稍候。';
  if (requestError) return requestError;
  if (!status) return requestError || '无法读取 Asset V4 服务状态，请重新检测。';

  const backendMessage = backendFailureMessage(status);
  const fallback = (message: string) => backendMessage || message;
  if (!status.tls.rejectUnauthorized) {
    return fallback('Asset V4 必须启用严格 TLS 证书校验。');
  }
  if (status.tls.customCaIntegrityValid === false) {
    if (!status.tls.customCaConfigured) {
      return fallback('Asset V4 公司 CA 证书尚未配置。');
    }
    if (!status.tls.customCaAvailable) {
      return fallback(status.tls.customCaError || 'Asset V4 公司 CA 证书文件不存在或不可读。');
    }
    if (status.tls.customCaError) return fallback(status.tls.customCaError);
    const actual = status.tls.customCaSha256;
    const expected = status.tls.expectedCaSha256;
    return fallback(
      actual && expected
        ? `Asset V4 公司 CA 证书 SHA-256 不匹配（实际 ${actual}，期望 ${expected}）。`
        : 'Asset V4 公司 CA 证书完整性校验未通过。',
    );
  }
  if (!status.configured) return fallback('Asset V4 服务尚未配置。');
  if (!status.reachable) return fallback('Asset V4 服务当前无法连接。');
  if (!status.authorized) {
    return fallback(
      status.authorizationMode === 'api-key'
        ? 'Asset V4 API Key 鉴权未通过。'
        : '本机 IP 尚未获得 Asset V4 访问权限。',
    );
  }
  if (status.capacityCheckPassed !== true) {
    return fallback('Asset V4 容量接口校验未通过。');
  }
  if (!status.capabilities[mode]) {
    return fallback(mode === 'uv' ? '自动展 UV 服务当前不可用。' : '自动拓扑服务当前不可用。');
  }
  if (!status.available) return fallback('Asset V4 服务当前不可用。');
  return undefined;
}

function capacitySummary(status?: AssetProcessingStatus) {
  const capacity = status?.capacity;
  if (status?.capacityCheckPassed !== true || !capacity) return undefined;
  return `${capacity.onlineWorkers} Worker · ${capacity.totalSlots} 槽位`;
}

function ReferenceImages({
  files,
  onFiles,
  disabled = false,
  embedded = false,
}: {
  files: File[];
  onFiles: (files: File[]) => void;
  disabled?: boolean;
  embedded?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  function appendFiles(list: FileList | File[]) {
    if (disabled) return;
    const images = Array.from(list).filter((file) => file.type.startsWith('image/'));
    const unique = [...files];
    for (const image of images) {
      if (unique.length >= 32) break;
      if (!unique.some((item) => item.name === image.name && item.size === image.size)) unique.push(image);
    }
    onFiles(unique);
  }

  return (
    <div className={`${embedded ? 'py-4' : 'rounded-2xl border border-white/[0.075] bg-[#111321]/84 p-5'} transition ${disabled ? 'opacity-55' : ''}`}>
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-sm font-semibold text-white/76">参考视图</div>
          <div className="mt-1 text-xs text-white/30">可选，最多 32 张；用于轮廓规划与自动质量核验，不写入几何。</div>
        </div>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={disabled}
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-3 text-xs text-white/58 transition hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed"
        >
          <ImagePlus className="h-4 w-4" />
          添加图片
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          disabled={disabled}
          className="hidden"
          onChange={(event) => {
            if (event.target.files) appendFiles(event.target.files);
            event.target.value = '';
          }}
        />
      </div>
      <div
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          if (disabled) return;
          appendFiles(event.dataTransfer.files);
        }}
        className={`mt-4 rounded-xl border border-dashed p-3 transition ${
          files.length ? 'border-white/[0.07] bg-black/10' : 'border-white/10 bg-black/14'
        }`}
      >
        {files.length === 0 ? (
          <div className="flex h-20 items-center justify-center gap-2 text-xs text-white/24">
            <FileImage className="h-4 w-4" />
            将正面、侧面、顶面或透视图拖到这里
          </div>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {files.map((file, index) => (
              <div key={`${file.name}-${file.size}`} className="flex min-w-0 items-center gap-3 rounded-lg border border-white/[0.065] bg-white/[0.025] px-3 py-2.5">
                <FileImage className="h-4 w-4 shrink-0 text-blue-200/54" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs text-white/64" title={file.name}>{file.name}</div>
                  <div className="mt-0.5 text-[10px] uppercase tracking-wider text-white/25">{inferReferenceView(file.name, index)}</div>
                </div>
                <button
                  type="button"
                  aria-label={`移除 ${file.name}`}
                  disabled={disabled}
                  onClick={() => onFiles(files.filter((item) => item !== file))}
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-white/28 transition hover:bg-white/[0.07] hover:text-white disabled:cursor-not-allowed"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ServiceBadge({
  status,
  loading,
  error,
  onRetry,
}: {
  status?: AssetProcessingStatus;
  loading: boolean;
  error?: string;
  onRetry: () => void;
}) {
  const ready = Boolean(
    !loading && !error && status?.available === true && status.capacityCheckPassed === true,
  );
  const configured = Boolean(status?.configured);
  const summary = capacitySummary(status);
  const caInvalid = status?.tls.customCaIntegrityValid === false;
  const failureDetail =
    error ||
    (status
      ? backendFailureMessage(status) || (caInvalid ? status.tls.customCaError : undefined)
      : undefined);
  return (
    <button
      type="button"
      onClick={onRetry}
      disabled={loading}
      className={`inline-flex self-start items-center gap-2.5 rounded-full border px-3.5 py-2 text-left transition disabled:cursor-wait ${
        ready
          ? 'border-emerald-300/12 bg-emerald-400/[0.045] hover:border-emerald-300/24'
          : 'border-amber-300/14 bg-amber-400/[0.045] hover:border-amber-300/24'
      }`}
      title="重新检测 Asset V4 服务"
    >
      {loading ? (
        <LoaderCircle className="h-3.5 w-3.5 animate-spin text-white/40" />
      ) : (
        <span className={`h-2 w-2 rounded-full ${ready ? 'bg-emerald-300' : 'bg-amber-300'}`} />
      )}
      <span className="text-xs font-medium text-white/58">
        {loading
          ? '正在检测服务'
          : ready
            ? summary ?? '服务可用'
            : caInvalid
              ? 'CA 证书校验失败'
              : status?.reachable && status.authorized && status.capacityCheckPassed !== true
                ? '容量检查失败'
                : !status
                  ? '服务检测失败'
                  : configured
                    ? '等待服务鉴权'
                    : '服务未配置'}
      </span>
      {!ready && !loading && (
        <span className="hidden max-w-56 truncate text-[10px] text-white/26 sm:inline">
          {failureDetail || '点击重新检测'}
        </span>
      )}
    </button>
  );
}

function ArtifactList({
  mode,
  job,
  artifacts = assetJobArtifacts(job),
}: {
  mode: AssetProcessingMode;
  job: AssetJob;
  artifacts?: AssetArtifact[];
}) {
  const jobId = assetJobId(job);
  const [downloading, setDownloading] = useState<string>();
  const [verifiedArtifacts, setVerifiedArtifacts] = useState<Set<string>>(
    () => new Set(),
  );
  const [downloadError, setDownloadError] = useState<string>();

  async function downloadArtifact(artifact: AssetArtifact, index: number) {
    if (!jobId) return;
    const key =
      artifact.artifact_id ??
      artifact.id ??
      `${artifactName(artifact)}-${index}`;
    setDownloading(key);
    setDownloadError(undefined);
    try {
      await downloadVerifiedArtifact(jobId, artifact);
      setVerifiedArtifacts((current) => new Set(current).add(key));
      trackModuleAction(telemetryModuleForMode(mode), 'download');
    } catch (artifactError) {
      setDownloadError(
        submissionErrorMessage(artifactError, '交付文件下载或校验失败。'),
      );
    } finally {
      setDownloading(undefined);
    }
  }

  if (artifacts.length === 0) {
    return <div className="rounded-xl border border-dashed border-white/10 px-4 py-8 text-center text-xs text-white/28">严格 QA 通过后会原子发布交付文件</div>;
  }
  return (
    <div className="space-y-2">
      {artifacts.map((artifact, index) => {
        const key =
          artifact.artifact_id ??
          artifact.id ??
          `${artifactName(artifact)}-${index}`;
        const isDownloading = downloading === key;
        const isVerified = verifiedArtifacts.has(key);
        return (
          <button
            type="button"
            key={key}
            disabled={!jobId || isDownloading}
            onClick={() => void downloadArtifact(artifact, index)}
            className="group flex w-full min-w-0 items-center gap-3 rounded-xl border border-white/[0.065] bg-white/[0.025] px-3 py-3 text-left transition hover:border-white/15 hover:bg-white/[0.055] disabled:cursor-wait disabled:opacity-45"
          >
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white/[0.045] text-white/42">
              {isDownloading ? (
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium text-white/68" title={artifactName(artifact)}>{artifactName(artifact)}</span>
              <span className="mt-0.5 block text-[10px] text-white/26">
                {[
                  artifact.kind,
                  formatBytes(artifact.size_bytes),
                  isVerified
                    ? '三方 SHA 已校验'
                    : artifact.sha256
                      ? 'SHA 信息已就绪'
                      : undefined,
                ].filter(Boolean).join(' · ') || 'Asset Artifact'}
              </span>
            </span>
          </button>
        );
      })}
      {downloadError && (
        <div className="rounded-lg border border-rose-300/12 bg-rose-400/[0.045] px-3 py-2 text-[10px] leading-4 text-rose-100/56">
          {downloadError}
        </div>
      )}
    </div>
  );
}

function QualitySummary({ mode, job }: { mode: AssetProcessingMode; job: AssetJob }) {
  const facts = qualityFacts(mode, job);
  if (facts.length === 0) return null;
  return (
    <div className="mt-5 rounded-xl border border-emerald-300/12 bg-emerald-400/[0.04] p-4">
      <div className="flex items-center gap-2 text-xs font-semibold text-emerald-100/70">
        <ShieldCheck className="h-3.5 w-3.5" />
        严格 QA 已通过
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
        {facts.map((fact) => (
          <div key={fact.label} className="flex min-w-0 items-center justify-between gap-3 text-[11px]">
            <span className="text-white/30">{fact.label}</span>
            <span className="truncate font-medium tabular-nums text-white/68">{String(fact.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function JobPanel({
  mode,
  job,
  busy,
  error,
  onCancel,
}: {
  mode: AssetProcessingMode;
  job?: AssetJob;
  busy: boolean;
  error?: string;
  onCancel: () => void;
}) {
  const progress = Math.min(100, Math.max(0, job?.progress ?? 0));
  const succeeded = job?.status === 'SUCCEEDED';
  const failed = job?.status === 'FAILED';
  const showSpinner = busy && !terminalStatuses.has(job?.status ?? 'QUEUED');
  const artifacts = assetJobArtifacts(job);
  const featuredArtifacts =
    mode === 'retopology' ? finalRetopologyArtifacts(artifacts) : primaryArtifacts(artifacts);
  const diagnosticArtifacts = artifacts.filter((artifact) => !featuredArtifacts.includes(artifact));
  const errorCode = assetJobErrorCode(job);
  const contract = deliveryContract(mode, job, artifacts);
  const deliveryReady = succeeded && contract.ready;
  const [downloadingAll, setDownloadingAll] = useState(false);
  const [deliveryDownloadError, setDeliveryDownloadError] = useState<string>();

  async function downloadAllArtifacts() {
    const jobId = job ? assetJobId(job) : '';
    if (!jobId || !deliveryReady || downloadingAll) return;
    setDownloadingAll(true);
    setDeliveryDownloadError(undefined);
    try {
      const fbxArtifact = featuredArtifacts.find((artifact) =>
        /\.fbx$/i.test(artifact.filename),
      );
      if (!fbxArtifact) {
        throw new Error('当前交付中没有可下载的 FBX 模型。');
      }
      await downloadVerifiedArtifact(jobId, fbxArtifact);
      trackModuleAction(telemetryModuleForMode(mode), 'download');
    } catch (artifactError) {
      setDeliveryDownloadError(
        submissionErrorMessage(artifactError, '完整交付下载或校验失败。'),
      );
    } finally {
      setDownloadingAll(false);
    }
  }

  return (
    <aside className="rounded-2xl border border-white/[0.075] bg-[#111321]/82 p-4 shadow-[0_20px_60px_rgba(0,0,0,.2)] lg:sticky lg:top-6 lg:self-start">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-white/22">TASK STATUS</div>
          <h2 className="mt-1.5 text-base font-semibold tracking-[-0.02em] text-white/80">
            {job ? jobStatusLabel(job.status) : '等待开始'}
          </h2>
        </div>
        <span className={`grid h-8 w-8 place-items-center rounded-lg ${
          failed
              ? 'bg-rose-400/10 text-rose-200'
              : succeeded
                ? 'bg-emerald-400/10 text-emerald-200'
                : mode === 'uv'
                  ? 'bg-emerald-400/10 text-emerald-200'
                  : 'bg-blue-400/10 text-blue-200'
        }`}>
          {showSpinner ? <LoaderCircle className="h-4 w-4 animate-spin" /> : succeeded ? <CheckCircle2 className="h-4 w-4" /> : <Gauge className="h-4 w-4" />}
        </span>
      </div>

      {job ? (
        <>
          <div className="mt-4">
            <div className="flex items-center justify-between text-xs">
              <span className="text-white/38">{job.stage_message ?? job.stage ?? '任务已进入调度中心'}</span>
              <span className="font-medium text-white/66">{Math.round(progress)}%</span>
            </div>
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/[0.065]">
              <div
                className={`h-full rounded-full transition-[width] duration-500 ${mode === 'uv' ? 'bg-gradient-to-r from-emerald-500 to-cyan-300' : 'bg-gradient-to-r from-blue-500 to-violet-400'}`}
                style={{ width: `${progress}%` }}
              />
            </div>
            <div className="mt-2 flex items-center justify-between text-[10px] text-white/25">
              <span className="truncate pr-3">{job.worker_id ?? '等待 Worker 分配'}</span>
              <span>{formatSeconds(job.timing?.estimated_remaining_seconds)}</span>
            </div>
          </div>

          {(failed || error || assetJobError(job)) && (
            <div className="mt-5 rounded-xl border border-rose-300/14 bg-rose-400/[0.055] p-4 text-xs leading-5 text-rose-100/66">
              <div className="flex items-start gap-3">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error ?? assetJobError(job) ?? '任务未通过严格 QA，请检查输入后重试。'}</span>
              </div>
              {(errorCode || assetJobId(job)) && (
                <div className="mt-2 pl-7 text-[10px] text-rose-100/35">
                  {[errorCode, assetJobId(job) ? `Job ${assetJobId(job)}` : undefined].filter(Boolean).join(' · ')}
                </div>
              )}
            </div>
          )}

          {!terminalStatuses.has(job.status) && (
            <button
              type="button"
              onClick={onCancel}
              className="mt-5 inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/[0.035] text-xs text-white/46 transition hover:bg-white/[0.075] hover:text-white"
            >
              <X className="h-3.5 w-3.5" />
              取消任务
            </button>
          )}

          {succeeded && (
            <div className="mt-6">
              {!contract.ready && (
                <div className="mb-4 rounded-xl border border-rose-300/14 bg-rose-400/[0.055] p-4 text-xs leading-5 text-rose-100/66">
                  <div className="flex items-start gap-3">
                    <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>交付不完整：{contract.summary}</span>
                  </div>
                </div>
              )}
              {deliveryReady && <QualitySummary mode={mode} job={job} />}
              <div className="mb-3 flex items-center justify-between">
                <span className="text-xs font-semibold text-white/62">
                  {mode === 'uv' ? 'V4 固定交付' : 'V5 最终模型'}
                </span>
                <span className="text-[10px] text-white/26">
                  {mode === 'uv' ? `${artifacts.length}/5 项` : `${featuredArtifacts.length} 项`}
                </span>
              </div>
              <ArtifactList mode={mode} job={job} artifacts={featuredArtifacts.length ? featuredArtifacts : artifacts} />
              {featuredArtifacts.length > 0 && diagnosticArtifacts.length > 0 && (
                <details className="group mt-3 rounded-xl border border-white/[0.065] bg-white/[0.018]">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-3 text-[11px] text-white/34">
                    QA 证据与高级诊断
                    <span className="inline-flex items-center gap-2">
                      {diagnosticArtifacts.length} 项
                      <ChevronDown className="h-3.5 w-3.5 transition group-open:rotate-180" />
                    </span>
                  </summary>
                  <div className="border-t border-white/[0.05] p-2">
                    <ArtifactList mode={mode} job={job} artifacts={diagnosticArtifacts} />
                  </div>
                </details>
              )}
              {deliveryReady && (
                <button
                  type="button"
                  disabled={downloadingAll}
                  onClick={() => void downloadAllArtifacts()}
                  className="mt-4 inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-emerald-300/14 bg-emerald-400/[0.055] text-xs font-medium text-emerald-100/68 transition hover:border-emerald-300/26 hover:bg-emerald-400/[0.09] disabled:cursor-wait disabled:opacity-50"
                >
                  {downloadingAll ? (
                    <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Download className="h-3.5 w-3.5" />
                  )}
                  {downloadingAll
                    ? '正在校验并下载…'
                    : mode === 'uv'
                      ? '下载 UV FBX'
                      : '下载拓扑 FBX'}
                </button>
              )}
              {deliveryDownloadError && (
                <div className="mt-3 rounded-lg border border-rose-300/12 bg-rose-400/[0.045] px-3 py-2 text-[10px] leading-4 text-rose-100/56">
                  {deliveryDownloadError}
                </div>
              )}
            </div>
          )}
        </>
      ) : (
        <div className="mt-3">
          {error && (
            <div className="mb-5 flex items-start gap-3 rounded-xl border border-rose-300/14 bg-rose-400/[0.055] p-4 text-xs leading-5 text-rose-100/66">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              {error}
            </div>
          )}
          <p className="text-xs leading-5 text-white/30">
            {mode === 'uv'
              ? '导入模型并开始后，在这里查看处理进度。'
              : '导入高模并开始后，在这里查看生成进度。'}
          </p>
          <div className="mt-3 flex items-center gap-2 text-[10px] text-white/20">
            <ShieldCheck className={`h-3.5 w-3.5 ${mode === 'uv' ? 'text-emerald-200/50' : 'text-blue-200/50'}`} />
            严格 QA 通过后自动交付
          </div>
        </div>
      )}
    </aside>
  );
}

function AutoUvWorkspace({
  serviceReady,
  serviceBlockReason,
  onJob,
  setBusy,
  busy,
  setError,
}: {
  serviceReady: boolean;
  serviceBlockReason?: string;
  onJob: (job: AssetJob) => void;
  setBusy: (busy: boolean) => void;
  busy: boolean;
  setError: (error?: string) => void;
}) {
  const [asset, setAsset] = useState<File>();
  const [resolution, setResolution] = useState<1024 | 2048 | 4096 | 8192>(2048);
  const [hiddenAxis, setHiddenAxis] = useState<'x+' | 'x-' | 'y+' | 'y-' | 'z+' | 'z-' | 'auto'>('y+');
  const [hardEdgeAngle, setHardEdgeAngle] = useState(75);
  const [padding, setPadding] = useState(10);
  const submissionKeyRef = useRef<{ fingerprint: string; key: string } | undefined>(undefined);

  async function submit() {
    if (!asset || busy || !serviceReady) return;
    setBusy(true);
    setError(undefined);
    try {
      const fingerprint = JSON.stringify({
        file: [asset.name, asset.size, asset.lastModified],
        resolution,
        hiddenAxis,
        hardEdgeAngle,
        padding,
      });
      if (submissionKeyRef.current?.fingerprint !== fingerprint) {
        submissionKeyRef.current = stableSubmissionKey('uv', asset, fingerprint);
      }
      const submission = await submitUvProcessing({
        asset,
        metadata: {
          external_asset_id: submissionKeyRef.current.key,
          options: {
            hidden_axis: hiddenAxis,
            hard_edge_angle_degrees: hardEdgeAngle,
            resolution,
            padding_px: padding,
            texel_density_mode: 'uniform',
            qa_profile: 'pbr-v1',
          },
        },
      });
      const submissionJobId = assetJobId(submission);
      if (submissionJobId) trackModuleActionOnce('auto_uv', 'start', submissionJobId);
      onJob({
        ...submission,
        progress: 0,
        stage: 'QUEUED',
        stage_message: '任务已提交，等待 Asset Worker',
      });
      clearPendingSubmission('uv');
      submissionKeyRef.current = undefined;
    } catch (submitError) {
      setError(submissionErrorMessage(submitError, '自动展 UV 提交失败。'));
    } finally {
      setBusy(false);
    }
  }

  const submitBlockReason =
    serviceBlockReason ?? (!asset ? '请先导入一个需要展开 UV 的模型。' : undefined);
  const hiddenAxisLabel = {
    auto: '自动切缝',
    'x-': '左侧缝',
    'x+': '右侧缝',
    'y-': '前侧缝',
    'y+': '后侧缝',
    'z-': '底部缝',
    'z+': '顶部缝',
  }[hiddenAxis];

  return (
    <section className="overflow-hidden rounded-2xl border border-white/[0.075] bg-[#111321]/80">
      <div className="flex items-center justify-between gap-4 border-b border-white/[0.055] px-5 py-4">
        <div>
          <div className="text-[10px] font-semibold tracking-[0.16em] text-emerald-200/44">01 · PREPARE</div>
          <h2 className="mt-1 text-sm font-semibold text-white/76">模型与输出</h2>
        </div>
        <span className={`rounded-full border px-3 py-1.5 text-[11px] ${
          asset
            ? 'border-emerald-300/16 bg-emerald-400/[0.06] text-emerald-100/68'
            : 'border-white/[0.07] bg-white/[0.025] text-white/28'
        }`}>
          {asset ? '模型已就绪' : '等待模型'}
        </span>
      </div>

      <fieldset disabled={busy} className="space-y-4 p-5 disabled:opacity-55">
        <FileDropCard
          file={asset}
          accept=".fbx,.obj,.glb,.gltf,.blend"
          title="模型文件"
          description="拖入模型，或点击选择"
          extensions="FBX · OBJ · GLB · GLTF · BLEND"
          icon={FileBox}
          tone="emerald"
          onFile={setAsset}
          disabled={busy}
          horizontal
        />

        <div className="flex flex-col justify-between gap-3 rounded-2xl border border-white/[0.065] bg-black/10 px-4 py-3.5 sm:flex-row sm:items-center">
          <div>
            <div className="text-sm font-medium text-white/70">输出尺寸</div>
            <div className="mt-1 text-[11px] text-white/26">2K 适合大多数生产模型</div>
          </div>
          <Segment
            value={resolution}
            values={[
              { value: 1024, label: '1K' },
              { value: 2048, label: '2K' },
              { value: 4096, label: '4K' },
              { value: 8192, label: '8K' },
            ]}
            onChange={setResolution}
            tone="emerald"
            label="UV 输出尺寸"
          />
        </div>

        <AdvancedSection hint={`${hiddenAxisLabel} · ${hardEdgeAngle}° · ${padding}px`}>
          <SettingLabel label="切缝朝向" description="优先将切缝放到不易观察的一侧">
            <Segment
              value={hiddenAxis}
              values={[
                { value: 'auto', label: '自动' },
                { value: 'x-', label: '左' },
                { value: 'x+', label: '右' },
                { value: 'y-', label: '前' },
                { value: 'y+', label: '后' },
                { value: 'z-', label: '底' },
                { value: 'z+', label: '顶' },
              ]}
              onChange={setHiddenAxis}
              tone="emerald"
              label="隐藏缝方向"
            />
          </SettingLabel>
          <SettingLabel label="硬边阈值" description="超过该角度的边会切开，减少烘焙伪影">
            <label className="flex items-center gap-3">
              <input
                type="range"
                min={1}
                max={179}
                value={hardEdgeAngle}
                onChange={(event) => setHardEdgeAngle(Number(event.target.value))}
                className="bake-range w-28 accent-emerald-400"
              />
              <span className="w-10 text-right text-xs font-medium text-white/62">{hardEdgeAngle}°</span>
            </label>
          </SettingLabel>
          <SettingLabel label="UV 间距" description="以输出贴图像素计">
            <label className="flex items-center gap-3">
              <input
                type="range"
                min={2}
                max={128}
                value={padding}
                onChange={(event) => setPadding(Number(event.target.value))}
                className="bake-range w-28 accent-emerald-400"
              />
              <span className="w-10 text-right text-xs font-medium text-white/62">{padding}px</span>
            </label>
          </SettingLabel>
        </AdvancedSection>
      </fieldset>

      <div className="border-t border-white/[0.055] p-5">
        <button
          type="button"
          disabled={!asset || busy || !serviceReady}
          onClick={() => void submit()}
          className="flex h-14 w-full items-center justify-center gap-3 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 text-sm font-semibold text-white shadow-[0_18px_42px_rgba(16,185,129,.18)] transition hover:-translate-y-0.5 hover:brightness-110 active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:translate-y-0"
        >
          {busy ? <LoaderCircle className="h-4.5 w-4.5 animate-spin" /> : <MapIcon className="h-4.5 w-4.5" />}
          {busy ? '正在处理 UV…' : asset ? '开始自动展 UV' : '请先导入模型'}
        </button>
        <div className="mt-3 flex min-h-4 items-center justify-center gap-2 text-[11px] text-white/24">
          {serviceBlockReason ? (
            <>
              <TriangleAlert className="h-3.5 w-3.5 text-amber-200/58" />
              <span className="text-amber-100/52">{submitBlockReason}</span>
            </>
          ) : (
            <span>源文件不会被修改</span>
          )}
        </div>
      </div>
    </section>
  );
}

function AutoRetopologyWorkspace({
  serviceReady,
  serviceBlockReason,
  onJob,
  setBusy,
  busy,
  setError,
}: {
  serviceReady: boolean;
  serviceBlockReason?: string;
  onJob: (job: AssetJob) => void;
  setBusy: (busy: boolean) => void;
  busy: boolean;
  setError: (error?: string) => void;
}) {
  const [highModel, setHighModel] = useState<File>();
  const [preparing, setPreparing] = useState(false);
  const [referenceImages, setReferenceImages] = useState<File[]>([]);
  const [targetFaces, setTargetFaces] = useState(500);
  const [targetFacesInput, setTargetFacesInput] = useState('500');
  const [preserveSharp, setPreserveSharp] = useState(true);
  const [preserveBoundary, setPreserveBoundary] = useState(true);
  const [requireClosed, setRequireClosed] = useState(false);
  const [userRequest, setUserRequest] = useState(
    '以高模轮廓为形状依据；平面自动降面；曲面、轮廓、孔洞、硬边和组件边界保留必要密度；四边面为主，允许受控三角面，禁止 N-gon。',
  );
  const submissionKeyRef = useRef<{ fingerprint: string; key: string } | undefined>(undefined);

  function applyTargetFaces(value: number) {
    const nextValue = Math.min(5000, Math.max(50, Math.round(value)));
    setTargetFaces(nextValue);
    setTargetFacesInput(String(nextValue));
  }

  function parseTargetFacesInput(value: string) {
    if (!value.trim()) return undefined;
    const nextValue = Number(value);
    return Number.isInteger(nextValue) && nextValue >= 50 && nextValue <= 5000 ? nextValue : undefined;
  }

  function commitTargetFacesInput() {
    const nextValue = parseTargetFacesInput(targetFacesInput);
    applyTargetFaces(nextValue ?? targetFaces);
  }

  async function submit() {
    if (busy || !serviceReady || !highModel) return;
    const submittedTargetFaces = parseTargetFacesInput(targetFacesInput);
    if (submittedTargetFaces === undefined) {
      setError('目标面数必须是 50–5000 之间的整数。');
      return;
    }

    const fingerprint = JSON.stringify({
      source: [highModel.name, highModel.size, highModel.lastModified],
      references: referenceImages.map((file) => [file.name, file.size, file.lastModified]),
      targetFaces: submittedTargetFaces,
      preserveSharp,
      preserveBoundary,
      requireClosed,
      userRequest,
    });
    if (submissionKeyRef.current?.fingerprint !== fingerprint) {
      submissionKeyRef.current = stableSubmissionKey(
        'retopology',
        highModel,
        fingerprint,
      );
    }
    setBusy(true);
    setError(undefined);
    try {
      const metadata = {
        external_asset_id: submissionKeyRef.current.key,
        options: {
          algorithm: 'agent' as const,
          topology_style: 'quad_dominant' as const,
          target_faces: submittedTargetFaces,
          preserve_sharp: preserveSharp,
          preserve_boundary: preserveBoundary,
          render_resolution: 512,
          max_repair_rounds: 2 as const,
          require_closed: requireClosed,
        },
        reference_views: referenceImages.map((file, index) => ({
          filename: file.name,
          view: inferReferenceView(file.name, index),
        })),
        user_request: userRequest.trim(),
      };
      setPreparing(true);
      const submission = await submitPreparedRetopologyProcessing({
        highModel,
        referenceImages,
        metadata,
      });
      setPreparing(false);
      const submissionJobId = assetJobId(submission);
      if (submissionJobId) {
        trackModuleActionOnce('auto_retopology', 'start', submissionJobId);
      }
      onJob({
        ...submission,
        external_asset_id: submission.external_asset_id ?? metadata.external_asset_id,
        progress: 0,
        stage: 'QUEUED',
        stage_message: '任务已提交，等待 Asset Worker',
      });
      clearPendingSubmission('retopology');
      submissionKeyRef.current = undefined;
    } catch (submitError) {
      setError(submissionErrorMessage(submitError, '自动拓扑提交失败。'));
    } finally {
      setPreparing(false);
      setBusy(false);
    }
  }

  const modelReady = Boolean(highModel);
  const submitBlockReason =
    serviceBlockReason ??
    (!modelReady ? '请先导入需要拓扑的高模。' : undefined);

  return (
    <section className="overflow-hidden rounded-2xl border border-white/[0.075] bg-[#111321]/80">
      <div className="flex items-center justify-between gap-4 border-b border-white/[0.055] px-5 py-4">
        <div>
          <div className="text-[10px] font-semibold tracking-[0.16em] text-blue-200/44">01 · PREPARE</div>
          <h2 className="mt-1 text-sm font-semibold text-white/76">导入高模</h2>
        </div>
        <span className={`rounded-full border px-3 py-1.5 text-[11px] ${
          modelReady
            ? 'border-blue-300/16 bg-blue-400/[0.06] text-blue-100/68'
            : 'border-white/[0.07] bg-white/[0.025] text-white/30'
        }`}>
          {modelReady ? '模型已就绪' : '等待模型'}
        </span>
      </div>

      <fieldset disabled={busy} className="p-5 disabled:opacity-55">
        <FileDropCard
          file={highModel}
          accept=".fbx,.obj,.glb,.gltf,.blend"
          title="高模文件"
          description="拖入高模，或点击选择；Li3D 会自动准备内部低模基线"
          extensions="FBX · OBJ · GLB · GLTF · BLEND"
          icon={Box}
          tone="blue"
          onFile={setHighModel}
          disabled={busy}
          horizontal
        />

        <div className="my-5 h-px bg-white/[0.055]" />

        <div className="mb-3">
          <div className="text-[10px] font-semibold tracking-[0.16em] text-blue-200/44">02 · OUTPUT</div>
          <h2 className="mt-1 text-sm font-semibold text-white/76">输出要求</h2>
        </div>

        <div className="rounded-2xl border border-white/[0.065] bg-black/10 px-4">
          <SettingLabel label="目标面数" description="范围 50–5000 面，结果会按轮廓复杂度小幅调整">
            <div className="flex min-w-0 flex-1 items-center justify-end gap-4 sm:min-w-[360px]">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <span className="text-[10px] tabular-nums text-white/24">50</span>
                <input
                  type="range"
                  min={50}
                  max={5000}
                  step={1}
                  value={targetFaces}
                  aria-label="目标面数滑块"
                  aria-valuetext={`${targetFaces} 面`}
                  onChange={(event) => applyTargetFaces(Number(event.target.value))}
                  className="h-1.5 min-w-28 flex-1 cursor-pointer appearance-none rounded-full bg-white/[0.08] outline-none [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:cursor-grab [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-blue-100/80 [&::-moz-range-thumb]:bg-blue-400 [&::-moz-range-thumb]:shadow-[0_0_14px_rgba(96,165,250,0.45)] [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:cursor-grab [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-blue-100/80 [&::-webkit-slider-thumb]:bg-blue-400 [&::-webkit-slider-thumb]:shadow-[0_0_14px_rgba(96,165,250,0.45)] active:[&::-moz-range-thumb]:cursor-grabbing active:[&::-webkit-slider-thumb]:cursor-grabbing"
                  style={{
                    background: `linear-gradient(to right, rgba(96, 165, 250, 0.82) 0%, rgba(129, 140, 248, 0.72) ${((targetFaces - 50) / 4950) * 100}%, rgba(255, 255, 255, 0.08) ${((targetFaces - 50) / 4950) * 100}%, rgba(255, 255, 255, 0.08) 100%)`,
                  }}
                />
                <span className="text-[10px] tabular-nums text-white/24">5000</span>
              </div>
              <label className="flex h-9 items-center rounded-lg border border-blue-300/14 bg-blue-400/[0.06] px-2.5 transition focus-within:border-blue-300/34 focus-within:bg-blue-400/[0.09]">
                <input
                  type="number"
                  min={50}
                  max={5000}
                  step={1}
                  value={targetFacesInput}
                  aria-label="精确目标面数"
                  onChange={(event) => {
                    const nextValue = event.target.value;
                    setTargetFacesInput(nextValue);
                    const parsedValue = parseTargetFacesInput(nextValue);
                    if (parsedValue !== undefined) {
                      setTargetFaces(parsedValue);
                    }
                  }}
                  onBlur={commitTargetFacesInput}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      commitTargetFacesInput();
                      event.currentTarget.blur();
                    }
                  }}
                  className="w-14 bg-transparent text-right text-xs font-semibold tabular-nums text-blue-50/85 outline-none"
                />
                <span className="ml-1 text-[10px] text-white/32">面</span>
              </label>
            </div>
          </SettingLabel>
        </div>

        <div className="mt-4">
          <AdvancedSection
            hint={`锐边${preserveSharp ? '保留' : '关闭'} · 边界${preserveBoundary ? '保留' : '关闭'} · 参考图 ${referenceImages.length} 张`}
          >
            <SettingLabel label="结构约束" description="默认保留锐边和组件边界">
              <div className="flex flex-wrap gap-2">
                <MiniSwitch checked={preserveSharp} onChange={setPreserveSharp} label="保留锐边" />
                <MiniSwitch checked={preserveBoundary} onChange={setPreserveBoundary} label="保留边界" />
                <MiniSwitch checked={requireClosed} onChange={setRequireClosed} label="必须闭合" />
              </div>
            </SettingLabel>
            <label className="block border-t border-white/[0.055] py-4">
              <span className="text-xs font-medium text-white/52">补充要求</span>
              <span className="mt-1 block text-[10px] text-white/24">用于生成规划与自动严格 QA。</span>
              <textarea
                rows={3}
                disabled={busy}
                value={userRequest}
                onChange={(event) => setUserRequest(event.target.value)}
                className="mt-3 w-full resize-none rounded-xl border border-white/[0.075] bg-black/18 px-4 py-3 text-sm leading-6 text-white/64 outline-none transition placeholder:text-white/18 focus:border-blue-300/34"
              />
            </label>
            <div className="border-t border-white/[0.055]">
              <ReferenceImages
                files={referenceImages}
                onFiles={setReferenceImages}
                disabled={busy}
                embedded
              />
            </div>
          </AdvancedSection>
        </div>
      </fieldset>

      <div className="border-t border-white/[0.055] p-5">
        <button
          type="button"
          disabled={!modelReady || busy || !serviceReady}
          onClick={() => void submit()}
          className="flex h-14 w-full items-center justify-center gap-3 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-500 text-sm font-semibold text-white shadow-[0_18px_42px_rgba(37,99,235,.18)] transition hover:-translate-y-0.5 hover:brightness-110 active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:translate-y-0"
        >
          {busy ? <LoaderCircle className="h-4.5 w-4.5 animate-spin" /> : <Network className="h-4.5 w-4.5" />}
          {preparing
            ? '正在准备模型…'
            : busy
              ? '正在提交任务…'
              : modelReady
                ? '开始自动拓扑'
                : '请先导入高模'}
        </button>
        <div className="mt-3 flex min-h-4 items-center justify-center gap-2 text-[11px] text-white/24">
          {serviceBlockReason ? (
            <>
              <TriangleAlert className="h-3.5 w-3.5 text-amber-200/58" />
              <span className="text-amber-100/52">{submitBlockReason}</span>
            </>
          ) : (
            <span>源文件不会被修改</span>
          )}
        </div>
      </div>
    </section>
  );
}

export function AssetProcessingPage({ mode, onBack, onLogout }: AssetProcessingPageProps) {
  const copy = modeCopy[mode];
  const Icon = copy.Icon;
  const jobStorageKey = `li3d:asset-processing:${mode}:job-id`;
  const traceStorageKey = `li3d:asset-processing:${mode}:trace`;
  const [serviceStatus, setServiceStatus] = useState<AssetProcessingStatus>();
  const [serviceLoading, setServiceLoading] = useState(true);
  const [serviceError, setServiceError] = useState<string>();
  const [serviceCheck, setServiceCheck] = useState(0);
  const serviceRetryAttemptRef = useRef(0);
  const [job, setJob] = useState<AssetJob | undefined>(() => {
    const restoredJobId = window.sessionStorage.getItem(jobStorageKey);
    return restoredJobId
      ? {
          job_id: restoredJobId,
          status: 'QUEUED',
          progress: 0,
          stage_message: '正在恢复任务状态',
        }
      : undefined;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const jobId = job ? assetJobId(job) : '';
  const jobStatus = job?.status;
  const jobActive = Boolean(jobStatus && !terminalStatuses.has(jobStatus));

  useEffect(() => {
    let active = true;
    let retryTimer: number | undefined;

    const scheduleRetry = () => {
      if (!active) return;
      const delay = assetProcessingStatusRetryDelay(serviceRetryAttemptRef.current);
      serviceRetryAttemptRef.current += 1;
      retryTimer = window.setTimeout(() => {
        if (active) setServiceCheck((value) => value + 1);
      }, delay);
    };

    setServiceLoading(true);
    setServiceError(undefined);
    void getAssetProcessingStatus()
      .then((status) => {
        if (!active) return;
        setServiceStatus(status);
        setServiceError(undefined);
        if (assetProcessingStatusNeedsRetry(status)) {
          scheduleRetry();
        } else {
          serviceRetryAttemptRef.current = 0;
        }
      })
      .catch((statusError) => {
        if (!active) return;
        const message = statusError instanceof Error ? statusError.message : '无法读取资产服务配置。';
        setServiceError(message);
        scheduleRetry();
      })
      .finally(() => {
        if (active) setServiceLoading(false);
      });
    return () => {
      active = false;
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, [serviceCheck]);

  useEffect(() => {
    if (jobId) {
      window.sessionStorage.setItem(jobStorageKey, jobId);
    } else {
      window.sessionStorage.removeItem(jobStorageKey);
    }
  }, [jobId, jobStorageKey]);

  useEffect(() => {
    if (mode !== 'retopology') return;
    if (!jobId) {
      window.sessionStorage.removeItem(traceStorageKey);
      return;
    }
    window.sessionStorage.setItem(
      traceStorageKey,
      JSON.stringify({
        job_id: jobId,
        request_id: job?.request_id,
        external_asset_id: job?.external_asset_id,
        input_sha256: job?.input_sha256,
      }),
    );
  }, [
    job?.external_asset_id,
    job?.input_sha256,
    job?.request_id,
    jobId,
    mode,
    traceStorageKey,
  ]);

  useEffect(() => {
    if (!jobId || (jobStatus && terminalStatuses.has(jobStatus))) return;
    let active = true;
    let timer: number | undefined;

    async function poll() {
      try {
        const next = await getAssetJob(jobId);
        if (!active) return;
        setError(undefined);
        setJob(next);
        if (!terminalStatuses.has(next.status)) {
          timer = window.setTimeout(poll, 2200 + Math.round(Math.random() * 700));
        }
      } catch (pollError) {
        if (!active) return;
        if (
          pollError instanceof AssetProcessingHttpError &&
          [403, 404, 410].includes(pollError.status)
        ) {
          window.sessionStorage.removeItem(jobStorageKey);
          setJob(undefined);
          setError('之前的任务记录已失效，可以重新提交。');
          return;
        }
        setError(pollError instanceof Error ? pollError.message : '任务状态同步失败。');
        timer = window.setTimeout(poll, 4000);
      }
    }

    timer = window.setTimeout(poll, 900);
    return () => {
      active = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [jobId, jobStatus, jobStorageKey]);

  useEffect(() => {
    if (!jobId) return;
    let active = true;
    let refreshing = false;
    let refreshQueued = false;

    const refreshFromServer = async () => {
      if (!active) return;
      if (refreshing) {
        refreshQueued = true;
        return;
      }
      refreshing = true;
      try {
        const next = await getAssetJob(jobId);
        if (!active) return;
        setError(undefined);
        setJob(next);
        if (terminalStatuses.has(next.status)) {
          active = false;
          unsubscribe();
          return;
        }
      } catch {
        // SSE is only the low-latency signal. Polling remains the source of truth
        // and owns user-facing connection errors.
      } finally {
        refreshing = false;
        if (active && refreshQueued) {
          refreshQueued = false;
          void refreshFromServer();
        }
      }
    };

    const unsubscribe = subscribeAssetJobEvents(jobId, () => {
      void refreshFromServer();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [jobId]);

  useEffect(() => {
    if (!jobId || !jobStatus) return;
    const telemetryModule = telemetryModuleForMode(mode);
    if (!hasTrackedModuleAction(telemetryModule, 'start', jobId)) return;
    if (jobStatus === 'SUCCEEDED') {
      trackModuleActionOnce(telemetryModule, 'complete', jobId);
    } else if (jobStatus === 'FAILED') {
      trackModuleActionOnce(telemetryModule, 'fail', jobId);
    }
  }, [jobId, jobStatus, mode]);

  async function handleCancel() {
    if (!jobId) return;
    setBusy(true);
    try {
      const payload = await cancelAssetJob(jobId);
      setError(undefined);
      setJob(payload);
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : '取消任务失败。');
    } finally {
      setBusy(false);
    }
  }

  const serviceReady = Boolean(
    !serviceLoading &&
      !serviceError &&
      serviceStatus?.available === true &&
      serviceStatus.capacityCheckPassed === true &&
      serviceStatus.capabilities[mode] === true,
  );
  const serviceBlockReason = serviceUnavailableReason(
    serviceStatus,
    serviceLoading,
    mode,
    serviceError,
  );
  const pageGlow = mode === 'uv' ? 'bg-emerald-400/[0.055]' : 'bg-blue-400/[0.06]';
  const iconStyle = mode === 'uv'
    ? 'border-emerald-300/18 bg-emerald-400/[0.075] text-emerald-100'
    : 'border-blue-300/18 bg-blue-400/[0.075] text-blue-100';
  const historyRefreshKey = `${jobId}:${jobStatus ?? 'idle'}`;

  return (
    <main className="li3d-home-surface relative min-h-screen overflow-x-hidden text-white">
      <div className={`pointer-events-none absolute right-[7%] top-16 h-[420px] w-[420px] rounded-full blur-[120px] ${pageGlow}`} />
      <header className="relative z-10 flex h-16 items-center justify-between border-b border-white/[0.055] px-5 sm:px-8">
        <BrandMark />
        <UserMenu onLogout={onLogout} />
      </header>

      <div className="2xl:pr-[264px] min-[1720px]:pr-[344px]">
      <section className="relative z-[1] mx-auto w-full max-w-[1280px] px-5 pb-16 pt-6 sm:px-8">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-2 text-sm text-white/42 transition hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" />
          返回功能首页
        </button>

        <div className="mt-6 flex flex-col justify-between gap-5 lg:flex-row lg:items-center">
          <div className="flex items-start gap-4">
            <span className={`mt-0.5 grid h-11 w-11 shrink-0 place-items-center rounded-xl border ${iconStyle}`}>
              <Icon className="h-5 w-5" />
            </span>
            <div>
              <div className="text-[10px] font-semibold tracking-[0.2em] text-white/30">{copy.eyebrow}</div>
              <h1 className="mt-1.5 text-3xl font-semibold tracking-[-0.04em] text-white sm:text-4xl">{copy.title}</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-white/38">{copy.description}</p>
            </div>
          </div>
          <ServiceBadge
            status={serviceStatus}
            loading={serviceLoading}
            error={serviceError}
            onRetry={() => {
              serviceRetryAttemptRef.current = 0;
              setServiceLoading(true);
              setServiceError(undefined);
              setServiceCheck((value) => value + 1);
            }}
          />
        </div>

        <div className="mt-6 grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
          {mode === 'uv' ? (
            <AutoUvWorkspace
              serviceReady={serviceReady}
              serviceBlockReason={serviceBlockReason}
              onJob={setJob}
              setBusy={setBusy}
              busy={busy || jobActive}
              setError={setError}
            />
          ) : (
            <AutoRetopologyWorkspace
              serviceReady={serviceReady}
              serviceBlockReason={serviceBlockReason}
              onJob={setJob}
              setBusy={setBusy}
              busy={busy || jobActive}
              setError={setError}
            />
          )}
          <JobPanel
            mode={mode}
            job={job}
            busy={busy || jobActive}
            error={error}
            onCancel={() => void handleCancel()}
          />
        </div>

        <div className="mt-6 border-t border-white/[0.045] pt-4 text-[11px] text-white/20">
          <span className="inline-flex items-center gap-2">
            <Sparkles className="h-3.5 w-3.5" />
            {mode === 'uv'
              ? '源文件不会被覆盖；五项交付物仅在严格 QA 通过后原子发布。'
              : '源高模不会被覆盖；严格 QA 通过后自动发布最终低模与质量证据。'}
          </span>
        </div>
      </section>
      </div>
      <HistorySidePanel module={mode} refreshKey={historyRefreshKey} />
    </main>
  );
}

export function AutoUvPage(props: Omit<AssetProcessingPageProps, 'mode'>) {
  return <AssetProcessingPage {...props} mode="uv" />;
}

export function AutoRetopologyPage(props: Omit<AssetProcessingPageProps, 'mode'>) {
  return <AssetProcessingPage {...props} mode="retopology" />;
}
