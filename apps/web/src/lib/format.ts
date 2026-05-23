const integerFormat = new Intl.NumberFormat('en-US');

export function formatGb(value: number): string {
  return `${integerFormat.format(Math.round(value))} GB`;
}

export function formatNumber(value: number): string {
  return integerFormat.format(Math.round(value));
}

export function todayIso(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
}
