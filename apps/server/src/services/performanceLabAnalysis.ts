// ALG-PERF-SESSION-001 v1.0.3: temporal correlation, never automatic causation.
type Row = Record<string, unknown>;
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.filter(v => v && typeof v === 'object' && !Array.isArray(v)) : [];
const tuples = (value: unknown): unknown[][] => Array.isArray(value) ? value.filter(Array.isArray) : [];
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export function analyzePerformanceSession(chunks: Array<{ payload: Row }>) {
  const frames: Array<{ end: number; duration: number }> = [];
  const spans: Array<{ start: number; duration: number; name: string; kind: string }> = [];
  let frameCount = 0;
  const modules = new Map<string, { 事件数: number; 带耗时事件数: number; 累计毫秒: number; 最长毫秒: number; 参数峰值: Record<string, number> }>();
  const counters: Record<string, number> = {};
  const resources: Row[] = [];
  for (const { payload } of chunks) {
    for (const key of ['frames', 'inputs', 'longTasks', 'longAnimationFrames', 'eventTimings', 'resources', 'memory', 'diagnostics', 'runtimeErrors', 'visibility']) {
      counters[key] = (counters[key] ?? 0) + (Array.isArray(payload[key]) ? payload[key].length : 0);
    }
    counters.timelineEventsDropped = (counters.timelineEventsDropped ?? 0) + (finite(payload.timelineEventsDropped) ? payload.timelineEventsDropped : 0);
    for (const resource of rows(payload.resources)) {
      if (!finite(resource.durationMs)) continue;
      resources.push(resource);
      resources.sort((a, b) => Number(b.durationMs) - Number(a.durationMs));
      if (resources.length > 12) resources.pop();
    }
    for (const [end, duration] of tuples(payload.frames)) {
      if (!finite(end) || !finite(duration) || duration <= 0) continue;
      frameCount++;
      if (duration > 33.34) {
        frames.push({ end, duration });
        frames.sort((a, b) => b.duration - a.duration);
        if (frames.length > 12) frames.pop();
      }
    }
    for (const [start, duration, attribution] of tuples(payload.longTasks)) {
      if (finite(start) && finite(duration)) spans.push({ start, duration, name: String(attribution ?? 'unknown'), kind: '主线程长任务' });
    }
    for (const event of rows(payload.timelineEvents)) {
      const detail = event.detail as Row | undefined;
      const duration = event.durationMs ?? detail?.durationMs ?? (event.category === 'react' ? detail?.actualDurationMs : undefined);
      const key = `${String(event.category)} / ${String(event.name)}`;
      const stats = modules.get(key) ?? { 事件数: 0, 带耗时事件数: 0, 累计毫秒: 0, 最长毫秒: 0, 参数峰值: {} };
      stats.事件数++;
      if (finite(duration) && duration >= 0) {
        stats.带耗时事件数++;
        stats.累计毫秒 += duration;
        stats.最长毫秒 = Math.max(stats.最长毫秒, duration);
      }
      for (const [key, value] of Object.entries(detail ?? {})) {
        if (finite(value)) stats.参数峰值[key] = Math.max(stats.参数峰值[key] ?? value, value);
      }
      modules.set(key, stats);
      if (event.name !== 'gpu-render-query-result' && finite(event.elapsedMs) && finite(duration) && duration > 0) {
        spans.push({ start: event.elapsedMs - duration, duration, name: String(event.name), kind: String(event.category) });
      }
    }
    for (const event of rows(payload.longAnimationFrames)) {
      if (finite(event.elapsedMs) && finite(event.durationMs)) spans.push({
        start: event.elapsedMs, duration: event.durationMs, kind: '长动画帧',
        name: rows(event.scripts).map(script => `${String(script.sourceFunctionName ?? script.invoker ?? '未知脚本')} ${String(script.durationMs)}ms`).join('; ') || '未提供脚本归因',
      });
    }
  }
  return {
    version: '1.0.3',
    说明: '列出超过33.34ms的最慢12帧；这是60FPS目标下的慢帧筛选，不代表实测显示器刷新率。时间重合是排查线索，不是因果证明。',
    采样帧数: frameCount,
    数据覆盖: counters,
    指标口径: {
      帧与输入: '逐帧rAF间隔、输入事件、输入等待/处理/呈现延迟；慢帧不是硬件GPU利用率。',
      业务模块: '模型加载、图层、投影、UV合成/合并、局部重绘、引擎任务调度按实际埋点记录；未触发模块没有样本。',
      渲染器: '每秒记录上一渲染帧的drawCalls/triangles、纹理/几何体/程序数量、画布尺寸与DPR。GPU查询仅在扩展支持且结果有效时记录。',
      脚本与网络: '长动画帧脚本函数、同源脚本路径与字符位置（浏览器提供时）；资源请求细分时间及字节数，跨源计时可能受浏览器限制。',
      React: '只统计实际收到的Profiler回调。生产构建可能未启用React profiling，0条不代表没有组件重渲染。',
      采集开销: 'collectorOverhead指标仅采样rAF采集器路径，不代表全部观察器和Worker开销。',
      保留范围: '原始分块完整导出；timelineEventsDropped表示超过每块2000条的事件数。汇总帧最多保留216000个；LoAF每条最多12个脚本；诊断值最多500字符。',
    },
    模块与操作明细: [...modules].map(([模块操作, stats]) => ({ 模块操作, ...stats })).sort((a, b) => b.最长毫秒 - a.最长毫秒),
    最慢资源请求: resources,
    模块说明: '事件与参数峰值按模块/操作分别统计，嵌套或并发片段不可直接相加作为总耗时。0条记录不代表模块性能正常。GPU结果记录的是异步查询返回时间，不冒充CPU阻塞位置。所有未排名样本仍在原始分块中。',
    慢帧定位: frames.map(frame => {
      const start = frame.end - frame.duration;
      const related = spans.filter(span => span.start < frame.end && span.start + span.duration > start)
        .sort((a, b) => b.duration - a.duration).slice(0, 8);
      return {
        开始秒: Number((start / 1000).toFixed(3)), 结束秒: Number((frame.end / 1000).toFixed(3)), 帧耗时毫秒: Number(frame.duration.toFixed(2)),
        同时段任务: related.map(span => ({ 类型: span.kind, 名称: span.name, 耗时毫秒: Number(span.duration.toFixed(2)) })),
        建议: related.some(span => span.kind === 'react') ? '检查该操作的组件重复更新、订阅范围和提交耗时；优化后重复同一操作对比。'
          : related.some(span => span.kind === '主线程长任务' || span.kind === '长动画帧') ? '对照脚本/业务片段，检查同步解码、整图复制、布局与主线程循环；适合的计算移入 Worker 后复测。'
            : related.length ? '检查重合业务片段的 CPU、GPU 回读和资源等待，保留输出质量并对照复测。'
              : '当前记录缺少归因证据；检查标签页可见性、浏览器性能轨迹和 GPU 计时，不能据此断定显卡性能不足。',
      };
    }),
    局限: '未记录或浏览器不支持的指标不补造；React提交时长按提交事件附近近似关联。后台节流、GPU执行和异步任务等待需要结合原始时间线核实。',
  };
}
