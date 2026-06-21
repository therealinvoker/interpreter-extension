export type BrowserAccessPolicy = {
  mode: 'ask' | 'deny' | 'all' | 'allowList'
  allowedPatterns: string[]
  profilePolicies?: BrowserAccessProfilePolicy[]
}

export type BrowserAccessProfilePolicy = {
  profileId: string
  mode: 'ask' | 'deny' | 'all' | 'allowList'
  allowedPatterns: string[]
}

type ParsedPattern = {
  hostPattern: string
  pathPattern: string
  portPattern: string | null
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
}

function getEffectiveUrlPort(url: URL): string {
  if (url.port) {
    return url.port
  }
  if (url.protocol === 'https:') {
    return '443'
  }
  if (url.protocol === 'http:') {
    return '80'
  }
  return ''
}

function parsePattern(pattern: string): ParsedPattern {
  const trimmed = pattern.trim().toLowerCase()
  const slashIndex = trimmed.indexOf('/')
  const authorityPattern = slashIndex === -1 ? trimmed : trimmed.slice(0, slashIndex)
  const pathPattern = slashIndex === -1 ? '/*' : trimmed.slice(slashIndex)
  const colonIndex = authorityPattern.lastIndexOf(':')

  if (colonIndex === -1) {
    return {
      hostPattern: authorityPattern,
      pathPattern,
      portPattern: null,
    }
  }

  return {
    hostPattern: authorityPattern.slice(0, colonIndex),
    pathPattern,
    portPattern: authorityPattern.slice(colonIndex + 1),
  }
}

function matchesHostPattern(hostname: string, hostPattern: string): boolean {
  const normalizedHostname = hostname.toLowerCase()
  if (hostPattern === '*') {
    return true
  }
  if (hostPattern.startsWith('*.')) {
    const suffix = hostPattern.slice(2)
    return normalizedHostname.endsWith(`.${suffix}`)
  }
  return normalizedHostname === hostPattern
}

function matchesPortPattern(url: URL, portPattern: string | null): boolean {
  if (!portPattern || portPattern === '*') {
    return true
  }
  return getEffectiveUrlPort(url) === portPattern
}

function matchesPathPattern(pathname: string, pathPattern: string): boolean {
  if (pathPattern === '/*') {
    return true
  }

  if (pathPattern.endsWith('/*') && pathPattern.indexOf('*') === pathPattern.length - 1) {
    const prefix = pathPattern.slice(0, -2)
    return pathname === prefix || pathname.startsWith(`${prefix}/`)
  }

  const regex = new RegExp(`^${escapeRegex(pathPattern).replace(/\\\*/g, '.*')}$`)
  return regex.test(pathname)
}

function doesPatternMatchUrl(pattern: string, urlString: string): boolean {
  let url: URL
  try {
    url = new URL(urlString)
  } catch {
    return false
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return false
  }

  const parsedPattern = parsePattern(pattern)
  return matchesHostPattern(url.hostname, parsedPattern.hostPattern)
    && matchesPortPattern(url, parsedPattern.portPattern)
    && matchesPathPattern(url.pathname || '/', parsedPattern.pathPattern)
}

export function doesBrowserAccessPolicyAllowUrl(
  policy: BrowserAccessPolicy | null | undefined,
  urlString: string,
  profileId?: string | null,
): boolean {
  const profilePolicy = profileId
    ? policy?.profilePolicies?.find((entry) => entry.profileId === profileId)
    : null
  const resolvedPolicy = profilePolicy || policy

  if (!resolvedPolicy || resolvedPolicy.mode === 'all') {
    return true
  }
  if (resolvedPolicy.mode === 'ask' || resolvedPolicy.mode === 'deny') {
    return false
  }

  return resolvedPolicy.allowedPatterns.some((pattern) => doesPatternMatchUrl(pattern, urlString))
}

export function formatBrowserAccessPolicyErrorMessage(params: {
  policy: BrowserAccessPolicy | null | undefined
  attemptedUrl: string
  action: 'open' | 'navigate' | 'use'
  currentUrl?: string | null
}): string {
  const allowedPatterns = params.policy?.allowedPatterns ?? []
  const patternSummary = allowedPatterns.length > 0
    ? allowedPatterns.join(', ')
    : 'no allowed page rules'
  const actionLabel = params.action === 'open'
    ? 'open'
    : params.action === 'navigate'
      ? 'navigate to'
      : 'use'
  const currentUrlHint = params.currentUrl
    ? `Current page: "${params.currentUrl}".`
    : ''

  return [
    `Interpreter browser settings blocked this request.`,
    `Cannot ${actionLabel} "${params.attemptedUrl}" because it does not match the allowed page rules (${patternSummary}).`,
    currentUrlHint,
    'Change this in Settings > Browser.',
  ].filter(Boolean).join(' ')
}
