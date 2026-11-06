const secrets = [
  /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/gi,
  /\bauthorization:\s*(?:token|basic)\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
]

export function redactText(text: string) {
  return secrets.reduce((value, pattern) => value.replace(pattern, '[redacted]'), text)
}

export function redact<T>(value: T): T {
  if (typeof value === 'string') return redactText(value) as T
  if (Array.isArray(value)) return value.map(redact) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)])) as T
  }
  return value
}
