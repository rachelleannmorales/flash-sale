/**
 * User ID validation. Accepts any non-empty printable string ≤ 128 chars.
 */
const USER_ID_RE = /^[\w.@+\-]{1,128}$/;

export function normalizeUserId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (!USER_ID_RE.test(trimmed)) return null;
  return trimmed;
}
