export function parseLimit(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 500) {
    throw new Error(`Unsupported context sync limit: ${raw}`);
  }
  return value;
}

export function parseSince(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const relativeHours = raw.match(/^(\d+)h$/i);
  if (relativeHours) {
    return new Date(Date.now() - Number(relativeHours[1]) * 60 * 60 * 1000).toISOString();
  }
  const since = new Date(raw);
  if (Number.isNaN(since.getTime())) {
    throw new Error(`Unsupported context decisions --since value: ${raw}`);
  }
  return since.toISOString();
}
