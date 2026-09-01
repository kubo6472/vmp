import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAccessToken, requireAuth } from '../src/auth.js';

const JWT_SECRET = 'test-secret-at-least-thirty-two-characters-long';

// Minimal D1 double: the `users` set holds the ids that still exist.
function fakeDb(users: Set<string>) {
  return {
    prepare(sql: string) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      return {
        bind(...args: unknown[]) {
          return {
            async first() {
              if (normalized.startsWith('SELECT 1 FROM users WHERE id')) {
                return users.has(String(args[0])) ? { 1: 1 } : null;
              }
              return null;
            },
          };
        },
      };
    },
  };
}

function requestWithToken(token?: string) {
  const headers = new Headers();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return new Request('https://example.com/api/protected', { headers });
}

describe('requireAuth account existence', () => {
  it('accepts a token whose user row still exists', async () => {
    const token = await createAccessToken(
      { id: 'user-1', email: 'viewer@example.com', role: 'viewer' },
      JWT_SECRET,
    );
    const env = { DB: fakeDb(new Set(['user-1'])), JWT_SECRET };
    const payload = await requireAuth(requestWithToken(token), env);
    assert.equal(payload.sub, 'user-1');
  });

  it('rejects a valid token for a deleted user', async () => {
    const token = await createAccessToken(
      { id: 'deleted-user', email: 'gone@example.com', role: 'viewer' },
      JWT_SECRET,
    );
    const env = { DB: fakeDb(new Set()), JWT_SECRET };
    await assert.rejects(requireAuth(requestWithToken(token), env), /User no longer exists/);
  });

  it('rejects when the Authorization header is missing', async () => {
    const env = { DB: fakeDb(new Set(['user-1'])), JWT_SECRET };
    await assert.rejects(requireAuth(requestWithToken(), env), /Missing Bearer token/);
  });
});
