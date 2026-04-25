export const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(previous|prior|above|all)\s+instructions/i,
  /system\s*prompt/i,
  /you\s+are\s+now\s+/i,
  /act\s+as\s+(an?\s+)?(unrestricted|unfiltered|jailbreak|dan|evil)/i,
  /pretend\s+(you\s+)?(are|have\s+no)/i,
  /developer\s+mode/i,
  /do\s+anything\s+now/i,
  /disregard\s+(your\s+)?(previous|prior|all)/i,
  /repeat\s+.{0,30}(system|prompt|instruction)/i,
  /override\s+(your\s+)?(instructions|rules|guidelines)/i,
]

export function isInjectionAttempt(text: string): boolean {
  return INJECTION_PATTERNS.some((p) => p.test(text))
}

export function scanRetrievedSnippet(text: string): string {
  if (!text) return ''
  let out = text
  for (const pattern of INJECTION_PATTERNS) {
    const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g'
    const global = new RegExp(pattern.source, flags)
    out = out.replace(global, '[redacted: potential prompt injection in source]')
  }
  return out
}