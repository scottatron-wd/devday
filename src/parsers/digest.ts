const TRUNCATION_MARKER = '\n\n[...truncated middle section...]\n\n';

/**
 * Keep both the beginning and end of a long digest so summaries still see
 * setup and outcomes from the same session.
 */
export function truncateConversationDigest(
  digest: string,
  maxChars = 8_000,
): string {
  if (digest.length <= maxChars) return digest;

  const markerLength = TRUNCATION_MARKER.length;
  const budget = Math.max(0, maxChars - markerLength);
  const headChars = Math.floor(budget * 0.55);
  const tailChars = budget - headChars;

  const head = digest.slice(0, headChars).trimEnd();
  const tail = digest.slice(-tailChars).trimStart();

  return `${head}${TRUNCATION_MARKER}${tail}`;
}
