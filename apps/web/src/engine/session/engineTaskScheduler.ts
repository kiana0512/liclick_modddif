import {
  cancelHeavyTasks,
  scheduleHeavyTask,
  type HeavyTaskOptions,
} from '@/engine/performance/heavyTaskScheduler';
import type { EngineSession } from './engineSession';

export function scheduleEngineHeavyTask<T>(
  session: EngineSession | undefined,
  options: HeavyTaskOptions<T>,
) {
  if (!session) return scheduleHeavyTask(options);
  options.onQueued?.();
  return session.schedule({
    key: options.key,
    label: options.label,
    lane: 'gpu',
    priority: options.priority,
    replace: options.replace,
    run: options.run,
  });
}

export function cancelEngineHeavyTasks(session: EngineSession | undefined, key?: string) {
  if (session) session.cancel(key);
  else cancelHeavyTasks(key);
}
