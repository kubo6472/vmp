/** Canonical admin-assignable roles (DB `users.role`). */
export const ASSIGNABLE_ROLES = [
  'viewer',
  'moderator',
  'analyst',
  'editor',
  'admin',
  'super_admin',
]

type AssignableRole = typeof ASSIGNABLE_ROLES[number]

const ROLE_RANK: Record<AssignableRole, number> = {
  viewer: 0,
  moderator: 1,
  analyst: 2,
  editor: 3,
  admin: 4,
  super_admin: 5,
}

export function isValidRoleName(role: unknown): role is AssignableRole {
  return typeof role === 'string' && ASSIGNABLE_ROLES.includes(role as AssignableRole)
}

/**
 * Whether `actorRole` may set a user to `newRole` at all (ignores target's current role).
 * super_admin is assignable only by super_admin.
 */
export function canActorAssignRole(actorRole: unknown, newRole: unknown) {
  if (!isValidRoleName(newRole)) return false
  if (newRole === 'super_admin') return actorRole === 'super_admin'
  return actorRole === 'admin' || actorRole === 'super_admin'
}

/**
 * Server-side matrix: who may change which user's role to what.
 * @param {object} p
 * @param {string} p.actorRole - JWT role of the admin performing the change
 * @param {string} p.targetCurrentRole - current role of the target user
 * @param {string} p.newRole - desired role
 * @returns {{ ok: true } | { ok: false, code: string, error: string }}
 */
export function evaluateRoleChange({
  actorRole,
  targetCurrentRole,
  newRole
}: any) {
  if (!isValidRoleName(newRole)) {
    return { ok: false, code: 'invalid_role', error: 'Invalid role' }
  }
  if (!canActorAssignRole(actorRole, newRole)) {
    return { ok: false, code: 'forbidden_role', error: 'You cannot assign this role' }
  }
  if (actorRole === 'admin') {
    if (targetCurrentRole === 'super_admin') {
      return { ok: false, code: 'forbidden_target', error: 'Only super_admin may edit super_admin accounts' }
    }
    if (newRole === 'super_admin') {
      return { ok: false, code: 'forbidden_role', error: 'Only super_admin can assign super_admin role' }
    }
  }
  return { ok: true }
}

/**
 * Admin cannot weaken their own role (would lock themselves out).
 */
export function evaluateSelfRoleChange({
  actorUserId,
  targetUserId,
  actorRole,
  newRole
}: any) {
  if (actorUserId !== targetUserId) return { ok: true }
  if (!isValidRoleName(actorRole) || !isValidRoleName(newRole)) return { ok: true }
  const before = ROLE_RANK[actorRole]
  const after = ROLE_RANK[newRole]
  if (typeof before !== 'number' || typeof after !== 'number') return { ok: true }
  if (after < before) {
    return { ok: false, code: 'self_demotion', error: 'You cannot demote your own account' }
  }
  return { ok: true }
}

/** Stripe-style subscription statuses we persist in D1. */
export const SUBSCRIPTION_STATUSES = ['active', 'trialing', 'past_due', 'cancelled', 'unpaid', 'incomplete']

export function normalizeSubscriptionStatusForPolicy(raw: any) {
  if (raw === null || raw === undefined || raw === 'none' || raw === '') return 'none'
  return typeof raw === 'string' ? raw : 'none'
}

/**
 * Manual admin edits: any known Stripe status is allowed; `none` marks the row cancelled (no access).
 * Unknown previous values (legacy rows) may only move to `none` or a known status after reset.
 */
export function evaluateSubscriptionStatusChange(prevRaw: any, nextRaw: any) {
  const prev = normalizeSubscriptionStatusForPolicy(prevRaw)
  const next = normalizeSubscriptionStatusForPolicy(nextRaw)
  if (next === 'none') {
    return { ok: true, prev, next: 'none' }
  }
  if (!SUBSCRIPTION_STATUSES.includes(next)) {
    return { ok: false, code: 'invalid_subscription_status', error: 'Invalid subscription status' }
  }
  if (prev !== 'none' && !SUBSCRIPTION_STATUSES.includes(prev)) {
    return {
      ok: false,
      code: 'invalid_subscription_transition',
      error: 'Unknown current subscription status; set to cancelled (none) first, then set the new status',
    }
  }
  return { ok: true, prev, next }
}
