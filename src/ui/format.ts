const intFormat = new Intl.NumberFormat('en-US');

export const formatInt = (n: number): string => intFormat.format(n);

export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6).toString()} MB`;
  return `${Math.max(1, Math.round(n / 1e3)).toString()} KB`;
}
