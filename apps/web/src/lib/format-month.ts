const SHORT_FMT: Intl.DateTimeFormatOptions = {
  month: 'short',
  year: '2-digit',
  timeZone: 'UTC',
};
const LONG_FMT: Intl.DateTimeFormatOptions = {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
};

export function formatMonthShort(month: string): string {
  return new Date(`${month}T00:00:00Z`).toLocaleDateString('en-US', SHORT_FMT);
}

export function formatMonthLong(month: string): string {
  return new Date(`${month}T00:00:00Z`).toLocaleDateString('en-US', LONG_FMT);
}
