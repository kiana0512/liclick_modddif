import { useMemo, useState } from 'react';
import type { PipelineTraceReport, PipelineTraceSpan } from '@/engine/performance/tracing/types';
import { traceDuration } from '@/engine/performance/tracing/pipelineTrace';
import styles from './PipelineTraceView.module.css';

const modules: Record<string, string> = {
  project: 'M01 工程', model: 'M02 输入与资产', reference: 'M02 输入与资产',
  capture: 'M03 场景与捕获', generation: 'M04 生成', provider: 'M04 生成', result: 'M04 生成',
  layer: 'M05 图层', projection: 'M06 投影', material: 'M07 UV 与呈现',
  decimate: 'M10 模型处理', uv: 'M10 模型处理', save: 'M01 工程保存',
  task: 'M12 任务调度', http: 'M13 平台请求', shader: '共享渲染', gpu: '共享渲染',
  asset: 'M14 资产传输',
};
const stageLabels: Record<string, string> = {
  'model.load': '模型加载', 'model.read': '读取模型', 'model.parse': '解析模型',
  'model.normalize': '模型归一化', 'model.inspect': '网格 / 材质 / UV 检查',
  'uv.compose': 'UV 合成', 'save.ack': '保存确认', 'capture.encode': '捕获编码',
};
function traceDisplayInfo(span: PipelineTraceSpan) {
  const label = span.attributes?.functionName;
  const separator = label?.lastIndexOf('#') ?? -1;
  const source = separator > 0 ? label!.slice(0, separator) : undefined;
  return {
    module: span.name === 'uv.compose' ? 'M07 UV 与呈现' : modules[span.name.split('.')[0]] ?? '未分类',
    stage: stageLabels[span.name] ?? span.name,
    type: label ? '函数' : '阶段',
    namespace: source ? source.replace(/\.[cm]?[jt]sx?$/, '').replaceAll('/', '.') : '—',
    functionName: label ? separator > 0 ? label.slice(separator + 1) : label : '—',
    source: source ?? '未附源码位置（阶段记录）',
    location: span.producerId === 'browser' ? '主线程' : 'Worker',
    timing: span.kind === 'async' ? '异步 · 含等待' : '同步调用',
  };
}

export function PipelineTraceView({ report }: { report: PipelineTraceReport }) {
  const [failedOnly, setFailedOnly] = useState(false);
  const [page, setPage] = useState(0);
  const [phase, setPhase] = useState('');
  const [module, setModule] = useState('');
  const [view, setView] = useState<'summary' | 'calls'>('summary');
  const rows = report.spans.filter(s => (!module || traceDisplayInfo(s).module === module) && (!phase || s.name === phase) && (!failedOnly || s.status === 'error' || s.status === 'cancelled' || s.status === 'interrupted'));
  const groups = useMemo(() => {
    const result = new Map<string, { info: ReturnType<typeof traceDisplayInfo>; count: number; measured: number; total: number; max: number }>();
    for (const s of report.spans) {
      if (phase && s.name !== phase) continue;
      const info = traceDisplayInfo(s);
      if (module && info.module !== module) continue;
      if (failedOnly && !['error', 'cancelled', 'interrupted'].includes(s.status ?? '')) continue;
      const key = JSON.stringify([s.name, s.attributes?.functionName, s.producerId, s.kind]);
      const row = result.get(key) ?? { info, count: 0, measured: 0, total: 0, max: 0 };
      row.count++;
      const duration = traceDuration(s);
      if (duration !== null) { row.measured++; row.total += duration; row.max = Math.max(row.max, duration); }
      result.set(key, row);
    }
    return [...result.values()].sort((a, b) => b.total - a.total);
  }, [report, phase, module, failedOnly]);
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(report)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'function-timings.json'; link.click();
    URL.revokeObjectURL(url);
  };
  return <section className={styles.report} aria-label="函数计时报告">
    <header className={styles.header}>
      <div><div className={styles.eyebrow}>LOCAL TRACE / 本地诊断</div><h2>阶段与函数耗时</h2><p>从阶段定位慢点，再查看具体函数调用。</p></div>
      <button className={styles.button} onClick={download}>导出 JSON <span aria-hidden="true">↗</span></button>
    </header>
    <div className={styles.metrics}>
      <div><span>已采集记录</span><strong>{report.spans.length}<small> 条</small></strong></div>
      <div><span>覆盖模块</span><strong>{new Set(report.spans.map(s => traceDisplayInfo(s).module)).size}<small> 个</small></strong></div>
      <div><span>记录状态</span><strong className={report.completeness === 'complete' ? styles.good : styles.warning}>{({ complete: '已结束', partial: '部分记录', truncated: '已截断' })[report.completeness]}</strong></div>
      <div><span>丢弃记录</span><strong className={report.dropped ? styles.warning : undefined}>{report.dropped}<small> 条</small></strong></div>
    </div>
    <div className={styles.toolbar}>
      <label>模块<select aria-label="模块" value={module} onChange={event => { setModule(event.target.value); setPage(0); }}><option value="">全部模块</option>{[...new Set(report.spans.map(s => traceDisplayInfo(s).module))].map(name => <option key={name}>{name}</option>)}</select></label>
      <label>阶段<select aria-label="阶段" value={phase} onChange={event => { setPhase(event.target.value); setPage(0); }}><option value="">全部阶段</option>{[...new Set(report.spans.map(s => s.name))].map(name => <option key={name} value={name}>{stageLabels[name] ?? name}</option>)}</select></label>
      <label className={styles.check}><input type="checkbox" checked={failedOnly} onChange={e => { setFailedOnly(e.target.checked); setPage(0); }} />只看异常<span>失败 / 取消 / 中断</span></label>
    </div>
    <div className={styles.viewbar}>
      <div className={styles.tabs}><button aria-pressed={view === 'summary'} onClick={() => setView('summary')}>耗时排行</button><button aria-pressed={view === 'calls'} onClick={() => setView('calls')}>调用明细</button></div>
      <span>{view === 'summary' ? '按累计耗时降序 ↓' : '按记录创建顺序 ↑'} · 单位 ms</span>
    </div>
    {view === 'summary' ? <div className={styles.tableScroll}><table className={styles.table}>
      <thead><tr><th>模块</th><th>阶段</th><th>类型</th><th>命名空间</th><th>函数</th><th>位置</th><th>计时方式</th><th>调用</th><th title="包含失败调用的有效结束计时">已结束</th><th>累计 ↓</th><th>平均</th><th>最大</th></tr></thead>
      <tbody>{groups.map((g, i) => <tr key={i}>
        <td><span className={styles.module}>{g.info.module}</span></td><td>{g.info.stage}</td><td><span className={g.info.type === '函数' ? styles.functionBadge : styles.stageBadge}>{g.info.type}</span></td>
        <td className={styles.namespace}>{g.info.namespace.split('.').map((part, index) => <span key={index}>{index > 0 && '.'}<wbr />{part}</span>)}</td><td className={styles.functionName}>{g.info.functionName}</td><td>{g.info.location}</td><td className={styles.muted}>{g.info.timing}</td>
        <td className={styles.number}>{g.count}</td><td className={styles.number}>{g.measured}</td><td className={styles.duration}>{g.total.toFixed(2)}</td><td className={styles.number}>{g.measured ? (g.total / g.measured).toFixed(2) : '—'}</td><td className={styles.number}>{g.measured ? g.max.toFixed(2) : '—'}</td>
      </tr>)}</tbody>
    </table>{!groups.length && <p className={styles.empty}>当前筛选条件下没有记录</p>}</div> : <div className={styles.calls}>
      {rows.slice(page * 100, (page + 1) * 100).map(s => { const info = traceDisplayInfo(s); return <details className={styles.call} key={s.spanId}>
        <summary><span className={styles.sequence}>#{s.spanId}</span><span className={info.type === '函数' ? styles.functionBadge : styles.stageBadge}>{info.type === '函数' ? '函数' : '阶段'}</span><span className={styles.callName}>{info.type === '函数' ? info.functionName : info.stage}<small>{info.module} · {info.stage}</small></span><strong>{traceDuration(s)?.toFixed(2) ?? '—'} <small>ms</small></strong><span className={s.status === 'ok' ? styles.good : styles.warning}>{s.status === null ? '执行中' : ({ ok: '完成', error: '失败', cancelled: '取消', interrupted: '中断', skipped: '跳过' })[s.status]}</span></summary>
        <dl className={styles.detail}><div><dt>命名空间</dt><dd>{info.namespace}</dd></div><div><dt>源码位置</dt><dd>{info.source}</dd></div><div><dt>阶段标识</dt><dd>{s.name}</dd></div><div><dt>执行 / 计时</dt><dd>{info.location} · {info.timing}</dd></div><div><dt>操作 / 父调用</dt><dd>#{s.operationId} / {s.parentSpanId ? '#' + s.parentSpanId : '未关联'}</dd></div><div><dt>开始 / 结束 · ms</dt><dd>{s.startMs.toFixed(2)} / {s.endMs?.toFixed(2) ?? '—'}</dd></div><div><dt>关联记录</dt><dd>{s.links.join(', ') || '无'}</dd></div></dl>
      </details>; })}
      {!rows.length && <p className={styles.empty}>当前筛选条件下没有记录</p>}
      <div className={styles.pagination}><span>{rows.length} 条记录 · 每页 100 条</span><div><button className={styles.button} disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</button><span>{page + 1} / {Math.max(1, Math.ceil(rows.length / 100))}</span><button className={styles.button} disabled={(page + 1) * 100 >= rows.length} onClick={() => setPage(page + 1)}>下一页</button></div></div>
    </div>}
    <footer className={styles.note}><span aria-hidden="true">ⓘ</span><p>阶段与函数可能重叠，累计值不能相加为流程总时间。异步耗时包含等待，0.00 表示接近显示精度。记录状态仅描述已观测范围。</p></footer>
  </section>;
}
