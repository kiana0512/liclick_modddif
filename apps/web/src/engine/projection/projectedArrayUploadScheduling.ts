/**
 * Keeps active input aligned with a presented frame without making background
 * array residency depend on requestAnimationFrame. Hidden or throttled browser
 * surfaces can hold an rAF waiter until its 120ms safety timeout; repeating that
 * for every bounded upload stripe turns sub-second GPU work into many seconds.
 */
export async function yieldProjectedArrayUploadTurn(
  isViewportInteractionBusy: (() => boolean) | undefined,
  waitForPaint: () => Promise<void>,
  yieldToTask: () => Promise<void>,
): Promise<void> {
  if (isViewportInteractionBusy?.()) {
    await waitForPaint();
    return;
  }
  await yieldToTask();
}
