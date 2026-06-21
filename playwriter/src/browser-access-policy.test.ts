import { describe, expect, it } from 'vitest'
import { doesBrowserAccessPolicyAllowUrl, type BrowserAccessPolicy } from './browser-access-policy.js'

describe('browser access policy', () => {
  it('uses profile-specific policy entries when a profile id is provided', () => {
    const policy: BrowserAccessPolicy = {
      mode: 'deny',
      allowedPatterns: [],
      profilePolicies: [
        {
          profileId: 'browser:work',
          mode: 'allowList',
          allowedPatterns: ['work.example/*'],
        },
        {
          profileId: 'browser:personal',
          mode: 'all',
          allowedPatterns: [],
        },
      ],
    }

    expect(doesBrowserAccessPolicyAllowUrl(policy, 'https://work.example/docs', 'browser:work')).toBe(true)
    expect(doesBrowserAccessPolicyAllowUrl(policy, 'https://other.example/docs', 'browser:work')).toBe(false)
    expect(doesBrowserAccessPolicyAllowUrl(policy, 'https://other.example/docs', 'browser:personal')).toBe(true)
    expect(doesBrowserAccessPolicyAllowUrl(policy, 'https://work.example/docs')).toBe(false)
  })

  it('treats ask and deny as blocked until the app grants access', () => {
    expect(doesBrowserAccessPolicyAllowUrl(undefined, 'https://example.com')).toBe(false)
    expect(doesBrowserAccessPolicyAllowUrl(null, 'https://example.com')).toBe(false)
    expect(doesBrowserAccessPolicyAllowUrl({
      mode: 'ask',
      allowedPatterns: [],
      profilePolicies: [],
    }, 'https://example.com')).toBe(false)
    expect(doesBrowserAccessPolicyAllowUrl({
      mode: 'deny',
      allowedPatterns: ['example.com/*'],
      profilePolicies: [],
    }, 'https://example.com')).toBe(false)
  })
})
