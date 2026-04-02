/**
 * Shared role helpers for API authorization/entitlement checks.
 */

const ADMINISTRATIVE_ROLES = new Set([
  // App roles (see auth.js ROLES)
  'super_admin',
  'admin',
  'editor',
  'analyst',
  'moderator',
  // Defensive aliases used in some deployments/docs
  'owner',
  'staff',
  'manager',
])

export function isAdministrativeRole(role) {
  if (typeof role !== 'string') return false
  const normalized = role.trim().toLowerCase()
  if (!normalized || normalized === 'viewer') return false
  return ADMINISTRATIVE_ROLES.has(normalized)
}

