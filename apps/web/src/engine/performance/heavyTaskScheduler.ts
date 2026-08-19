import { markPerformanceEvent } from '@/engine/performance/performanceTimeline';
import { scheduleAfterBrowserPaint } from '@/utils/browserScheduling';

export type HeavyTaskPriority = 'user-visible' | 'background';

export type HeavyTaskContext = {
  id: number;
  signal: AbortSignal;
  markFirstResult: (detail?: Record<string, unknown>) => void;
  markMilestone: (name: string, detail?: Record<string, unknown>) => void;
};

export type HeavyTaskOptions<T> = {
  key: string;
  label: string;
  priority?: HeavyTaskPriority;
  replace?: boolean;
  onQueued?: () => void;
  run: (context: HeavyTaskContext) => Promise<T>;
};

type QueuedTask<T = unknown> = HeavyTaskOptions<T> & {
  id: number;
  queuedAt: number;
  controller: AbortController;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

const queue: QueuedTask<unknown>[] = [];
let activeTask: QueuedTask<unknown> | undefined;
let nextTaskId = 1;
let pumpScheduled = false;

function now() {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

function abortError(label: string) {
  return new DOMException(`${label} was superseded by a newer task.`, 'AbortError');
}

function priorityValue(priority: HeavyTaskPriority | undefined) {
  return priority === 'background' ? 1 : 0;
}

function updateProbe() {
  if (typeof document === 'undefined') return;
  document.body.dataset.heavyTaskQueueDepth = String(queue.length + Number(Boolean(activeTask)));
  document.body.dataset.heavyTaskActive = activeTask?.label ?? '';
}

function nextPaint(callback: () => void) {
  scheduleAfterBrowserPaint(callback);
}

function schedulePump() {
  if (pumpScheduled || activeTask || queue.length === 0) return;
  pumpScheduled = true;
  nextPaint(() => {
    pumpScheduled = false;
    void pump();
  });
}

async function pump() {
  if (activeTask || queue.length === 0) return;
  queue.sort((left, right) => {
    const priorityDelta = priorityValue(left.priority) - priorityValue(right.priority);
    return priorityDelta || left.id - right.id;
  });
  const task = queue.shift()!;
  activeTask = task;
  updateProbe();
  const startedAt = now();
  markPerformanceEvent('interaction', 'heavy-task-start', {
    taskId: task.id,
    key: task.key,
    label: task.label,
    queueDelayMs: startedAt - task.queuedAt,
  });
  let firstResultMarked = false;
  const context: HeavyTaskContext = {
    id: task.id,
    signal: task.controller.signal,
    markFirstResult: (detail) => {
      if (firstResultMarked) return;
      firstResultMarked = true;
      markPerformanceEvent('interaction', 'heavy-task-first-result', {
        taskId: task.id,
        key: task.key,
        label: task.label,
        elapsedMs: now() - startedAt,
        ...detail,
      });
    },
    markMilestone: (name, detail) => {
      markPerformanceEvent('interaction', 'heavy-task-milestone', {
        taskId: task.id,
        key: task.key,
        label: task.label,
        milestone: name,
        elapsedMs: now() - startedAt,
        ...detail,
      });
    },
  };
  try {
    if (task.controller.signal.aborted) throw abortError(task.label);
    const result = await task.run(context);
    if (task.controller.signal.aborted) throw abortError(task.label);
    markPerformanceEvent('interaction', 'heavy-task-complete', {
      taskId: task.id,
      key: task.key,
      label: task.label,
      durationMs: now() - startedAt,
    });
    task.resolve(result);
  } catch (error) {
    markPerformanceEvent('interaction', 'heavy-task-terminal', {
      taskId: task.id,
      key: task.key,
      label: task.label,
      durationMs: now() - startedAt,
      status: task.controller.signal.aborted ? 'cancelled' : 'error',
    });
    task.reject(error);
  } finally {
    activeTask = undefined;
    updateProbe();
    schedulePump();
  }
}

/**
 * Serializes full-resolution texture work. onQueued runs synchronously so the
 * clicked control can publish feedback before the task starts after the next
 * paint. A replaceable task aborts stale work with the same key; the stale task
 * must still check the supplied signal before publishing its result.
 */
export function scheduleHeavyTask<T>(options: HeavyTaskOptions<T>) {
  const id = nextTaskId++;
  const queuedAt = now();
  options.onQueued?.();
  markPerformanceEvent('interaction', 'heavy-task-click-feedback', {
    taskId: id,
    key: options.key,
    label: options.label,
    feedbackMs: now() - queuedAt,
  });

  if (options.replace !== false) {
    activeTask?.key === options.key && activeTask.controller.abort();
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const stale = queue[index];
      if (stale.key !== options.key) continue;
      queue.splice(index, 1);
      stale.controller.abort();
      stale.reject(abortError(stale.label));
    }
  }

  const promise = new Promise<T>((resolve, reject) => {
    queue.push({
      ...options,
      id,
      queuedAt,
      controller: new AbortController(),
      resolve: (value) => resolve(value as T),
      reject,
    });
  });
  updateProbe();
  schedulePump();
  return promise;
}

export function cancelHeavyTasks(key?: string) {
  if (!key || activeTask?.key === key) activeTask?.controller.abort();
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    const task = queue[index];
    if (key && task.key !== key) continue;
    queue.splice(index, 1);
    task.controller.abort();
    task.reject(abortError(task.label));
  }
  updateProbe();
}
