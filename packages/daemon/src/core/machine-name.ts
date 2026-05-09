export const MAX_MACHINE_DISPLAY_NAME_LENGTH = 80;

export function sanitizeMachineDisplayName(value: string | null | undefined): string | null {
  const normalized = value
    ?.replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return null;
  return normalized.slice(0, MAX_MACHINE_DISPLAY_NAME_LENGTH);
}
