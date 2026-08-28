import type { LocalComputePlan } from '@liclick/contracts';
import { markPerformanceEvent } from '@/engine/performance/performanceTimeline';
import { createId } from '@/utils/id';

export type EngineTaskLane = 'gpu' | 'cpu' | 'io';
export type EngineSessionState = 'active' | 'suspended' | 'disposed';

export type EngineTaskContext = {
  id: number;
  signal: AbortSignal;
  plan: LocalComputePlan;
  markFirstResult: (detail?: Record<string, unknown>) => void;
  markMilestone: (name: string, detail?: Record<string, unknown>) => void;
};

export type EngineTaskOptions<T> = {
  key: string;
  label: string;
  lane: EngineTaskLane;
  priority?: 'user-visible' | 'background';
  replace?: boolean;
  run: (context: EngineTaskContext) => Promise<T>;
};

export type EngineResource = {
  id: string;
  kind: 'gpu' | 'worker' | 'bitmap' | 'cache' | 'other';
  label: string;
  estimatedBytes?: number;
  dispose: () => void | Promise<void>;
};

export type EngineSessionSnapshot = {
  id: string;
  projectId: string;
  state: EngineSessionState;
  queuedTasks: number;
  activeTasks: number;
  resources: number;
  estimatedResourceBytes: number;
};

type ScheduledTask<T = unknown> = EngineTaskOptions<T> & {
  id: number;
  controller: AbortController;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function abortError(message: string) {
  return new DOMException(message, 'AbortError');
}

function priorityValue(priority: EngineTaskOptions<unknown>['priority']) {
  return priority === 'background' ? 1 : 0;
}

export class EngineSession {
  readonly id = createId('engine');
  private state: EngineSessionState = 'active';
  private nextTaskId = 1;
  private queue: ScheduledTask[] = [];
  private readonly activeTasks = new Map<number, ScheduledTask>();
  private readonly resources = new Map<string, EngineResource>();
  private readonly listeners = new Set<(snapshot: EngineSessionSnapshot) => void>();
  private readonly activeDrainListeners = new Set<() => void>();

  constructor(
    readonly projectId: string,
    readonly plan: LocalComputePlan,
  ) {}

  subscribe(listener: (snapshot: EngineSessionSnapshot) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): EngineSessionSnapshot {
    let estimatedResourceBytes = 0;
    this.resources.forEach((resource) => {
      estimatedResourceBytes += resource.estimatedBytes ?? 0;
    });
    return {
      id: this.id,
      projectId: this.projectId,
      state: this.state,
      queuedTasks: this.queue.length,
      activeTasks: this.activeTasks.size,
      resources: this.resources.size,
      estimatedResourceBytes,
    };
  }

  private publish() {
    const snapshot = this.snapshot();
    this.listeners.forEach((listener) => listener(snapshot));
  }

  private laneLimit(lane: EngineTaskLane) {
    if (lane === 'gpu') return 1;
    if (lane === 'cpu') return this.plan.maxHeavyTaskConcurrency;
    return 2;
  }

  private activeInLane(lane: EngineTaskLane) {
    let count = 0;
    this.activeTasks.forEach((task) => {
      if (task.lane === lane) count += 1;
    });
    return count;
  }

  private pump() {
    if (this.state !== 'active' || this.queue.length === 0) return;
    this.queue.sort((left, right) => {
      const priorityDelta = priorityValue(left.priority) - priorityValue(right.priority);
      return priorityDelta || left.id - right.id;
    });
    let started = false;
    for (let index = 0; index < this.queue.length; ) {
      const task = this.queue[index];
      if (this.activeInLane(task.lane) >= this.laneLimit(task.lane)) {
        index += 1;
        continue;
      }
      this.queue.splice(index, 1);
      this.startTask(task);
      started = true;
    }
    if (started) this.publish();
  }

  private startTask(task: ScheduledTask) {
    this.activeTasks.set(task.id, task);
    const startedAt = performance.now();
    markPerformanceEvent('interaction', 'engine-task-start', {
      sessionId: this.id,
      projectId: this.projectId,
      taskId: task.id,
      key: task.key,
      label: task.label,
      lane: task.lane,
    });
    let firstResultMarked = false;
    const context: EngineTaskContext = {
      id: task.id,
      signal: task.controller.signal,
      plan: this.plan,
      markFirstResult: (detail) => {
        if (firstResultMarked) return;
        firstResultMarked = true;
        markPerformanceEvent('interaction', 'engine-task-first-result', {
          sessionId: this.id,
          projectId: this.projectId,
          taskId: task.id,
          elapsedMs: performance.now() - startedAt,
          ...detail,
        });
      },
      markMilestone: (name, detail) => {
        markPerformanceEvent('interaction', 'engine-task-milestone', {
          sessionId: this.id,
          projectId: this.projectId,
          taskId: task.id,
          milestone: name,
          elapsedMs: performance.now() - startedAt,
          ...detail,
        });
      },
    };
    void Promise.resolve()
      .then(() => {
        if (task.controller.signal.aborted) {
          throw abortError(`${task.label} was cancelled before execution.`);
        }
        return task.run(context);
      })
      .then((result) => {
        if (task.controller.signal.aborted) throw abortError(`${task.label} was cancelled.`);
        markPerformanceEvent('interaction', 'engine-task-complete', {
          sessionId: this.id,
          projectId: this.projectId,
          taskId: task.id,
          durationMs: performance.now() - startedAt,
        });
        task.resolve(result);
      })
      .catch((error) => {
        markPerformanceEvent('interaction', 'engine-task-terminal', {
          sessionId: this.id,
          projectId: this.projectId,
          taskId: task.id,
          durationMs: performance.now() - startedAt,
          status: task.controller.signal.aborted ? 'cancelled' : 'error',
        });
        task.reject(error);
      })
      .finally(() => {
        this.activeTasks.delete(task.id);
        if (this.activeTasks.size === 0) {
          this.activeDrainListeners.forEach((listener) => listener());
          this.activeDrainListeners.clear();
        }
        this.publish();
        this.pump();
      });
  }

  schedule<T>(options: EngineTaskOptions<T>) {
    if (this.state === 'disposed') {
      return Promise.reject(abortError(`Engine session for ${this.projectId} is disposed.`));
    }
    if (options.replace !== false) this.cancel(options.key);
    const taskId = this.nextTaskId++;
    const promise = new Promise<T>((resolve, reject) => {
      this.queue.push({
        ...options,
        id: taskId,
        controller: new AbortController(),
        resolve: (value) => resolve(value as T),
        reject,
      });
    });
    this.publish();
    this.pump();
    return promise;
  }

  cancel(key?: string) {
    this.activeTasks.forEach((task) => {
      if (!key || task.key === key) task.controller.abort();
    });
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const task = this.queue[index];
      if (key && task.key !== key) continue;
      this.queue.splice(index, 1);
      task.controller.abort();
      task.reject(abortError(`${task.label} was cancelled.`));
    }
    this.publish();
  }

  suspend() {
    if (this.state !== 'active') return;
    this.state = 'suspended';
    this.publish();
  }

  resume() {
    if (this.state !== 'suspended') return;
    this.state = 'active';
    this.publish();
    this.pump();
  }

  registerResource(resource: EngineResource) {
    if (this.state === 'disposed') {
      void Promise.resolve(resource.dispose()).catch(() => undefined);
      throw new Error(`Cannot register ${resource.label}; the engine session is disposed.`);
    }
    if (this.resources.has(resource.id)) {
      throw new Error(`Engine resource id is already registered: ${resource.id}`);
    }
    this.resources.set(resource.id, resource);
    this.publish();
    return () => this.releaseResource(resource.id);
  }

  async releaseResource(resourceId: string) {
    const resource = this.resources.get(resourceId);
    if (!resource) return;
    this.resources.delete(resourceId);
    this.publish();
    await resource.dispose();
  }

  async dispose() {
    if (this.state === 'disposed') return;
    this.state = 'disposed';
    this.cancel();
    if (this.activeTasks.size > 0) {
      await new Promise<void>((resolve) => {
        const timeout = window.setTimeout(() => {
          this.activeDrainListeners.delete(onDrained);
          resolve();
        }, 2_000);
        const onDrained = () => {
          window.clearTimeout(timeout);
          resolve();
        };
        this.activeDrainListeners.add(onDrained);
      });
    }
    const resources = [...this.resources.values()].reverse();
    this.resources.clear();
    this.publish();
    await Promise.allSettled(resources.map((resource) => resource.dispose()));
    this.listeners.clear();
  }
}
