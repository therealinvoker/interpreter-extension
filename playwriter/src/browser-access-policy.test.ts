import { describe, expect, it } from 'vitest'
import { doesBrowserAccessPolicyAllowUrl, getBrowserAccessRuleMode, type BrowserAccessPolicy } from './browser-access-policy.js'

describe('browser access policy', () => {
  it('uses profile-specific policy entries when a profile id is provided', () => {
    const policy: BrowserAccessPolicy = {
      permissions: {
        read: { mode: 'deny', allowedPatterns: [] },
        write: { mode: 'deny', allowedPatterns: [] },
        action: { mode: 'deny', allowedPatterns: [] },
      },
      profilePolicies: [
        {
          profileId: 'browser:work',
          permissions: {
            read: { mode: 'allowList', allowedPatterns: ['work.example/*'] },
            write: { mode: 'allowList', allowedPatterns: ['write.example/*'] },
            action: { mode: 'deny', allowedPatterns: [] },
          },
        },
        {
          profileId: 'browser:personal',
          permissions: {
            read: { mode: 'all', allowedPatterns: [] },
            write: { mode: 'deny', allowedPatterns: [] },
            action: { mode: 'all', allowedPatterns: [] },
          },
        },
      ],
    }

    expect(doesBrowserAccessPolicyAllowUrl(policy, 'https://work.example/docs', 'browser:work')).toBe(true)
    expect(doesBrowserAccessPolicyAllowUrl(policy, 'https://other.example/docs', 'browser:work')).toBe(false)
    expect(doesBrowserAccessPolicyAllowUrl(policy, 'https://write.example/docs', 'browser:work', 'write')).toBe(true)
    expect(doesBrowserAccessPolicyAllowUrl(policy, 'https://work.example/docs', 'browser:work', 'action')).toBe(false)
    expect(doesBrowserAccessPolicyAllowUrl(policy, 'https://other.example/docs', 'browser:personal')).toBe(true)
    expect(doesBrowserAccessPolicyAllowUrl(policy, 'https://other.example/docs', 'browser:personal', 'action')).toBe(true)
    expect(doesBrowserAccessPolicyAllowUrl(policy, 'https://other.example/docs', 'browser:personal', 'write')).toBe(false)
    expect(doesBrowserAccessPolicyAllowUrl(policy, 'https://work.example/docs')).toBe(false)
  })

  it('treats ask and deny as blocked until the app grants access', () => {
    expect(doesBrowserAccessPolicyAllowUrl(undefined, 'https://example.com')).toBe(false)
    expect(doesBrowserAccessPolicyAllowUrl(null, 'https://example.com')).toBe(false)
    expect(doesBrowserAccessPolicyAllowUrl({
      permissions: {
        read: { mode: 'ask', allowedPatterns: [] },
        write: { mode: 'ask', allowedPatterns: [] },
        action: { mode: 'ask', allowedPatterns: [] },
      },
      profilePolicies: [],
    }, 'https://example.com')).toBe(false)
    expect(doesBrowserAccessPolicyAllowUrl({
      permissions: {
        read: { mode: 'deny', allowedPatterns: ['example.com/*'] },
        write: { mode: 'ask', allowedPatterns: [] },
        action: { mode: 'ask', allowedPatterns: [] },
      },
      profilePolicies: [],
    }, 'https://example.com')).toBe(false)
  })

  it('allows a blank page unless the permission is denied', () => {
    const rules = (mode: 'ask' | 'deny' | 'allowList') => ({ mode, allowedPatterns: mode === 'allowList' ? ['lmarena.ai/*'] : [] })
    const policy = (mode: 'ask' | 'deny' | 'allowList'): BrowserAccessPolicy => ({
      permissions: { read: rules(mode), write: rules(mode), action: rules(mode) },
      profilePolicies: [],
    })
    expect(doesBrowserAccessPolicyAllowUrl(policy('ask'), 'about:blank', null, 'write')).toBe(true)
    expect(doesBrowserAccessPolicyAllowUrl(policy('allowList'), 'about:blank', null, 'write')).toBe(true)
    expect(doesBrowserAccessPolicyAllowUrl(policy('deny'), 'about:blank', null, 'write')).toBe(false)
    expect(doesBrowserAccessPolicyAllowUrl(policy('ask'), 'about:blank#x', null, 'write')).toBe(false)
  })

  it('reports the rule mode, preferring the profile entry', () => {
    const policy: BrowserAccessPolicy = {
      permissions: {
        read: { mode: 'ask', allowedPatterns: [] },
        write: { mode: 'ask', allowedPatterns: [] },
        action: { mode: 'ask', allowedPatterns: [] },
      },
      profilePolicies: [{
        profileId: 'browser:work',
        permissions: {
          read: { mode: 'deny', allowedPatterns: [] },
          write: { mode: 'ask', allowedPatterns: [] },
          action: { mode: 'ask', allowedPatterns: [] },
        },
      }],
    }
    expect(getBrowserAccessRuleMode(policy, null, 'read')).toBe('ask')
    expect(getBrowserAccessRuleMode(policy, 'browser:work', 'read')).toBe('deny')
    expect(getBrowserAccessRuleMode(policy, 'browser:other', 'read')).toBe('ask')
    expect(getBrowserAccessRuleMode(null, null, 'read')).toBe(null)
  })
})
