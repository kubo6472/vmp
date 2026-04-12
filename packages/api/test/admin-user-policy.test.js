/**
 * Admin user / role / subscription policy (PR6).
 * Run: npm test --workspace=@vmp/api
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateRoleChange,
  evaluateSelfRoleChange,
  evaluateSubscriptionStatusChange,
  canActorAssignRole,
} from '../src/adminUserPolicy.js'

describe('canActorAssignRole', () => {
  it('allows super_admin only for super_admin actor', () => {
    assert.equal(canActorAssignRole('super_admin', 'super_admin'), true)
    assert.equal(canActorAssignRole('admin', 'super_admin'), false)
    assert.equal(canActorAssignRole('admin', 'editor'), true)
  })
})

describe('evaluateRoleChange', () => {
  it('blocks admin from editing super_admin target', () => {
    const r = evaluateRoleChange({
      actorRole: 'admin',
      targetCurrentRole: 'super_admin',
      newRole: 'viewer',
    })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'forbidden_target')
  })

  it('allows super_admin to demote another super_admin', () => {
    const r = evaluateRoleChange({
      actorRole: 'super_admin',
      targetCurrentRole: 'super_admin',
      newRole: 'admin',
    })
    assert.equal(r.ok, true)
  })
})

describe('evaluateSelfRoleChange', () => {
  it('blocks self-demotion', () => {
    const r = evaluateSelfRoleChange({
      actorUserId: 'u1',
      targetUserId: 'u1',
      actorRole: 'super_admin',
      newRole: 'admin',
    })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'self_demotion')
  })

  it('allows self promotion', () => {
    const r = evaluateSelfRoleChange({
      actorUserId: 'u1',
      targetUserId: 'u1',
      actorRole: 'admin',
      newRole: 'super_admin',
    })
    assert.equal(r.ok, true)
  })
})

describe('evaluateSubscriptionStatusChange', () => {
  it('allows any known status from active', () => {
    const r = evaluateSubscriptionStatusChange('active', 'past_due')
    assert.equal(r.ok, true)
    assert.equal(r.next, 'past_due')
  })

  it('allows none from any known status', () => {
    assert.equal(evaluateSubscriptionStatusChange('trialing', 'none').ok, true)
  })

  it('rejects unknown next status', () => {
    const r = evaluateSubscriptionStatusChange('active', 'bogus')
    assert.equal(r.ok, false)
  })

  it('blocks unknown prev unless moving to none', () => {
    const r = evaluateSubscriptionStatusChange('weird', 'active')
    assert.equal(r.ok, false)
    assert.equal(evaluateSubscriptionStatusChange('weird', 'none').ok, true)
  })
})
