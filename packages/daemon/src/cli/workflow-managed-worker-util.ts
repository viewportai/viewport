export function listFlagValue(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function positiveIntFlagValue(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function commandPollSeconds(value: number | undefined, idleSeconds: number): number {
  return value ?? Math.min(idleSeconds, 1);
}

export async function safeText(response: Response | undefined): Promise<string> {
  if (!response) return '';
  try {
    return await response.text();
  } catch {
    return '';
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
