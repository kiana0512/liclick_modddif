export function formatStorageBytes(value?: number) {
  if (value === undefined || !Number.isFinite(value)) return '待扫描';
  if (value < 1024) return `${Math.max(0, value)} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let amount = value;
  let index = -1;
  do {
    amount /= 1024;
    index += 1;
  } while (amount >= 1024 && index < units.length - 1);
  const digits = amount >= 100 ? 0 : amount >= 10 ? 1 : 2;
  return `${amount.toFixed(digits)} ${units[index]}`;
}
