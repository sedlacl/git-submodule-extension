const SHA_PATTERN = /^[0-9a-f]{40,64}$/i;

export function isSha(value: string): boolean {
  return SHA_PATTERN.test(value);
}

export function parseSha(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === "(initial)") {
    return null;
  }
  return isSha(trimmed) ? trimmed.toLowerCase() : null;
}

export function assertSha(value: string, label: string): string {
  const parsed = parseSha(value);
  if (!parsed) {
    throw new Error(`${label} is not a full Git object name: ${value}`);
  }
  return parsed;
}
