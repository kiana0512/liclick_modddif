/** One next item may prepare while the caller consumes the current item.
 * Preparation never owns the caller's GPU renderer. Each resource is either
 * handed to its consumer once or disposed once when the sequence closes.
 */
export function createSingleItemLookahead<T>(
  count: number,
  load: (index: number) => Promise<T>,
  dispose: (item: T) => void,
  enabled = true,
) {
  type Slot = { promise: Promise<T>; claimed: boolean };
  let index = 0, closed = false;
  const start = (i: number): Slot => {
    // With lookahead disabled, live sources must snapshot synchronously inside
    // take(), before another microtask can change the paint canvas.
    let promise: Promise<T>;
    try { promise = load(i); } catch (error) { promise = Promise.reject(error); }
    void promise.catch(() => undefined);
    return { promise, claimed: false };
  };
  let slot: Slot | undefined = enabled && count > 0 ? start(0) : undefined;
  return {
    async take() {
      if (closed || index >= count || slot?.claimed) throw new Error('Source closed or already consumed.');
      const current = slot ??= start(index);
      current.claimed = true;
      const item = await current.promise;
      if (slot === current) slot = undefined;
      if (closed) {
        dispose(item);
        throw new DOMException('Layer preparation cancelled.', 'AbortError');
      }
      index++;
      if (enabled && index < count) slot = start(index);
      return item;
    },
    async close() {
      if (closed) return;
      closed = true;
      const pending = slot;
      slot = undefined;
      if (pending) await pending.promise.then(item => {
        if (!pending.claimed) dispose(item);
      }, () => undefined);
    },
  };
}
