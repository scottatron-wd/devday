export const DIGEST_TRUNCATION_MARKER = '\n\n[...truncated middle section...]\n\n';
const DEFAULT_DIGEST_MAX_CHARS = 8_000;
const DEFAULT_MESSAGE_MAX_CHARS = 500;
const DIGEST_MAX_CHARS_ENV = 'DEVDAY_DIGEST_MAX_CHARS';
const DIGEST_MESSAGE_MAX_CHARS_ENV = 'DEVDAY_DIGEST_MESSAGE_MAX_CHARS';

/**
 * Keep both the beginning and end of a long digest so summaries still see
 * setup and outcomes from the same session.
 */
export function truncateConversationDigest(
  digest: string,
  maxChars = resolvePositiveInteger(process.env[DIGEST_MAX_CHARS_ENV], DEFAULT_DIGEST_MAX_CHARS),
): string {
  if (maxChars <= 0) return digest;
  if (digest.length <= maxChars) return digest;

  const markerLength = DIGEST_TRUNCATION_MARKER.length;
  const budget = Math.max(0, maxChars - markerLength);
  const headChars = Math.floor(budget * 0.55);
  const tailChars = budget - headChars;

  const head = digest.slice(0, headChars).trimEnd();
  const tail = digest.slice(-tailChars).trimStart();

  return `${head}${DIGEST_TRUNCATION_MARKER}${tail}`;
}

export function truncateDigestMessageText(
  text: string,
  maxChars = resolvePositiveInteger(process.env[DIGEST_MESSAGE_MAX_CHARS_ENV], DEFAULT_MESSAGE_MAX_CHARS),
): string {
  if (maxChars <= 0) return text;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '...';
}

export function isDigestTruncated(text: string): boolean {
  return text.includes(DIGEST_TRUNCATION_MARKER);
}

function resolvePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;

  return parsed;
}
