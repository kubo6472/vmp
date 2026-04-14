import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { authenticateSmokeRequest } from '../src/smokeAuth.js'

function buildRequestWithSmokeToken(token?: string) {
  const headers = new Headers()
  if (token) headers.set('x-smoke-token', token)
  return new Request('https://example.com/api/admin/smoke-auth', { headers })
}

describe('authenticateSmokeRequest', () => {
  it('returns not_configured when smoke secret is missing', () => {
    const request = buildRequestWithSmokeToken('provided')
    const result = authenticateSmokeRequest(request, {})
    assert.equal(result.ok, false)
    assert.equal(result.code, 'not_configured')
  })

  it('returns missing_token when header is absent', () => {
    const request = buildRequestWithSmokeToken()
    const result = authenticateSmokeRequest(request, { DEPLOY_SMOKE_AUTH_TOKEN: 'secret-token' })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'missing_token')
  })

  it('returns invalid_token for incorrect token', () => {
    const request = buildRequestWithSmokeToken('wrong-token')
    const result = authenticateSmokeRequest(request, { DEPLOY_SMOKE_AUTH_TOKEN: 'secret-token' })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'invalid_token')
  })

  it('returns ok for matching token', () => {
    const request = buildRequestWithSmokeToken('secret-token')
    const result = authenticateSmokeRequest(request, { DEPLOY_SMOKE_AUTH_TOKEN: 'secret-token' })
    assert.equal(result.ok, true)
  })
})
