export function cleanCodexSummary(value: string | null | undefined): string {
  if (!value) return '';
  const cleaned = value
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, ' ')
    .replace(/<cwd>[\s\S]*?<\/cwd>/gi, ' ')
    .replace(/<shell>[\s\S]*?<\/shell>/gi, ' ')
    .replace(/<current_date>[\s\S]*?<\/current_date>/gi, ' ')
    .replace(/<timezone>[\s\S]*?<\/timezone>/gi, ' ')
    .replace(/<\/?[a-zA-Z_][^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (/^(none|null|n\/a|na|-|—)$/i.test(cleaned)) return '';
  return cleaned.length > 120 ? cleaned.slice(0, 120) : cleaned;
}

export function firstMeaningfulUserSummary(
  messages: Array<{ role: string; text: string }>,
): string {
  for (const msg of messages) {
    if (msg.role.toLowerCase() !== 'user') continue;
    const summary = cleanCodexSummary(msg.text);
    if (summary) return summary;
  }
  return cleanCodexSummary(messages[0]?.text);
}
