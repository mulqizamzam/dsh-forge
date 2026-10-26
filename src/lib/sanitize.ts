/** Strip brace pairs from model-visible text. */
export function neutralize(input: string): string {
  if (typeof input !== 'string') return ''
  return input.replace(/\{\{/g, '').replace(/\}\}/g, '')
}

const DROP = Symbol('drop')

function toLossless(value: unknown, ancestors: Set<object>): unknown {
  if (value === null) return null
  switch (typeof value) {
    case 'string': return neutralize(value)
    case 'boolean': return value
    case 'number': {
      if (!Number.isFinite(value)) return null
      return Object.is(value, -0) ? 0 : value
    }
    case 'bigint': return String(value)
    case 'undefined':
    case 'function':
    case 'symbol':
      return DROP
  }
  const obj = value as object
  if (ancestors.has(obj)) return DROP
  if (Array.isArray(obj)) {
    ancestors.add(obj)
    const out = obj.map(item => { const c = toLossless(item, ancestors); return c === DROP ? null : c })
    ancestors.delete(obj)
    return out
  }
  const proto = Object.getPrototypeOf(obj)
  if (proto !== Object.prototype && proto !== null) {
    try { return toLossless(JSON.parse(JSON.stringify(obj)), ancestors) } catch { return DROP }
  }
  ancestors.add(obj)
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const c = toLossless(v, ancestors)
    if (c === DROP) continue
    out[neutralize(k)] = c
  }
  ancestors.delete(obj)
  return out
}

/** Guarantee lossless JSON + brace-pair-free strings (host tool-return contract). */
export function neutralizeDeep<T>(obj: T): T {
  const c = toLossless(obj, new Set<object>())
  return (c === DROP ? null : c) as T
}
