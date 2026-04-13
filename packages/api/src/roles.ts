/**
 * Shared role helpers for API authorization/entitlement checks.
 */

import { ROLES } from './auth.js'

// Derive administrative roles from the canonical ROLES list (excluding 'viewer'),
// plus defensive aliases used in some deployments/docs
const ADMINISTRATIVE_ROLES = new Set([
  ...ROLES.filter(r => r !== 'viewer'),
  'owner',
  'staff',
  'manager',
])

export function isAdministrativeRole(role: unknown) {
  if (typeof role !== 'string') return false
  const normalized = role.trim().toLowerCase()
  if (!normalized || normalized === 'viewer') return false
  return ADMINISTRATIVE_ROLES.has(normalized)
}
