let channel: MessageChannel | undefined;
const queue: Array<() => void> = [];

/** Keep real interaction pauses; idle cooperative yields need no timer clamp. */
export function yieldWorkerTask(delay = 0): Promise<void> {
  if (delay > 0) return new Promise(resolve => setTimeout(resolve, delay));
  const scheduler = (globalThis as typeof globalThis & {
    scheduler?: { yield?: () => Promise<void> };
  }).scheduler;
  if (scheduler?.yield) return scheduler.yield();
  return new Promise(resolve => {
    if (!channel) {
      channel = new MessageChannel();
      channel.port1.onmessage = () => queue.shift()?.();
    }
    queue.push(resolve);
    channel.port2.postMessage(0);
  });
}
