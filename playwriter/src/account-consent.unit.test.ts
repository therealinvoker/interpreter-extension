import { describe, expect, test } from 'vitest'
import { isAccountConsentUrl } from './cdp-relay.js'

describe('isAccountConsentUrl', () => {
  test('matches account sign-in and consent screens', () => {
    expect(isAccountConsentUrl('https://accounts.google.com/signin/oauth/warning?authuser=6')).toBe(true)
    expect(isAccountConsentUrl('https://accounts.google.com/o/oauth2/v2/auth?client_id=x')).toBe(true)
    expect(isAccountConsentUrl('https://login.microsoftonline.com/common/oauth2/v2.0/authorize')).toBe(true)
    expect(isAccountConsentUrl('https://github.com/login/oauth/authorize?client_id=x')).toBe(true)
    expect(isAccountConsentUrl('https://slack.com/oauth/v2/authorize')).toBe(true)
  })

  test('leaves ordinary pages alone', () => {
    expect(isAccountConsentUrl('https://app.trybolt.ai/console/ui/overview/')).toBe(false)
    expect(isAccountConsentUrl('https://console.cloud.google.com/auth/scopes')).toBe(false)
    expect(isAccountConsentUrl('https://example.com/blog/oauth-explained')).toBe(false)
    expect(isAccountConsentUrl('about:blank')).toBe(false)
  })
})
