let requestCounter = 0;

export function generateRequestId(): string {
  return `req-${Date.now()}-${++requestCounter}`;
}

export function ensureOutboundRequestId(data: Record<string, unknown>): Record<string, unknown> {
  if (typeof data.type !== 'string') return data;
  if (typeof data.requestId === 'string' && data.requestId.length > 0) return data;
  return { ...data, requestId: generateRequestId() };
}
