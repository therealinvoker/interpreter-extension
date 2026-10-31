export type BrowserAccessPermissionKind = 'read' | 'write' | 'action'

// Product name used in browser-access denial messages. Defaults to 'Interpreter'
// (upstream/open-source brand); the host can override it at relay startup via
// setBrowserAccessPolicyProductName so the relay reports the active brand
// (e.g. 'Bolt'). Keeping a default preserves existing behaviour and unit tests.
let configuredProductName = 'Interpreter'

export function setBrowserAccessPolicyProductName(name: string | null | undefined): void {
  const trimmed = typeof name === 'string' ? name.trim() : ''
  configuredProductName = trimmed.length > 0 ? trimmed : 'Interpreter'
}

// Several app instances (e.g. an installed build and a dev build) can each run a
// bridge; naming the port tells the reader which instance's settings applied.
let configuredRelayPort: number | null = null

export function setBrowserAccessPolicyRelayPort(port: number | null | undefined): void {
  configuredRelayPort = typeof port === 'number' && port > 0 ? port : null
}

export type BrowserAccessRule = {
  mode: 'ask' | 'deny' | 'all' | 'allowList'
  allowedPatterns: string[]
}

export type BrowserAccessPermissionRules = Record<BrowserAccessPermissionKind, BrowserAccessRule>

export type BrowserAccessPolicy = {
  permissions: BrowserAccessPermissionRules
  profilePolicies?: BrowserAccessProfilePolicy[]
}

export type BrowserAccessProfilePolicy = {
  profileId: string
  permissions: BrowserAccessPermissionRules
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

export type BrowserAccessRequest = {
  url: string
  action: 'open' | 'navigate' | 'use'
  permissionKind: BrowserAccessPermissionKind
  profileId: string | null
}

export function getBrowserAccessRuleMode(
  policy: BrowserAccessPolicy | null | undefined,
  profileId: string | null | undefined,
  permissionKind: BrowserAccessPermissionKind,
): BrowserAccessRule['mode'] | null {
  const profilePolicy = profileId
    ? policy?.profilePolicies?.find((entry) => entry.profileId === profileId)
    : null
  return (profilePolicy?.permissions || policy?.permissions)?.[permissionKind]?.mode ?? null
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
  permissionKind: BrowserAccessPermissionKind = 'read',
): boolean {
  const profilePolicy = profileId
    ? policy?.profilePolicies?.find((entry) => entry.profileId === profileId)
    : null
  const resolvedPermissions = profilePolicy?.permissions || policy?.permissions

  const rule = resolvedPermissions?.[permissionKind]
  if (rule?.mode === 'all') {
    return true
  }
  if (!rule || rule.mode === 'deny') {
    return false
  }
  // A blank page shows nothing, and every new tab starts there before it
  // navigates; the navigation itself is still checked.
  if (urlString === 'about:blank') {
    return true
  }
  if (rule.mode === 'ask') {
    return false
  }

  return rule.allowedPatterns.some((pattern) => doesPatternMatchUrl(pattern, urlString))
}

export function formatBrowserAccessPolicyErrorMessage(params: {
  policy: BrowserAccessPolicy | null | undefined
  attemptedUrl: string
  action: 'open' | 'navigate' | 'use'
  permissionKind?: BrowserAccessPermissionKind
  currentUrl?: string | null
  profileId?: string | null
}): string {
  const permissionKind = params.permissionKind ?? 'read'
  const profilePolicy = params.profileId
    ? params.policy?.profilePolicies?.find((entry) => entry.profileId === params.profileId)
    : null
  const rule = (profilePolicy?.permissions || params.policy?.permissions)?.[permissionKind]
  const allowedPatterns = rule?.allowedPatterns ?? []
  const patternSummary = !rule
    ? 'no browser policy loaded'
    : rule.mode === 'ask'
      ? `${permissionKind} access is set to Ask`
      : rule.mode === 'deny'
        ? `${permissionKind} access is set to Deny`
        : allowedPatterns.length > 0
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
    configuredRelayPort
      ? `${configuredProductName} browser settings (browser bridge on port ${configuredRelayPort}) blocked this request.`
      : `${configuredProductName} browser settings blocked this request.`,
    `Cannot ${actionLabel} "${params.attemptedUrl}" because it does not match the allowed page rules (${patternSummary}).`,
    currentUrlHint,
    'Change this in Settings > Browser.',
  ].filter(Boolean).join(' ')
}
