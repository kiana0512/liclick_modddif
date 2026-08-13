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
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { UserMenu } from '@/components/auth/UserMenu';
import { HistorySidePanel } from '@/components/history/HistorySidePanel';
import {
  AssetModelViewport,
  type AssetModelPreviewSource,
  type AssetModelPreviewStats,
} from '@/features/workflow/AssetModelViewport';
import { AssetUvLayoutPreview } from '@/features/workflow/AssetUvLayoutPreview';
import { getHistoryModelFile } from '@/features/workflow/modelPreviewAssets';
import { WorkflowShell } from '@/features/workflow/WorkflowShell';
import type { WorkflowNavigation } from '@/features/workflow/workflowTypes';
import { useWorkflowProject } from '@/features/workflow/useWorkflowProject';
import {
  assetJobArtifacts,
  assetJobError,
  assetJobErrorCode,
  assetJobId,
  cancelAssetJob,
  downloadVerifiedArtifact,
  fetchVerifiedArtifactBlob,
  getAssetJob,
  getAssetProcessingStatus,
  submitRetopologyProcessing,
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
import {
  downloadTaskHistoryOutput,
  fetchTaskHistoryOutputBlob,
  type TaskHistoryOutput,
  type TaskHistoryRecord,
} from '@/services/taskHistoryApiClient';
import {
  getLatestUsablePipelineStageRevision,
  markDownstreamPipelineRevisionsStale,
  publishPipelineRevision,
  resolvePipelineAssetObjectId,
} from '@/services/projectPipeline';
import {
  createProject,
  saveBlobAsset,
  saveProject as saveWorkspaceProject,
} from '@/services/workspaceApiClient';
import { useProjectStore } from '@/stores/projectStore';
import type {
  Project,
  ProjectPipelineAssetReference,
  ProjectPipelineStage,
  TextureBakeHandoff,
} from '@/types/project';
import { createId } from '@/utils/id';

type AssetProcessingPageProps = {
  mode: AssetProcessingMode;
  projectId?: string;
  onBack: () => void;
  onLogout: () => void;
  navigation: WorkflowNavigation;
  onContinue: (projectId: string, handoff?: TextureBakeHandoff) => void;
};

type SubmissionSnapshot = {
  fingerprint: string;
  sourceFile: File;
  sourceFiles?: File[];
  batchId?: string;
  childJobs?: Array<{ jobId: string; sourceName: string }>;
  submissionFailures?: Array<{ sourceName: string; error: string }>;
};

type RetopologyResultPreview = {
  source: AssetModelPreviewSource;
  artifact?: AssetArtifact;
  record?: TaskHistoryRecord;
  output?: TaskHistoryOutput;
};

type StoredJobBinding = {
  jobId: string;
  fingerprint: string;
  pipelineInputAssetId?: string;
  source: {
    name: string;
    size: number;
    type: string;
    lastModified: number;
  };
  sources?: Array<{
    name: string;
    size: number;
    type: string;
    lastModified: number;
  }>;
  batchId?: string;
  childJobs?: Array<{ jobId: string; sourceName: string }>;
  submissionFailures?: Array<{ sourceName: string; error: string }>;
};

type JobBinding = StoredJobBinding & {
  sourceFile?: File;
  sourceFiles?: File[];
};

function storedJobBinding(storageKey: string): StoredJobBinding | undefined {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(storageKey) ?? 'null') as
      | StoredJobBinding
      | null;
    if (
      !value?.jobId ||
      !value.fingerprint ||
      !value.source?.name ||
      typeof value.source.size !== 'number' ||
      typeof value.source.lastModified !== 'number'
    ) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

function fileDescriptor(file: File): StoredJobBinding['source'] {
  return {
    name: file.name,
    size: file.size,
    type: file.type,
    lastModified: file.lastModified,
  };
}

function matchesFileDescriptor(file: File, descriptor: StoredJobBinding['source']) {
  return (
    file.name === descriptor.name &&
    file.size === descriptor.size &&
    file.type === descriptor.type &&
    file.lastModified === descriptor.lastModified
  );
}

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
    title: '自动拓扑 V6',
    description: '导入高模，系统自动分析结构与轮廓、生成生产级低模，并在八项质量检查通过后发布。',
    accent: 'blue',
    Icon: Network,
  },
} as const;

function telemetryModuleForMode(mode: AssetProcessingMode): TelemetryModule {
  return mode === 'uv' ? 'auto_uv' : 'auto_retopology';
}

function pipelineStageForMode(mode: AssetProcessingMode): ProjectPipelineStage {
  return mode === 'uv' ? 'uv' : 'retopology';
}

function pipelineParentStageForMode(mode: AssetProcessingMode): ProjectPipelineStage {
  return mode === 'uv' ? 'retopology' : 'texture';
}

function preferredPipelineInputAsset(project: Project | undefined, mode: AssetProcessingMode) {
  if (!project) return undefined;
  const parentRevision = getLatestUsablePipelineStageRevision(
    project.pipeline,
    pipelineParentStageForMode(mode),
  );
  const expectedKind = mode === 'uv' ? 'low-model' : 'high-model';
  const revisionAsset = parentRevision?.outputAssets.find(
    (asset) => asset.kind === expectedKind || asset.kind === 'model',
  );
  if (revisionAsset) return revisionAsset;

  if (mode === 'retopology') {
    const objectId = project.bakeWorkspace?.selectedObjectId;
    const high = objectId ? project.bakeWorkspace?.bakeSets[objectId]?.high : undefined;
    if (high) {
      return {
        ...high,
        id: `legacy-high:${objectId}`,
        kind: 'high-model' as const,
        objectId,
      } satisfies ProjectPipelineAssetReference;
    }
  }
  return undefined;
}

async function fileFromPipelineAsset(asset: ProjectPipelineAssetReference) {
  const response = await fetch(asset.url, { credentials: 'include' });
  if (!response.ok) throw new Error(`读取上游模型失败（${response.status}）`);
  const blob = await response.blob();
  return new File([blob], asset.name, {
    type: asset.mimeType || blob.type || 'application/octet-stream',
    // A deterministic timestamp lets a restored job prove that the freshly
    // fetched upstream file is the same published pipeline asset.
    lastModified: 0,
  });
}

function fileStem(fileName: string) {
  return fileName
    .replace(/\.[^.]+$/, '')
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72) || 'asset';
}

// The remote Asset V4 contract caps external_asset_id and Idempotency-Key at
// 128 characters. Keep the batch identity comfortably below that limit so a
// child suffix can be added without depending on the source filename length.
const maximumReusableSubmissionIdentityLength = 96;

function validSubmissionIdentity(value: string | undefined): value is string {
  return Boolean(
    value &&
      value.length <= maximumReusableSubmissionIdentityLength &&
      /^[\x21-\x7e]+$/.test(value),
  );
}

function externalAssetId(mode: AssetProcessingMode) {
  return mode === 'retopology'
    ? `li3d-retopology-v6-${createId()}`
    : `li3d-${mode}-${createId()}`;
}

function pendingSubmissionStorageKey(mode: AssetProcessingMode) {
  return `li3d:asset-processing:${mode}:pending-submission`;
}

function stableSubmissionKey(
  mode: AssetProcessingMode,
  fingerprint: string,
) {
  const storageKey = pendingSubmissionStorageKey(mode);
  try {
    const stored = JSON.parse(window.sessionStorage.getItem(storageKey) ?? 'null') as {
      fingerprint?: string;
      key?: string;
    } | null;
    if (
      stored?.fingerprint === fingerprint &&
      validSubmissionIdentity(stored.key)
    ) {
      return { fingerprint, key: stored.key };
    }
  } catch {
    // Invalid stale state is replaced below.
  }
  const pending = { fingerprint, key: externalAssetId(mode) };
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
        ? '本次候选未通过全部质量门禁，未发布正式低模；请调整高模、参考图或交付档位后重试。'
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

function aggregateRetopologyBatchJob(
  batchId: string,
  children: Array<{ job: AssetJob; sourceName: string }>,
): AssetJob {
  const active = children.filter(({ job }) => !terminalStatuses.has(job.status));
  const succeeded = children.filter(({ job }) => job.status === 'SUCCEEDED');
  const failed = children.filter(({ job }) => job.status === 'FAILED');
  const cancelled = children.filter(({ job }) => job.status === 'CANCELLED');
  const allTerminal = active.length === 0;
  const status: AssetJobStatus = !allTerminal
    ? active.some(({ job }) => job.status === 'RUNNING' || job.status === 'CLAIMED')
      ? 'RUNNING'
      : 'QUEUED'
    : succeeded.length > 0
      ? 'SUCCEEDED'
      : failed.length > 0
        ? 'FAILED'
        : cancelled.length > 0
          ? 'CANCELLED'
          : 'FAILED';
  const progress = children.length > 0
    ? children.reduce((sum, { job }) => sum + (Number(job.progress) || 0), 0) / children.length
    : 0;
  const artifacts = succeeded.flatMap(({ job, sourceName }) =>
    assetJobArtifacts(job).map((artifact) => ({
      ...artifact,
      source_job_id: assetJobId(job),
      source_name: sourceName,
    })),
  );
  const partialFailureSummary = failed.length > 0
    ? `${failed.length} 个模型处理失败，其余模型已继续完成。`
    : undefined;
  return {
    job_id: batchId,
    job_type: 'RETOPOLOGY_BATCH',
    status,
    progress,
    stage: allTerminal ? 'BATCH_COMPLETE' : 'BATCH_RUNNING',
    stage_message: allTerminal
      ? `${succeeded.length}/${children.length} 个模型已交付${failed.length ? `，${failed.length} 个失败` : ''}`
      : `正在独立处理 ${children.length} 个模型 · 已完成 ${succeeded.length}`,
    artifacts,
    artifacts_role: 'batch_delivery',
    delivery_ready: allTerminal && succeeded.length > 0,
    ...(partialFailureSummary
      ? { error: { code: 'RETOPOLOGY_BATCH_PARTIAL_FAILURE', summary: partialFailureSummary } }
      : {}),
  };
}

function failedRetopologySubmissionChild(
  batchId: string,
  failure: { sourceName: string; error: string },
  index: number,
) {
  return {
    sourceName: failure.sourceName,
    job: {
      job_id: `${batchId}:submission-failed:${index}`,
      job_type: 'RETOPOLOGY_PROCESS_V2',
      status: 'FAILED' as const,
      progress: 100,
      stage: 'SUBMISSION_FAILED',
      stage_message: '模型提交失败',
      error: { code: 'RETOPOLOGY_SUBMISSION_FAILED', summary: failure.error },
    },
  };
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
    return /_game_low\.(blend|fbx)$/i.test(name);
  });
}

function retopologyDiagnosticArtifacts(artifacts: AssetArtifact[]) {
  return artifacts.filter((artifact) => !/\.(blend|fbx)$/i.test(artifactName(artifact)));
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
  const deliveryReady = job?.delivery_ready ?? job?.result?.delivery_ready;
  const artifactsRole = job?.artifacts_role ?? job?.result?.artifacts_role;
  const invalidFinalMetadata = featured.filter((artifact) => !artifactMetadataReady(artifact));
  return {
    ready:
      deliveryReady === true &&
      artifactsRole !== 'isolated_diagnostic' &&
      hasBlend &&
      hasFbx &&
      invalidFinalMetadata.length === 0,
    summary:
      deliveryReady !== true || artifactsRole === 'isolated_diagnostic'
        ? 'V6 服务尚未发布正式交付；候选模型和隔离诊断不能作为最终结果。'
        : !hasBlend || !hasFbx
          ? '重拓扑交付缺少 V6 正式 BLEND 或 FBX。'
        : invalidFinalMetadata.length > 0
          ? '最终重拓扑制品缺少 V6 文件名、类型、大小、SHA 或下载地址。'
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
      className={`group relative w-full min-w-0 max-w-full overflow-hidden rounded-2xl border text-left outline-none transition duration-200 ${
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
        <div className="relative flex min-h-[74px] w-full min-w-0 items-center gap-4 overflow-hidden pr-1">
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

function MultiFbxDropCard({
  files,
  onFiles,
  selectedIndex,
  onSelect,
  disabled = false,
}: {
  files: File[];
  onFiles: (files: File[]) => void;
  selectedIndex?: number;
  onSelect?: (index: number) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [fileError, setFileError] = useState<string>();

  function addFiles(input: FileList | File[]) {
    const incoming = Array.from(input);
    const invalid = incoming.find((file) => !/\.fbx$/i.test(file.name));
    if (invalid) {
      setFileError(`${invalid.name} 不是 FBX 文件；拓扑批次仅接收 FBX。`);
      return;
    }
    const next = [...files];
    const keys = new Set(files.map((file) => `${file.name}:${file.size}:${file.lastModified}`));
    for (const file of incoming) {
      const key = `${file.name}:${file.size}:${file.lastModified}`;
      if (!keys.has(key)) {
        keys.add(key);
        next.push(file);
      }
    }
    if (next.length > 20) {
      setFileError('单次最多提交 20 个 FBX。');
      return;
    }
    setFileError(undefined);
    onFiles(next);
  }

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-label={files.length ? '继续添加高模 FBX' : '选择多个高模 FBX'}
      onClick={(event) => {
        if (!disabled && !(event.target as HTMLElement).closest('button')) inputRef.current?.click();
      }}
      onKeyDown={(event) => {
        if (!disabled && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          inputRef.current?.click();
        }
      }}
      onDragEnter={(event) => {
        event.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        if (!disabled && event.dataTransfer.files.length) addFiles(event.dataTransfer.files);
      }}
      className={`min-w-0 overflow-hidden rounded-xl outline-none transition focus-visible:ring-1 focus-visible:ring-blue-200/55 ${
        dragging
          ? 'bg-blue-400/[0.09] ring-1 ring-blue-200/55'
          : 'bg-transparent'
      } ${disabled ? 'opacity-55' : ''}`}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".fbx"
        disabled={disabled}
        aria-hidden="true"
        tabIndex={-1}
        className="hidden"
        onChange={(event) => {
          if (event.target.files?.length) addFiles(event.target.files);
          event.target.value = '';
        }}
      />

      {files.length ? (
        <div className="workflow-scrollbar grid max-h-[238px] gap-2 overflow-y-auto">
          {files.map((file, index) => (
            <div
              role="button"
              tabIndex={0}
              key={`${file.name}:${file.size}:${file.lastModified}`}
              onClick={(event) => {
                event.stopPropagation();
                onSelect?.(index);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  event.stopPropagation();
                  onSelect?.(index);
                }
              }}
              className={`flex min-w-0 items-center gap-2 rounded-xl border px-3 py-3 text-left transition ${
                selectedIndex === index
                  ? 'border-blue-300/32 bg-blue-400/[0.07]'
                  : 'border-white/[0.065] bg-black/15 hover:border-white/14 hover:bg-white/[0.035]'
              }`}
            >
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-blue-400/10 text-[10px] font-semibold text-blue-100/70">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[11px] font-medium text-white/64" title={file.name}>
                  {file.name}
                </span>
                <span className="mt-0.5 block text-[9px] text-white/24">{formatBytes(file.size)}</span>
              </span>
              <button
                type="button"
                disabled={disabled}
                aria-label={`移除 ${file.name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onFiles(files.filter((_, fileIndex) => fileIndex !== index));
                }}
                className="relative z-10 grid h-7 w-7 shrink-0 place-items-center rounded-md text-white/34 transition hover:bg-rose-400/10 hover:text-rose-100"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex min-h-24 cursor-pointer items-center justify-center gap-3 p-4 text-white/38">
          <Box className="h-5 w-5 text-blue-100/70" />
          <span className="text-sm font-medium">点击或拖入 FBX</span>
        </div>
      )}
      {fileError ? <div className="px-3 pb-3 text-xs text-rose-200/72">{fileError}</div> : null}
    </div>
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
  if (loading) return '正在检查资产服务，请稍候。';
  if (requestError) return requestError;
  if (!status) return requestError || '无法读取资产服务状态，请重新检测。';

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
      status.authorizationMode === 'bearer'
        ? '资产服务 Bearer Token 鉴权未通过。'
        : '本机 IP 尚未获得资产服务访问权限。',
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
      if (unique.length >= 16) break;
      if (!unique.some((item) => item.name === image.name && item.size === image.size)) unique.push(image);
    }
    onFiles(unique);
  }

  return (
    <div className={`${embedded ? 'py-4' : 'rounded-2xl border border-white/[0.075] bg-[#111321]/84 p-5'} transition ${disabled ? 'opacity-55' : ''}`}>
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-sm font-semibold text-white/76">参考视图</div>
          <div className="mt-1 text-xs text-white/30">可选，最多 16 张；文件名会与 V6 reference_views 声明严格对应。</div>
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
                  artifact.source_name,
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
  onContinue,
  continueLabel,
}: {
  mode: AssetProcessingMode;
  job?: AssetJob;
  busy: boolean;
  error?: string;
  onCancel: () => void;
  onContinue?: (artifact: AssetArtifact) => Promise<void>;
  continueLabel?: string;
}) {
  const progress = Math.min(100, Math.max(0, job?.progress ?? 0));
  const succeeded = job?.status === 'SUCCEEDED';
  const failed = job?.status === 'FAILED';
  const showSpinner = busy && !terminalStatuses.has(job?.status ?? 'QUEUED');
  const artifacts = assetJobArtifacts(job);
  const featuredArtifacts =
    mode === 'retopology' ? finalRetopologyArtifacts(artifacts) : primaryArtifacts(artifacts);
  const diagnosticArtifacts = mode === 'retopology'
    ? retopologyDiagnosticArtifacts(artifacts)
    : artifacts.filter((artifact) => !featuredArtifacts.includes(artifact));
  const errorCode = assetJobErrorCode(job);
  const displayedError = succeeded
    ? assetJobError(job)
    : (error ?? assetJobError(job));
  const contract = deliveryContract(mode, job, artifacts);
  const deliveryReady = succeeded && contract.ready;
  const [downloadingAll, setDownloadingAll] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [deliveryDownloadError, setDeliveryDownloadError] = useState<string>();

  async function downloadAllArtifacts() {
    const jobId = job ? assetJobId(job) : '';
    if (!jobId || !deliveryReady || downloadingAll) return;
    setDownloadingAll(true);
    setDeliveryDownloadError(undefined);
    try {
      const fbxArtifacts = featuredArtifacts.filter((artifact) =>
        /\.fbx$/i.test(artifact.filename),
      );
      if (fbxArtifacts.length === 0) {
        throw new Error('当前交付中没有可下载的 FBX 模型。');
      }
      for (const fbxArtifact of fbxArtifacts) {
        await downloadVerifiedArtifact(jobId, fbxArtifact);
      }
      trackModuleAction(telemetryModuleForMode(mode), 'download');
    } catch (artifactError) {
      setDeliveryDownloadError(
        submissionErrorMessage(artifactError, '完整交付下载或校验失败。'),
      );
    } finally {
      setDownloadingAll(false);
    }
  }

  async function continueWithFbx() {
    if (!onContinue || continuing || !deliveryReady) return;
    const fbxArtifact = featuredArtifacts.find((artifact) => /\.fbx$/i.test(artifact.filename));
    if (!fbxArtifact) {
      setDeliveryDownloadError('当前交付中没有可传入下一阶段的 FBX 模型。');
      return;
    }
    setContinuing(true);
    setDeliveryDownloadError(undefined);
    try {
      await onContinue(fbxArtifact);
    } catch (continueError) {
      setDeliveryDownloadError(
        submissionErrorMessage(continueError, '保存项目资产或传入下一阶段失败。'),
      );
    } finally {
      setContinuing(false);
    }
  }

  return (
    <aside className="min-w-0 max-w-full overflow-hidden rounded-2xl border border-white/[0.075] bg-[#111321]/82 p-4 shadow-[0_20px_60px_rgba(0,0,0,.2)] lg:sticky lg:top-6 lg:self-start">
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

          {(failed || displayedError) && (
            <div className="mt-5 rounded-xl border border-rose-300/14 bg-rose-400/[0.055] p-4 text-xs leading-5 text-rose-100/66">
              <div className="flex items-start gap-3">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{displayedError ?? '任务未通过严格 QA，请检查输入后重试。'}</span>
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
                  {mode === 'uv' ? 'V4 固定交付' : 'V6 正式模型'}
                </span>
                <span className="text-[10px] text-white/26">
                  {mode === 'uv' ? `${artifacts.length}/5 项` : `${featuredArtifacts.length} 项`}
                </span>
              </div>
              <ArtifactList mode={mode} job={job} artifacts={featuredArtifacts} />
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
                      : featuredArtifacts.filter((artifact) => /\.fbx$/i.test(artifact.filename)).length > 1
                        ? '下载全部拓扑 FBX'
                        : '下载拓扑 FBX'}
                </button>
              )}
              {deliveryReady && onContinue && (
                <button
                  type="button"
                  disabled={continuing || downloadingAll}
                  onClick={() => void continueWithFbx()}
                  className={`mt-2 inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg text-xs font-semibold text-white shadow-lg transition hover:-translate-y-0.5 hover:brightness-110 disabled:cursor-wait disabled:opacity-50 disabled:hover:translate-y-0 ${
                    mode === 'uv'
                      ? 'bg-gradient-to-r from-emerald-500 to-teal-500'
                      : 'bg-gradient-to-r from-blue-600 to-violet-500'
                  }`}
                >
                  {continuing ? (
                    <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5" />
                  )}
                  {continuing
                    ? '正在保存并传递…'
                    : continueLabel ?? (mode === 'uv' ? '保存并传入烘焙' : '保存并传入 UV')}
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
              : '导入高模并开始后，在这里查看 Agent 生成与八项质量检查进度。'}
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
  initialAsset,
  onAssetChange,
  onContinueImported,
  continuingImported,
  onSubmissionInputsChange,
  serviceReady,
  serviceBlockReason,
  onJob,
  setBusy,
  busy,
  setError,
}: {
  initialAsset?: File;
  onAssetChange?: (file?: File) => void;
  onContinueImported?: (file: File) => Promise<void>;
  continuingImported: boolean;
  onSubmissionInputsChange: () => void;
  serviceReady: boolean;
  serviceBlockReason?: string;
  onJob: (job: AssetJob, snapshot: SubmissionSnapshot) => void;
  setBusy: (busy: boolean) => void;
  busy: boolean;
  setError: (error?: string) => void;
}) {
  const [asset, setAsset] = useState<File>();
  const [resolution, setResolution] = useState<1024 | 2048 | 4096 | 8192>(2048);
  const hiddenAxis = 'y+' as const;
  const hardEdgeAngle = 75;
  const padding = 10;
  const submissionKeyRef = useRef<{ fingerprint: string; key: string } | undefined>(undefined);

  useEffect(() => {
    if (!initialAsset) return;
    setAsset(initialAsset);
  }, [initialAsset]);

  function selectAsset(file?: File) {
    setAsset(file);
    onAssetChange?.(file);
  }

  async function submit() {
    if (!asset || busy || !serviceReady) return;
    onSubmissionInputsChange();
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
      if (
        submissionKeyRef.current?.fingerprint !== fingerprint ||
        !validSubmissionIdentity(submissionKeyRef.current?.key)
      ) {
        submissionKeyRef.current = stableSubmissionKey('uv', fingerprint);
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
      onJob(
        {
          ...submission,
          progress: 0,
          stage: 'QUEUED',
          stage_message: '任务已提交，等待 Asset Worker',
        },
        { fingerprint, sourceFile: asset },
      );
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

  return (
    <section className="min-w-0 max-w-full overflow-hidden rounded-2xl border border-white/[0.075] bg-[#111321]/80">
      <div className="border-b border-white/[0.055] px-5 py-4">
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

      <fieldset disabled={busy} className="min-w-0 space-y-4 overflow-hidden p-5 disabled:opacity-55">
        <FileDropCard
          file={asset}
          accept=".fbx,.obj,.glb,.gltf,.blend"
          title="模型文件"
          description="拖入模型，或点击选择"
          extensions="FBX · OBJ · GLB · GLTF · BLEND"
          icon={FileBox}
          tone="emerald"
          onFile={selectAsset}
          disabled={busy}
          horizontal
        />

        <div className="flex min-w-0 max-w-full flex-col justify-between gap-3 overflow-hidden rounded-2xl border border-white/[0.065] bg-black/10 px-4 py-3.5 sm:flex-row sm:items-center">
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
            onChange={(value) => {
              onSubmissionInputsChange();
              setResolution(value);
            }}
            tone="emerald"
            label="UV 输出尺寸"
          />
        </div>

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
        {asset && onContinueImported ? (
          <button
            type="button"
            disabled={busy || continuingImported}
            onClick={() => void onContinueImported(asset)}
            className="mt-2 flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-emerald-300/18 bg-emerald-400/[0.055] text-xs font-semibold text-emerald-50/78 transition hover:border-emerald-300/34 hover:bg-emerald-400/[0.1] disabled:cursor-wait disabled:opacity-40"
          >
            {continuingImported ? (
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            {continuingImported ? '正在保存并传递…' : '直接传入烘焙'}
          </button>
        ) : null}
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

function RetopologyStatusViewport({
  status,
  progress,
  message,
  error,
  loadingResult = false,
  onCancel,
}: {
  status: string;
  progress: number;
  message?: string;
  error?: string;
  loadingResult?: boolean;
  onCancel?: () => void;
}) {
  const normalized = status.toLowerCase();
  const failed = ['failed', 'error'].includes(normalized);
  const cancelled = ['cancelled', 'canceled'].includes(normalized);
  const queued = ['queued', 'claimed', 'waiting', 'pending'].includes(normalized);
  const completed = ['succeeded', 'success', 'completed', 'complete'].includes(normalized);
  const active = !failed && !cancelled && !completed;
  const safeProgress = Math.min(100, Math.max(0, Number(progress) || 0));
  const title = loadingResult
    ? '正在载入拓扑结果'
    : failed
      ? '处理失败'
      : cancelled
        ? '任务已取消'
        : queued
          ? '排队中'
          : '正在处理';

  return (
    <div className="relative grid h-full min-h-[480px] place-items-center overflow-hidden bg-[#0b0d15]">
      <div className="pointer-events-none absolute inset-0 opacity-60 [background-image:linear-gradient(rgba(255,255,255,.025)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.025)_1px,transparent_1px)] [background-size:38px_38px] [mask-image:linear-gradient(to_bottom,transparent,black_30%,black_75%,transparent)]" />
      <div className={`relative w-[min(360px,calc(100%-40px))] rounded-3xl border p-8 text-center shadow-[0_28px_90px_rgba(0,0,0,.42)] ${
        failed
          ? 'border-rose-300/14 bg-[#241a24]'
          : 'border-white/[0.075] bg-[#242630]'
      }`}>
        <span className={`mx-auto grid h-12 w-12 place-items-center rounded-2xl ${
          failed ? 'bg-rose-400/10 text-rose-200' : 'bg-blue-400/10 text-blue-100/72'
        }`}>
          {failed ? (
            <TriangleAlert className="h-5 w-5" />
          ) : cancelled ? (
            <X className="h-5 w-5" />
          ) : (
            <Box className={`h-5 w-5 ${active || loadingResult ? 'animate-pulse' : ''}`} />
          )}
        </span>
        <h2 className="mt-4 text-lg font-semibold text-white/76">{title}</h2>
        <p className="mt-2 text-xs leading-5 text-white/36">
          {error ?? message ?? (queued ? '任务正在等待可用 Worker。' : '模型处理完成后将自动显示拓扑结果。')}
        </p>
        {!failed && !cancelled ? (
          <div className="mt-6">
            <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.07]">
              <div
                className="h-full rounded-full bg-gradient-to-r from-blue-500 to-violet-400 transition-[width] duration-500"
                style={{ width: `${loadingResult ? 100 : Math.max(3, safeProgress)}%` }}
              />
            </div>
            <div className="mt-2 text-right text-[10px] tabular-nums text-white/30">
              {loadingResult ? '正在准备预览' : `${Math.round(safeProgress)}%`}
            </div>
          </div>
        ) : null}
        {onCancel && active ? (
          <button
            type="button"
            onClick={onCancel}
            className="mt-6 inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-white/10 px-5 text-xs text-white/46 transition hover:bg-white/[0.06] hover:text-white/78"
          >
            <X className="h-3.5 w-3.5" />
            取消任务
          </button>
        ) : null}
      </div>
    </div>
  );
}

function AutoRetopologyWorkspace({
  initialAsset,
  onAssetChange,
  onModelsChange,
  selectedModelIndex,
  onSelectedModelIndexChange,
  onSubmissionInputsChange,
  serviceReady,
  serviceBlockReason,
  onJob,
  setBusy,
  busy,
  setError,
}: {
  initialAsset?: File;
  onAssetChange?: (file?: File) => void;
  onModelsChange?: (files: File[]) => void;
  selectedModelIndex: number;
  onSelectedModelIndexChange: (index: number) => void;
  onSubmissionInputsChange: () => void;
  serviceReady: boolean;
  serviceBlockReason?: string;
  onJob: (job: AssetJob, snapshot: SubmissionSnapshot) => void;
  setBusy: (busy: boolean) => void;
  busy: boolean;
  setError: (error?: string) => void;
}) {
  const [highModels, setHighModels] = useState<File[]>([]);
  const referenceImages: File[] = [];
  const preserveSharp = true;
  const preserveBoundary = true;
  const deliveryProfile = 'next_gen_game_prop' as const;
  const userRequest = '保留主要轮廓、开口、支撑关系与关键负空间。';
  const submissionKeyRef = useRef<{ fingerprint: string; key: string } | undefined>(undefined);

  useEffect(() => {
    if (!initialAsset) return;
    setHighModels([initialAsset]);
    onModelsChange?.([initialAsset]);
    onSelectedModelIndexChange(0);
  }, [initialAsset, onModelsChange, onSelectedModelIndexChange]);

  function selectHighModels(files: File[]) {
    setHighModels(files);
    onModelsChange?.(files);
    onSelectedModelIndexChange(Math.min(selectedModelIndex, Math.max(0, files.length - 1)));
    onAssetChange?.(files[0]);
  }

  async function submit() {
    if (busy || !serviceReady || highModels.length === 0) return;
    onSubmissionInputsChange();

    const fingerprint = JSON.stringify({
      sources: highModels.map((file) => [file.name, file.size, file.lastModified]),
      references: referenceImages.map((file) => [file.name, file.size, file.lastModified]),
      preserveSharp,
      preserveBoundary,
      deliveryProfile,
      userRequest,
    });
    if (
      submissionKeyRef.current?.fingerprint !== fingerprint ||
      !validSubmissionIdentity(submissionKeyRef.current?.key)
    ) {
      submissionKeyRef.current = stableSubmissionKey('retopology', fingerprint);
    }
    setBusy(true);
    setError(undefined);
    try {
      const batchId = submissionKeyRef.current.key;
      const settled = await Promise.allSettled(
        highModels.map(async (highModel, index) => {
          const metadata = {
            api_version: '6.0' as const,
            external_asset_id: `${batchId}-item-${index + 1}`,
            options: {
              algorithm: 'agent' as const,
              budget_mode: 'automatic' as const,
              topology_style: 'mixed_game_ready' as const,
              preserve_source: true as const,
              preserve_sharp_edges: preserveSharp,
              preserve_boundaries: preserveBoundary,
              delivery_profile: deliveryProfile,
            },
            reference_views: referenceImages.map((file, referenceIndex) => ({
              filename: file.name,
              view: inferReferenceView(file.name, referenceIndex),
            })),
            user_request: userRequest.trim(),
          };
          const submission = await submitRetopologyProcessing({
            highModel,
            referenceImages,
            metadata,
            batch: { id: batchId, index, size: highModels.length },
          });
          return { highModel, submission };
        }),
      );
      const submitted = settled.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : [],
      );
      const submissionFailures = settled.flatMap((result, index) =>
        result.status === 'rejected'
          ? [{
              sourceName: highModels[index]?.name ?? `模型 ${index + 1}`,
              error: submissionErrorMessage(result.reason, '自动拓扑提交失败。'),
            }]
          : [],
      );
      if (submitted.length === 0) {
        const firstFailure = settled.find((result) => result.status === 'rejected');
        throw firstFailure?.status === 'rejected'
          ? firstFailure.reason
          : new Error('没有模型成功提交。');
      }
      trackModuleActionOnce('auto_retopology', 'start', batchId);
      const childJobs = submitted.map(({ highModel, submission }) => ({
        jobId: assetJobId(submission),
        sourceName: highModel.name,
      }));
      const queuedChildren = submitted.map(({ highModel, submission }) => ({
        sourceName: highModel.name,
        job: {
          ...submission,
          status: 'QUEUED' as const,
          progress: 0,
          stage: 'QUEUED',
          stage_message: 'Agent 正在分析高模并生成唯一正式候选。',
        },
      }));
      onJob(
        aggregateRetopologyBatchJob(
          batchId,
          [
            ...queuedChildren,
            ...submissionFailures.map((failure, index) =>
              failedRetopologySubmissionChild(batchId, failure, index),
            ),
          ],
        ),
        {
          fingerprint,
          sourceFile: highModels[0],
          sourceFiles: highModels,
          batchId,
          childJobs,
          submissionFailures,
        },
      );
      if (submissionFailures.length > 0) {
        setError(`${submissionFailures.length} 个模型提交失败，其余 ${submitted.length} 个模型已继续处理。`);
      }
      clearPendingSubmission('retopology');
      submissionKeyRef.current = undefined;
    } catch (submitError) {
      setError(submissionErrorMessage(submitError, '自动拓扑提交失败。'));
    } finally {
      setBusy(false);
    }
  }

  const modelReady = highModels.length > 0;
  const submitBlockReason =
    serviceBlockReason ??
    (!modelReady ? '请先导入需要拓扑的高模。' : undefined);

  return (
    <section className="min-w-0 max-w-full overflow-hidden rounded-2xl border border-white/[0.075] bg-[#111321]/80">
      <div className="flex items-center justify-between gap-4 border-b border-white/[0.055] px-5 py-4">
        <div>
          <div className="text-[10px] font-semibold tracking-[0.16em] text-blue-200/44">01 · PREPARE</div>
          <h2 className="mt-1 text-sm font-semibold text-white/76">导入高模</h2>
          <p className="mt-1.5 text-xs leading-5 text-white/30">
            点击或拖入多个 FBX；每个模型将作为独立任务处理 · 单次最多 20 个
          </p>
        </div>
      </div>

      <fieldset disabled={busy} className="p-5 disabled:opacity-55">
        <MultiFbxDropCard
          files={highModels}
          onFiles={selectHighModels}
          selectedIndex={selectedModelIndex}
          onSelect={onSelectedModelIndexChange}
          disabled={busy}
        />
      </fieldset>

      <div className="border-t border-white/[0.055] p-5">
        <button
          type="button"
          disabled={!modelReady || busy || !serviceReady}
          onClick={() => void submit()}
          className="flex h-14 w-full items-center justify-center gap-3 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-500 text-sm font-semibold text-white shadow-[0_18px_42px_rgba(37,99,235,.18)] transition hover:-translate-y-0.5 hover:brightness-110 active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:translate-y-0"
        >
          {busy ? <LoaderCircle className="h-4.5 w-4.5 animate-spin" /> : <Network className="h-4.5 w-4.5" />}
          {busy
            ? '正在提交任务…'
            : modelReady
              ? highModels.length > 1
                ? `开始处理 ${highModels.length} 个模型`
                : '开始自动拓扑'
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

export function AssetProcessingPage({
  mode,
  projectId,
  onBack,
  onLogout,
  navigation,
  onContinue,
}: AssetProcessingPageProps) {
  const copy = modeCopy[mode];
  const Icon = copy.Icon;
  const storageScope = projectId ?? 'standalone';
  const jobStorageKey = `li3d:asset-processing:${storageScope}:${mode}:job-id`;
  const jobBindingStorageKey = `li3d:asset-processing:${storageScope}:${mode}:job-binding`;
  const traceStorageKey = `li3d:asset-processing:${storageScope}:${mode}:trace`;
  const { project, isLoading: projectLoading, error: projectError } = useWorkflowProject(projectId);
  const replaceCurrentProject = useProjectStore((state) => state.replaceCurrentProject);
  const pipelineInputAsset = preferredPipelineInputAsset(project, mode);
  const hydratedInputRef = useRef('');
  const [initialAsset, setInitialAsset] = useState<File>();
  const [externalContinueBusy, setExternalContinueBusy] = useState(false);
  const [inputLoadError, setInputLoadError] = useState<string>();
  const [serviceStatus, setServiceStatus] = useState<AssetProcessingStatus>();
  const [serviceLoading, setServiceLoading] = useState(true);
  const [serviceError, setServiceError] = useState<string>();
  const [serviceCheck, setServiceCheck] = useState(0);
  const serviceRetryAttemptRef = useRef(0);
  const [jobBinding, setJobBinding] = useState<JobBinding | undefined>(() =>
    storedJobBinding(jobBindingStorageKey),
  );
  const [job, setJob] = useState<AssetJob | undefined>(() => {
    const restoredJobId = storedJobBinding(jobBindingStorageKey)?.jobId;
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
  const [retopologyInputFiles, setRetopologyInputFiles] = useState<File[]>([]);
  const [selectedRetopologyInputIndex, setSelectedRetopologyInputIndex] = useState(0);
  const [retopologyResultPreview, setRetopologyResultPreview] = useState<RetopologyResultPreview>();
  const [retopologyPreviewRecord, setRetopologyPreviewRecord] = useState<TaskHistoryRecord>();
  const [retopologyPreviewLoading, setRetopologyPreviewLoading] = useState(false);
  const [retopologyPreviewError, setRetopologyPreviewError] = useState<string>();
  const [retopologyPreviewStats, setRetopologyPreviewStats] = useState<AssetModelPreviewStats>();
  const [retopologyPreviewAction, setRetopologyPreviewAction] = useState<
    'download' | 'continue'
  >();
  const previewRequestRef = useRef(0);
  const handleRetopologyPreviewStats = useCallback((stats?: AssetModelPreviewStats) => {
    setRetopologyPreviewStats(stats);
  }, []);
  const jobId = job ? assetJobId(job) : '';
  const jobStatus = job?.status;
  const jobActive = Boolean(jobStatus && !terminalStatuses.has(jobStatus));
  const batchId = jobBinding?.batchId;
  const batchChildJobs = jobBinding?.childJobs;
  const batchSubmissionFailures = jobBinding?.submissionFailures;

  const handleRetopologyModelsChange = useCallback((files: File[]) => {
    previewRequestRef.current += 1;
    setRetopologyInputFiles(files);
    setInitialAsset((current) => (current && !files.includes(current) ? undefined : current));
    setRetopologyResultPreview(undefined);
    setRetopologyPreviewRecord(undefined);
    setRetopologyPreviewError(undefined);
    setRetopologyPreviewLoading(false);
    setRetopologyPreviewStats(undefined);
  }, []);

  const fetchBoundJob = useCallback(async () => {
    if (mode === 'retopology' && batchId && batchChildJobs?.length) {
      const children = await Promise.all(
        batchChildJobs.map(async (child) => ({
          sourceName: child.sourceName,
          job: await getAssetJob(child.jobId),
        })),
      );
      return aggregateRetopologyBatchJob(
        batchId,
        [
          ...children,
          ...(batchSubmissionFailures ?? []).map((failure, index) =>
            failedRetopologySubmissionChild(batchId, failure, index),
          ),
        ],
      );
    }
    if (!jobId) throw new Error('当前任务缺少有效 Job ID。');
    return getAssetJob(jobId);
  }, [batchChildJobs, batchId, batchSubmissionFailures, jobId, mode]);

  const clearJobLineage = useCallback(() => {
    setJob(undefined);
    setJobBinding(undefined);
    setError(undefined);
    window.sessionStorage.removeItem(jobStorageKey);
    window.sessionStorage.removeItem(jobBindingStorageKey);
    window.sessionStorage.removeItem(traceStorageKey);
    clearPendingSubmission(mode);
  }, [jobBindingStorageKey, jobStorageKey, mode, traceStorageKey]);

  const invalidateJobForInputChange = useCallback(() => {
    if (!job && !jobBinding) return;
    clearJobLineage();
  }, [clearJobLineage, job, jobBinding]);

  function handleSubmittedJob(nextJob: AssetJob, snapshot: SubmissionSnapshot) {
    if (mode === 'retopology') {
      previewRequestRef.current += 1;
      setRetopologyResultPreview(undefined);
      setRetopologyPreviewRecord(undefined);
      setRetopologyPreviewError(undefined);
      setRetopologyPreviewLoading(false);
    }
    const nextJobId = assetJobId(nextJob);
    if (!nextJobId) {
      clearJobLineage();
      setError('任务提交成功，但响应缺少有效 Job ID。');
      return;
    }
    const binding: JobBinding = {
      jobId: nextJobId,
      fingerprint: snapshot.fingerprint,
      pipelineInputAssetId:
        pipelineInputAsset && initialAsset === snapshot.sourceFile
          ? pipelineInputAsset.id
          : undefined,
      source: fileDescriptor(snapshot.sourceFile),
      sourceFile: snapshot.sourceFile,
      ...(snapshot.sourceFiles
        ? {
            sources: snapshot.sourceFiles.map(fileDescriptor),
            sourceFiles: snapshot.sourceFiles,
          }
        : {}),
      ...(snapshot.batchId ? { batchId: snapshot.batchId } : {}),
      ...(snapshot.childJobs ? { childJobs: snapshot.childJobs } : {}),
      ...(snapshot.submissionFailures?.length
        ? { submissionFailures: snapshot.submissionFailures }
        : {}),
    };
    const storedBinding: StoredJobBinding = {
      jobId: binding.jobId,
      fingerprint: binding.fingerprint,
      pipelineInputAssetId: binding.pipelineInputAssetId,
      source: binding.source,
      ...(binding.sources ? { sources: binding.sources } : {}),
      ...(binding.batchId ? { batchId: binding.batchId } : {}),
      ...(binding.childJobs ? { childJobs: binding.childJobs } : {}),
      ...(binding.submissionFailures ? { submissionFailures: binding.submissionFailures } : {}),
    };
    window.sessionStorage.setItem(jobStorageKey, nextJobId);
    window.sessionStorage.setItem(jobBindingStorageKey, JSON.stringify(storedBinding));
    setJobBinding(binding);
    setJob(nextJob);
  }

  useEffect(() => {
    if (!pipelineInputAsset || hydratedInputRef.current === pipelineInputAsset.id) return;
    let active = true;
    setInputLoadError(undefined);
    void fileFromPipelineAsset(pipelineInputAsset)
      .then((file) => {
        if (!active) return;
        hydratedInputRef.current = pipelineInputAsset.id;
        setInitialAsset(file);
      })
      .catch((reason) => {
        if (!active) return;
        setInputLoadError(reason instanceof Error ? reason.message : '无法读取上游模型。');
      });
    return () => {
      active = false;
    };
  }, [mode, pipelineInputAsset]);

  useEffect(() => {
    if (
      !jobBinding ||
      !jobBinding.pipelineInputAssetId ||
      projectLoading
    ) {
      return;
    }
    if (!pipelineInputAsset) {
      clearJobLineage();
      return;
    }
    if (pipelineInputAsset.id !== jobBinding.pipelineInputAssetId) {
      clearJobLineage();
      return;
    }
    if (jobBinding.sourceFile) return;
    if (!initialAsset) return;
    if (
      !matchesFileDescriptor(initialAsset, jobBinding.source)
    ) {
      clearJobLineage();
      return;
    }
    setJobBinding((current) => current ? { ...current, sourceFile: initialAsset } : current);
  }, [
    clearJobLineage,
    initialAsset,
    jobBinding,
    pipelineInputAsset,
    projectLoading,
  ]);

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
    if (jobId && jobBinding?.jobId === jobId) {
      const storedBinding: StoredJobBinding = {
        jobId: jobBinding.jobId,
        fingerprint: jobBinding.fingerprint,
        pipelineInputAssetId: jobBinding.pipelineInputAssetId,
        source: jobBinding.source,
        ...(jobBinding.sources ? { sources: jobBinding.sources } : {}),
        ...(jobBinding.batchId ? { batchId: jobBinding.batchId } : {}),
        ...(jobBinding.childJobs ? { childJobs: jobBinding.childJobs } : {}),
        ...(jobBinding.submissionFailures
          ? { submissionFailures: jobBinding.submissionFailures }
          : {}),
      };
      window.sessionStorage.setItem(jobStorageKey, jobId);
      window.sessionStorage.setItem(jobBindingStorageKey, JSON.stringify(storedBinding));
    } else {
      window.sessionStorage.removeItem(jobStorageKey);
      window.sessionStorage.removeItem(jobBindingStorageKey);
    }
  }, [jobBinding, jobBindingStorageKey, jobId, jobStorageKey]);

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
        const next = await fetchBoundJob();
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
          window.sessionStorage.removeItem(jobBindingStorageKey);
          setJob(undefined);
          setJobBinding(undefined);
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
  }, [fetchBoundJob, jobBindingStorageKey, jobId, jobStatus, jobStorageKey]);

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
        const next = await fetchBoundJob();
        if (!active) return;
        setError(undefined);
        setJob(next);
        if (terminalStatuses.has(next.status)) {
          active = false;
          unsubscribers.forEach((unsubscribe) => unsubscribe());
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

    const signalJobIds = mode === 'retopology' && batchChildJobs?.length
      ? batchChildJobs.map((child) => child.jobId)
      : [jobId];
    const unsubscribers = signalJobIds.map((signalJobId) =>
      subscribeAssetJobEvents(signalJobId, () => {
        void refreshFromServer();
      }),
    );
    return () => {
      active = false;
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [batchChildJobs, fetchBoundJob, jobId, mode]);

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
      const payload = mode === 'retopology' && batchId && batchChildJobs?.length
        ? aggregateRetopologyBatchJob(
            batchId,
            [
              ...await Promise.all(
                batchChildJobs.map(async (child) => ({
                  sourceName: child.sourceName,
                  job: await cancelAssetJob(child.jobId),
                })),
              ),
              ...(batchSubmissionFailures ?? []).map((failure, index) =>
                failedRetopologySubmissionChild(batchId, failure, index),
              ),
            ],
          )
        : await cancelAssetJob(jobId);
      setError(undefined);
      setJob(payload);
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : '取消任务失败。');
    } finally {
      setBusy(false);
    }
  }

  async function publishOutputToNextStage(input: {
    jobId: string;
    outputBlob: Blob;
    outputName: string;
    outputSize?: number;
    outputSha256?: string;
    sourceFile?: File;
    usePipelineParent: boolean;
    historyRecordId?: string;
    sourceMode?: 'processing-job' | 'manual';
    objectId?: string;
  }) {
    let targetProject = projectId
      ? useProjectStore.getState().projects.find((item) => item.id === projectId) ?? project
      : undefined;
    if (!targetProject) {
      targetProject = (
        await createProject({ name: `${fileStem(input.sourceFile?.name ?? input.outputName)} 流程` })
      ).project;
      replaceCurrentProject(targetProject);
    }

    let pipeline = targetProject.pipeline;
    let parentRevision = input.usePipelineParent
      ? getLatestUsablePipelineStageRevision(pipeline, pipelineParentStageForMode(mode))
      : undefined;
    let inputAssets: ProjectPipelineAssetReference[] = parentRevision
      ? [...parentRevision.outputAssets]
      : [];
    const selectedWorkspaceObjectId = targetProject.bakeWorkspace?.selectedObjectId;
    const validWorkspaceObjectId =
      selectedWorkspaceObjectId &&
      targetProject.bakeWorkspace?.bakeSets[selectedWorkspaceObjectId]
        ? selectedWorkspaceObjectId
        : undefined;
    // A published parent (including an explicitly chosen history result) may
    // inherit its Bake Set identity. A manually replaced file stays standalone.
    const inheritedObjectId =
      input.objectId ??
      (input.usePipelineParent
        ? resolvePipelineAssetObjectId(
            inputAssets,
            pipelineInputAsset?.objectId,
            validWorkspaceObjectId,
          )
        : undefined);
    const modelAssetPaths: string[] = [];
    const revisionId = createId();

    if (!parentRevision && input.sourceFile) {
      const sourceSnapshotId = createId();
      const savedSource = await saveBlobAsset({
        projectId: targetProject.id,
        category: 'models',
        blob: input.sourceFile,
        filename: `pipeline-${sourceSnapshotId}-source-${mode}-${input.sourceFile.name}`,
      });
      const sourceAsset: ProjectPipelineAssetReference = {
        id: sourceSnapshotId,
        kind: mode === 'retopology' ? 'high-model' : 'low-model',
        objectId: inheritedObjectId,
        name: input.sourceFile.name,
        url: savedSource.asset.url,
        relativePath: savedSource.asset.relativePath,
        mimeType: input.sourceFile.type || 'application/octet-stream',
        sizeBytes: input.sourceFile.size,
      };
      modelAssetPaths.push(savedSource.asset.relativePath ?? savedSource.asset.url);

      // A manually started retopology session still establishes a durable high-model
      // root, so its later bake stage can resolve the original source without back-writing.
      if (mode === 'retopology') {
        const timestamp = new Date().toISOString();
        const textureRoot = {
          id: createId(),
          stage: 'texture' as const,
          sourceMode: 'manual' as const,
          inputAssets: [] as ProjectPipelineAssetReference[],
          outputAssets: [sourceAsset],
          settings: { entry: 'standalone-retopology' },
          status: 'ready' as const,
          createdAt: timestamp,
          updatedAt: timestamp,
          completedAt: timestamp,
        };
        if (pipeline) pipeline = markDownstreamPipelineRevisionsStale(pipeline, 'texture');
        pipeline = publishPipelineRevision(pipeline, textureRoot);
        parentRevision = textureRoot;
        inputAssets = [sourceAsset];
      } else {
        inputAssets = [sourceAsset];
      }
    }

    const savedOutput = await saveBlobAsset({
      projectId: targetProject.id,
      category: 'models',
      blob: input.outputBlob,
      // Keep every published artifact on a revision-owned path so rerunning a
      // stage never rewrites the bytes referenced by historical checkpoints.
      filename: `pipeline-${revisionId}-output-${input.outputName}`,
    });
    modelAssetPaths.push(savedOutput.asset.relativePath ?? savedOutput.asset.url);
    const objectId = resolvePipelineAssetObjectId(inputAssets, inheritedObjectId);
    const outputAsset: ProjectPipelineAssetReference = {
      id: `${revisionId}:output`,
      kind: mode === 'uv' ? 'uv-model' : 'low-model',
      objectId,
      sourceRevisionId: parentRevision?.id,
      name: input.outputName,
      url: savedOutput.asset.url,
      relativePath: savedOutput.asset.relativePath,
      mimeType: input.outputBlob.type || 'application/octet-stream',
      sha256: input.outputSha256,
      sizeBytes: input.outputSize ?? input.outputBlob.size,
    };
    const stage = pipelineStageForMode(mode);
    if (pipeline) pipeline = markDownstreamPipelineRevisionsStale(pipeline, stage);
    const timestamp = new Date().toISOString();
    pipeline = publishPipelineRevision(pipeline, {
      id: revisionId,
      stage,
      sourceMode: input.sourceMode ?? 'processing-job',
      parentRevisionId: parentRevision?.id,
      inputAssets,
      outputAssets: [outputAsset],
      settings: {
        jobId: input.jobId,
        ...(input.sourceMode === 'manual' ? { entry: 'external-model' } : {}),
        ...(input.historyRecordId ? { historyRecordId: input.historyRecordId } : {}),
      },
      status: 'ready',
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: timestamp,
    });

    const previousManifest = targetProject.assetManifest ?? {
      models: [],
      references: [],
      generations: [],
      captures: [],
      layers: [],
      baked: [],
    };
    let nextProject: Project = {
      ...targetProject,
      pipeline,
      assetManifest: {
        ...previousManifest,
        models: Array.from(new Set([...previousManifest.models, ...modelAssetPaths])),
      },
      dirty: true,
      updatedAt: timestamp,
    };

    if (mode === 'uv' && objectId && nextProject.bakeWorkspace?.bakeSets[objectId]) {
      nextProject = {
        ...nextProject,
        bakeWorkspace: {
          ...nextProject.bakeWorkspace,
          activeStage: 'alignment',
          selectedObjectId: objectId,
          bakeSets: {
            ...nextProject.bakeWorkspace.bakeSets,
            [objectId]: {
              ...nextProject.bakeWorkspace.bakeSets[objectId],
              low: {
                name: outputAsset.name,
                url: outputAsset.url,
                relativePath: outputAsset.relativePath,
                mimeType: outputAsset.mimeType,
              },
            },
          },
        },
      };
    }

    const savedProject = await saveWorkspaceProject(nextProject);
    replaceCurrentProject(savedProject.project);
    const handoff =
      mode === 'uv' && objectId
        ? {
            objectId,
            lowModel: {
              name: outputAsset.name,
              url: outputAsset.url,
              mimeType: outputAsset.mimeType,
              file: new File([input.outputBlob], outputAsset.name, {
                type: outputAsset.mimeType || 'application/octet-stream',
              }),
            },
          }
        : undefined;
    onContinue(savedProject.project.id, handoff);
  }

  async function handleContinue(artifact: AssetArtifact) {
    const currentJobId = job ? assetJobId(job) : '';
    if (!currentJobId) throw new Error('当前任务缺少有效 Job ID。');
    if (jobBinding?.jobId !== currentJobId || !jobBinding.sourceFile) {
      throw new Error('当前任务的输入快照已失效，请使用当前输入重新提交任务。');
    }
    const usesPublishedInput = Boolean(
      pipelineInputAsset && jobBinding.pipelineInputAssetId === pipelineInputAsset.id,
    );
    await publishOutputToNextStage({
      jobId: currentJobId,
      outputBlob: await fetchVerifiedArtifactBlob(currentJobId, artifact),
      outputName: artifact.filename,
      outputSize: artifact.size_bytes,
      outputSha256: artifact.sha256,
      sourceFile: jobBinding.sourceFile,
      usePipelineParent: usesPublishedInput,
    });
  }

  async function handleImportedUvContinue(file: File) {
    if (mode !== 'uv' || externalContinueBusy) return;
    setExternalContinueBusy(true);
    setError(undefined);
    try {
      const usesPublishedInput = Boolean(
        pipelineInputAsset && initialAsset === file,
      );
      await publishOutputToNextStage({
        jobId: `external-model-${createId()}`,
        outputBlob: file,
        outputName: file.name,
        outputSize: file.size,
        usePipelineParent: usesPublishedInput,
        sourceMode: 'manual',
        objectId:
          pipelineInputAsset?.objectId ?? project?.bakeWorkspace?.selectedObjectId,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '外部模型传入烘焙失败。');
    } finally {
      setExternalContinueBusy(false);
    }
  }

  async function handleHistoryContinue(record: TaskHistoryRecord, output: TaskHistoryOutput) {
    await publishOutputToNextStage({
      jobId: record.id,
      outputBlob: await fetchTaskHistoryOutputBlob(output),
      outputName: output.filename,
      outputSize: output.sizeBytes,
      usePipelineParent: Boolean(projectId),
      historyRecordId: record.id,
    });
  }

  const handleRetopologyHistorySelect = useCallback(
    (record: TaskHistoryRecord, output?: TaskHistoryOutput) => {
      if (mode !== 'retopology') return;
      const requestId = previewRequestRef.current + 1;
      previewRequestRef.current = requestId;
      setRetopologyPreviewRecord(record);
      setRetopologyResultPreview(undefined);
      setRetopologyPreviewError(undefined);
      if (!output) {
        setRetopologyPreviewLoading(false);
        return;
      }
      setRetopologyPreviewLoading(true);
      void getHistoryModelFile(output)
        .then((file) => {
          if (previewRequestRef.current !== requestId) return;
          setRetopologyResultPreview({
            source: {
              key: `history:${record.id}:${output.id}`,
              file,
              label: output.filename,
              kind: 'result',
            },
            record,
            output,
          });
        })
        .catch((reason: unknown) => {
          if (previewRequestRef.current !== requestId) return;
          setRetopologyPreviewError(
            reason instanceof Error ? reason.message : '无法加载这条历史记录的拓扑模型。',
          );
        })
        .finally(() => {
          if (previewRequestRef.current === requestId) setRetopologyPreviewLoading(false);
        });
    },
    [mode],
  );

  useEffect(() => {
    if (mode !== 'retopology' || job?.status !== 'SUCCEEDED' || retopologyPreviewRecord) return;
    const artifact = finalRetopologyArtifacts(assetJobArtifacts(job)).find((item) =>
      /\.fbx$/i.test(item.filename),
    );
    if (!artifact || !jobId) return;
    const sourceKey = `job:${jobId}:${artifact.filename}`;
    if (retopologyResultPreview?.source.key === sourceKey) return;
    const requestId = previewRequestRef.current + 1;
    previewRequestRef.current = requestId;
    setRetopologyPreviewLoading(true);
    setRetopologyPreviewError(undefined);
    void fetchVerifiedArtifactBlob(jobId, artifact)
      .then((blob) => {
        if (previewRequestRef.current !== requestId) return;
        const file = new File([blob], artifact.filename, {
          type: blob.type || 'application/octet-stream',
        });
        setRetopologyResultPreview({
          source: {
            key: sourceKey,
            file,
            label: artifact.filename,
            kind: 'result',
          },
          artifact,
        });
      })
      .catch((reason: unknown) => {
        if (previewRequestRef.current !== requestId) return;
        setRetopologyPreviewError(
          reason instanceof Error ? reason.message : '拓扑结果加载失败。',
        );
      })
      .finally(() => {
        if (previewRequestRef.current === requestId) setRetopologyPreviewLoading(false);
      });
  }, [job, jobId, mode, retopologyPreviewRecord, retopologyResultPreview?.source.key]);

  const retopologyInputPreview = useMemo<AssetModelPreviewSource | undefined>(() => {
    const file = retopologyInputFiles[selectedRetopologyInputIndex];
    if (!file) return undefined;
    return {
      key: `input:${file.name}:${file.size}:${file.lastModified}`,
      file,
      label: file.name,
      kind: 'high',
    };
  }, [retopologyInputFiles, selectedRetopologyInputIndex]);

  async function handleRetopologyPreviewDownload() {
    if (!retopologyResultPreview || retopologyPreviewAction) return;
    setRetopologyPreviewAction('download');
    setError(undefined);
    try {
      if (retopologyResultPreview.output) {
        await downloadTaskHistoryOutput(retopologyResultPreview.output);
      } else if (retopologyResultPreview.artifact && jobId) {
        await downloadVerifiedArtifact(jobId, retopologyResultPreview.artifact);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '模型下载失败。');
    } finally {
      setRetopologyPreviewAction(undefined);
    }
  }

  async function handleRetopologyPreviewContinue() {
    if (!retopologyResultPreview || retopologyPreviewAction) return;
    setRetopologyPreviewAction('continue');
    setError(undefined);
    try {
      if (retopologyResultPreview.record && retopologyResultPreview.output) {
        await handleHistoryContinue(
          retopologyResultPreview.record,
          retopologyResultPreview.output,
        );
      } else if (retopologyResultPreview.artifact) {
        await handleContinue(retopologyResultPreview.artifact);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '传入 UV 失败。');
    } finally {
      setRetopologyPreviewAction(undefined);
    }
  }

  function handleOpenUvFromRetopology() {
    if (retopologyResultPreview) {
      void handleRetopologyPreviewContinue();
      return;
    }
    navigation.onOpenUv();
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
  const retopologyViewportContent: ReactNode = retopologyPreviewRecord ? (
    retopologyPreviewLoading ? (
      <RetopologyStatusViewport status="processing" progress={100} loadingResult />
    ) : retopologyPreviewError ? (
      <RetopologyStatusViewport
        status="failed"
        progress={retopologyPreviewRecord.progress}
        error={retopologyPreviewError}
      />
    ) : retopologyResultPreview ? (
      <AssetModelViewport
        source={retopologyResultPreview.source}
        onStats={handleRetopologyPreviewStats}
      />
    ) : (
      <RetopologyStatusViewport
        status={retopologyPreviewRecord.status}
        progress={retopologyPreviewRecord.progress}
        error={retopologyPreviewRecord.error}
        message={retopologyPreviewRecord.sourceName}
      />
    )
  ) : job && job.status !== 'SUCCEEDED' ? (
    <RetopologyStatusViewport
      status={job.status}
      progress={job.progress}
      message={job.stage_message}
      error={assetJobError(job) ?? error}
      onCancel={jobActive ? () => void handleCancel() : undefined}
    />
  ) : retopologyPreviewLoading ? (
    <RetopologyStatusViewport status="processing" progress={100} loadingResult />
  ) : retopologyPreviewError ? (
    <RetopologyStatusViewport
      status="failed"
      progress={job?.progress ?? 0}
      error={retopologyPreviewError}
    />
  ) : (
    <AssetModelViewport
      source={retopologyResultPreview?.source ?? retopologyInputPreview}
      onStats={handleRetopologyPreviewStats}
    />
  );

  return (
    <WorkflowShell
      projectName={project?.name ?? (projectLoading ? '正在载入项目…' : '独立使用')}
      eyebrow={`${mode === 'uv' ? '阶段 3' : '阶段 2'} · ${copy.title}`}
      onBack={onBack}
      backLabel="返回功能首页"
      connected={serviceReady}
      navigation={
        mode === 'retopology'
          ? { ...navigation, onOpenUv: handleOpenUvFromRetopology }
          : navigation
      }
      headerActions={<UserMenu onLogout={onLogout} />}
    >
      {mode === 'retopology' ? (
        <div className="relative min-h-0 flex-1 overflow-hidden bg-[#080914] pt-[82px] text-white">
          <div className="absolute bottom-0 left-0 right-0 top-[82px] 2xl:right-[264px] min-[1720px]:right-[344px]">
            {retopologyViewportContent}
          </div>

          <div className="workflow-scrollbar absolute bottom-5 left-5 top-[102px] z-20 w-[320px] overflow-y-auto rounded-2xl shadow-[0_24px_80px_rgba(0,0,0,.4)]">
            <AutoRetopologyWorkspace
              initialAsset={initialAsset}
              onAssetChange={invalidateJobForInputChange}
              onModelsChange={handleRetopologyModelsChange}
              selectedModelIndex={selectedRetopologyInputIndex}
              onSelectedModelIndexChange={setSelectedRetopologyInputIndex}
              onSubmissionInputsChange={invalidateJobForInputChange}
              serviceReady={serviceReady}
              serviceBlockReason={serviceBlockReason}
              onJob={handleSubmittedJob}
              setBusy={setBusy}
              busy={busy || jobActive}
              setError={setError}
            />
          </div>

          <div className="absolute right-5 top-[102px] z-20 2xl:right-[284px] min-[1720px]:right-[364px]">
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

          {retopologyResultPreview ? (
            <div className="absolute bottom-5 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-xl border border-white/[0.09] bg-[#090a12]/92 p-1.5 shadow-[0_16px_50px_rgba(0,0,0,.5)] backdrop-blur-xl 2xl:-translate-x-[calc(50%+132px)] min-[1720px]:-translate-x-[calc(50%+172px)]">
              <div className="flex h-9 items-center gap-2 border-r border-white/[0.08] px-3 text-[11px] tabular-nums text-white/42">
                <span>面 {retopologyPreviewStats?.triangles.toLocaleString('zh-CN') ?? '—'}</span>
                <span className="text-white/16">·</span>
                <span>点 {retopologyPreviewStats?.vertices.toLocaleString('zh-CN') ?? '—'}</span>
              </div>
              <button
                type="button"
                onClick={() => void handleRetopologyPreviewDownload()}
                disabled={Boolean(retopologyPreviewAction)}
                className="inline-flex h-9 items-center gap-2 rounded-lg px-3 text-xs text-white/58 transition hover:bg-white/[0.07] hover:text-white disabled:opacity-35"
              >
                {retopologyPreviewAction === 'download' ? (
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
                下载当前模型
              </button>
              <button
                type="button"
                onClick={() => void handleRetopologyPreviewContinue()}
                disabled={Boolean(retopologyPreviewAction)}
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-gradient-to-r from-blue-500 to-violet-500 px-4 text-xs font-semibold text-white shadow-[0_10px_28px_rgba(79,70,229,.22)] transition hover:brightness-110 disabled:opacity-35"
              >
                {retopologyPreviewAction === 'continue' ? (
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5" />
                )}
                传入 UV
              </button>
            </div>
          ) : null}
        </div>
      ) : (
      <div className="workflow-scrollbar relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-[#080914] pt-[82px] text-white 2xl:pr-[264px] min-[1720px]:pr-[344px]">
      <div className={`pointer-events-none absolute right-[7%] top-16 h-[420px] w-[420px] rounded-full blur-[120px] ${pageGlow}`} />
      <section className="relative z-[1] mx-auto w-full max-w-[1600px] px-6 pb-16 pt-10 lg:px-10 lg:pt-14">
        <button
          type="button"
          onClick={onBack}
          className="hidden items-center gap-2 text-sm text-white/42 transition hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" />
          返回功能首页
        </button>

        <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-center">
          <div className="flex items-start gap-4">
            <span className={`mt-0.5 grid h-11 w-11 shrink-0 place-items-center rounded-xl border ${iconStyle}`}>
              <Icon className="h-5 w-5" />
            </span>
            <div>
              <div className="flex flex-wrap items-center gap-2 text-[10px] font-semibold tracking-[0.2em] text-white/30">
                <span>{mode === 'uv' ? '阶段 3' : '阶段 2'} · {copy.eyebrow}</span>
                <span className={`rounded-full border px-2 py-0.5 tracking-normal ${
                  projectId
                    ? 'border-violet-300/16 bg-violet-400/[0.06] text-violet-100/58'
                    : 'border-white/[0.08] bg-white/[0.035] text-white/38'
                }`}>
                  {projectId
                    ? `项目流程 · ${project?.name ?? (projectLoading ? '载入中' : '未找到项目')}`
                    : '独立使用'}
                </span>
              </div>
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

        {(inputLoadError || projectError) && (
          <div className="mt-5 flex items-start gap-3 rounded-xl border border-amber-300/14 bg-amber-400/[0.05] p-4 text-xs leading-5 text-amber-100/68">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{inputLoadError ?? projectError}；仍可手动导入模型继续使用当前页面。</span>
          </div>
        )}

        {mode === 'uv' ? (
          <div className="mt-6 grid min-w-0 max-w-full items-stretch gap-4 overflow-hidden lg:grid-cols-[minmax(0,1fr)_280px] xl:grid-cols-[minmax(520px,1fr)_280px_minmax(360px,0.82fr)]">
            <AutoUvWorkspace
              initialAsset={initialAsset}
              onAssetChange={invalidateJobForInputChange}
              onContinueImported={handleImportedUvContinue}
              continuingImported={externalContinueBusy}
              onSubmissionInputsChange={invalidateJobForInputChange}
              serviceReady={serviceReady}
              serviceBlockReason={serviceBlockReason}
              onJob={handleSubmittedJob}
              setBusy={setBusy}
              busy={busy || jobActive}
              setError={setError}
            />
          <JobPanel
            mode={mode}
            job={job}
            busy={busy || jobActive}
            error={error}
            onCancel={() => void handleCancel()}
            onContinue={jobBinding?.sourceFile ? handleContinue : undefined}
            continueLabel={mode === 'uv' ? '保存并传入烘焙' : '保存并传入 UV'}
          />
          {job?.status === 'SUCCEEDED' ? (
            <div className="min-h-[560px] lg:col-span-2 xl:col-span-1">
              <AssetUvLayoutPreview
                job={job}
                busy={false}
                error={assetJobError(job) ?? error}
              />
            </div>
          ) : null}
          </div>
        ) : (
          <div className="mt-6 grid min-w-0 max-w-full items-stretch gap-4 xl:grid-cols-[330px_minmax(0,1fr)]">
            <AutoRetopologyWorkspace
              initialAsset={initialAsset}
              onAssetChange={invalidateJobForInputChange}
              onModelsChange={handleRetopologyModelsChange}
              selectedModelIndex={selectedRetopologyInputIndex}
              onSelectedModelIndexChange={setSelectedRetopologyInputIndex}
              onSubmissionInputsChange={invalidateJobForInputChange}
              serviceReady={serviceReady}
              serviceBlockReason={serviceBlockReason}
              onJob={handleSubmittedJob}
              setBusy={setBusy}
              busy={busy || jobActive}
              setError={setError}
            />
            <div className="relative min-h-[560px] overflow-hidden rounded-2xl">
              {retopologyPreviewRecord ? (
                retopologyPreviewLoading ? (
                  <RetopologyStatusViewport status="processing" progress={100} loadingResult />
                ) : retopologyPreviewError ? (
                  <RetopologyStatusViewport
                    status="failed"
                    progress={retopologyPreviewRecord.progress}
                    error={retopologyPreviewError}
                  />
                ) : retopologyResultPreview ? (
                  <AssetModelViewport source={retopologyResultPreview.source} />
                ) : (
                  <RetopologyStatusViewport
                    status={retopologyPreviewRecord.status}
                    progress={retopologyPreviewRecord.progress}
                    error={retopologyPreviewRecord.error}
                    message={retopologyPreviewRecord.sourceName}
                  />
                )
              ) : job && job.status !== 'SUCCEEDED' ? (
                <RetopologyStatusViewport
                  status={job.status}
                  progress={job.progress}
                  message={job.stage_message}
                  error={assetJobError(job) ?? error}
                  onCancel={jobActive ? () => void handleCancel() : undefined}
                />
              ) : retopologyPreviewLoading ? (
                <RetopologyStatusViewport status="processing" progress={100} loadingResult />
              ) : retopologyPreviewError ? (
                <RetopologyStatusViewport
                  status="failed"
                  progress={job?.progress ?? 0}
                  error={retopologyPreviewError}
                />
              ) : (
                <AssetModelViewport
                  source={retopologyResultPreview?.source ?? retopologyInputPreview}
                />
              )}

              {retopologyResultPreview ? (
                <div className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-xl border border-white/[0.09] bg-[#090a12]/92 p-1.5 shadow-[0_16px_50px_rgba(0,0,0,.5)] backdrop-blur-xl">
                  <button
                    type="button"
                    onClick={() => void handleRetopologyPreviewDownload()}
                    disabled={Boolean(retopologyPreviewAction)}
                    className="inline-flex h-9 items-center gap-2 rounded-lg px-3 text-xs text-white/58 transition hover:bg-white/[0.07] hover:text-white disabled:opacity-35"
                  >
                    {retopologyPreviewAction === 'download' ? (
                      <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Download className="h-3.5 w-3.5" />
                    )}
                    下载当前模型
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleRetopologyPreviewContinue()}
                    disabled={Boolean(retopologyPreviewAction)}
                    className="inline-flex h-9 items-center gap-2 rounded-lg bg-gradient-to-r from-blue-500 to-violet-500 px-4 text-xs font-semibold text-white shadow-[0_10px_28px_rgba(79,70,229,.22)] transition hover:brightness-110 disabled:opacity-35"
                  >
                    {retopologyPreviewAction === 'continue' ? (
                      <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="h-3.5 w-3.5" />
                    )}
                    传入 UV
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        )}

        <div className="mt-6 border-t border-white/[0.045] pt-4 text-[11px] text-white/20">
          <span className="inline-flex items-center gap-2">
            <Sparkles className="h-3.5 w-3.5" />
            {mode === 'uv'
              ? '源文件不会被覆盖；五项交付物仅在严格 QA 通过后原子发布。'
              : '源高模不会被覆盖；八项质量门禁全部通过后才会发布正式 BLEND 与 FBX。'}
          </span>
        </div>
      </section>
      </div>
      )}
      <HistorySidePanel
        module={mode}
        refreshKey={historyRefreshKey}
        activeTask={job ? {
          id: jobId,
          status: job.status,
          progress: job.progress,
        } : undefined}
        onContinue={handleHistoryContinue}
        selectedOutputId={retopologyResultPreview?.output?.id}
        onSelect={mode === 'retopology' ? handleRetopologyHistorySelect : undefined}
      />
    </WorkflowShell>
  );
}

export function AutoUvPage(props: Omit<AssetProcessingPageProps, 'mode'>) {
  return <AssetProcessingPage {...props} mode="uv" />;
}

export function AutoRetopologyPage(props: Omit<AssetProcessingPageProps, 'mode'>) {
  return <AssetProcessingPage {...props} mode="retopology" />;
}
