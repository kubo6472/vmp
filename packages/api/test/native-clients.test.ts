import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAccessToken } from '../src/auth.js';
import {
  generatePairingCode,
  handleDevicePairingComplete,
  handleDevicePairingPoll,
  handleDevicePairingPreview,
  handleDevicePairingStart,
  handleNativePushRegister,
  handleNativePushUnregister,
  normalizeNativePushPlatform,
  normalizePairingCode,
  parsePairingLimit,
  redactPushDeviceQuery,
} from '../src/nativeClients.js';
import { invalidateSetting } from '../src/settingsStore.js';

const JWT_SECRET = 'test-secret-at-least-thirty-two-characters-long';

type PairingRow = {
  id: string;
  code_hash: string;
  status: string;
  user_id: string | null;
  device_name: string | null;
  device_platform: string | null;
  expires_at: string;
  completed_at: string | null;
  redeemed_at: string | null;
};

type PushRow = {
  id: string;
  user_id: string;
  platform: string;
  token: string;
  device_id: string | null;
};

class FakePairingDb {
  sessions: PairingRow[] = [];
  pushTokens: PushRow[] = [];
  settings = new Map<string, string>([['settings_changed_at', '0']]);
  users = new Map<string, { id: string; email: string; role: string; totp_enabled: number }>();
  failRefreshInsert = false;

  prepare(sql: string) {
    const db = this;
    const normalized = sql.replace(/\s+/g, ' ').trim();
    return {
      bind(...args: unknown[]) {
        return {
          async run() {
            if (normalized.startsWith('DELETE FROM device_pairing_sessions')) {
              const cutoff = String(args[0]);
              const before = db.sessions.length;
              db.sessions = db.sessions.filter((s) => s.expires_at >= cutoff);
              return { meta: { changes: before - db.sessions.length } };
            }
            if (normalized.startsWith('INSERT INTO device_pairing_sessions')) {
              db.sessions.push({
                id: String(args[0]),
                code_hash: String(args[1]),
                status: 'pending',
                user_id: null,
                device_name: (args[2] as string | null) ?? null,
                device_platform: (args[3] as string | null) ?? null,
                expires_at: String(args[4]),
                completed_at: null,
                redeemed_at: null,
              });
              return { meta: { changes: 1 } };
            }
            if (normalized.includes("SET status = 'approved'")) {
              const userId = String(args[0]);
              const id = String(args[1]);
              const row = db.sessions.find((s) => s.id === id && s.status === 'pending');
              if (!row || new Date(row.expires_at) < new Date()) return { meta: { changes: 0 } };
              row.status = 'approved';
              row.user_id = userId;
              row.completed_at = new Date().toISOString();
              return { meta: { changes: 1 } };
            }
            if (normalized.includes("SET status = 'expired'")) {
              const id = String(args[0]);
              const row = db.sessions.find((s) => s.id === id && s.status === 'pending');
              if (!row) return { meta: { changes: 0 } };
              row.status = 'expired';
              return { meta: { changes: 1 } };
            }
            if (normalized.includes("SET status = 'redeemed'")) {
              const id = String(args[0]);
              const row = db.sessions.find(
                (s) => s.id === id && s.status === 'approved' && !s.redeemed_at,
              );
              if (!row) return { meta: { changes: 0 } };
              row.status = 'redeemed';
              row.redeemed_at = new Date().toISOString();
              return { meta: { changes: 1 } };
            }
            if (normalized.startsWith('INSERT INTO refresh_tokens')) {
              if (db.failRefreshInsert) throw new Error('D1 unavailable');
              if (normalized.includes('WHERE EXISTS')) {
                const sessionId = String(args[4]);
                const row = db.sessions.find(
                  (s) => s.id === sessionId && s.status === 'approved' && !s.redeemed_at,
                );
                if (!row) return { meta: { changes: 0 } };
              }
              return { meta: { changes: 1 } };
            }
            if (normalized.startsWith('INSERT INTO native_push_tokens')) {
              db.pushTokens.push({
                id: String(args[0]),
                user_id: String(args[1]),
                platform: String(args[2]),
                token: String(args[3]),
                device_id: (args[4] as string | null) ?? null,
              });
              return { meta: { changes: 1 } };
            }
            if (normalized.startsWith('UPDATE native_push_tokens')) {
              const deviceId = args[0] as string | null;
              const id = String(args[1]);
              const userId = String(args[2]);
              const row = db.pushTokens.find((t) => t.id === id && t.user_id === userId);
              if (!row) return { meta: { changes: 0 } };
              if (deviceId) row.device_id = deviceId;
              return { meta: { changes: 1 } };
            }
            if (normalized.startsWith('DELETE FROM native_push_tokens')) {
              const userId = String(args[0]);
              const key = String(args[1]);
              const before = db.pushTokens.length;
              if (normalized.includes('AND token = ?')) {
                db.pushTokens = db.pushTokens.filter(
                  (t) => !(t.user_id === userId && t.token === key),
                );
              } else {
                db.pushTokens = db.pushTokens.filter(
                  (t) => !(t.user_id === userId && t.device_id === key),
                );
              }
              return { meta: { changes: before - db.pushTokens.length } };
            }
            return { meta: { changes: 0 } };
          },
          async first() {
            if (
              normalized.includes('FROM admin_settings') &&
              normalized.includes('WHERE key = ?')
            ) {
              const key = String(args[0]);
              if (!db.settings.has(key)) return null;
              return { value: db.settings.get(key) };
            }
            if (
              normalized.includes('device_pairing_sessions') &&
              normalized.includes('code_hash')
            ) {
              const codeHash = String(args[0]);
              const row = db.sessions.find((s) => s.code_hash === codeHash);
              if (!row) return null;
              if (normalized.includes('LEFT JOIN users')) {
                const user = row.user_id ? db.users.get(row.user_id) : null;
                return {
                  id: row.id,
                  status: row.status,
                  expires_at: row.expires_at,
                  user_id: row.user_id,
                  redeemed_at: row.redeemed_at,
                  email: user?.email ?? null,
                  role: user?.role ?? null,
                  totp_enabled: user?.totp_enabled ?? 0,
                  created_at: '2026-01-01T00:00:00.000Z',
                };
              }
              return {
                id: row.id,
                status: row.status,
                expires_at: row.expires_at,
                redeemed_at: row.redeemed_at,
                device_name: row.device_name,
                device_platform: row.device_platform,
              };
            }
            if (normalized.includes('FROM native_push_tokens WHERE platform')) {
              const platform = String(args[0]);
              const token = String(args[1]);
              const row = db.pushTokens.find((t) => t.platform === platform && t.token === token);
              return row ? { id: row.id, user_id: row.user_id } : null;
            }
            if (normalized.startsWith('SELECT 1 FROM users WHERE id')) {
              // requireAuth checks the account still exists. Tests that do not seed
              // users assume the authenticated caller is present.
              const id = String(args[0]);
              if (db.users.size === 0) return id ? { 1: 1 } : null;
              return db.users.has(id) ? { 1: 1 } : null;
            }
            return null;
          },
        };
      },
    };
  }

  async batch(statements: Array<{ run: () => Promise<{ meta: { changes: number } }> }>) {
    const snapshot = this.sessions.map((session) => ({ ...session }));
    try {
      const results = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      return results;
    } catch (error) {
      this.sessions = snapshot;
      throw error;
    }
  }
}

async function authHeader(userId: string) {
  const token = await createAccessToken(
    { id: userId, email: 'viewer@example.com', role: 'viewer' },
    JWT_SECRET,
  );
  return { Authorization: `Bearer ${token}` };
}

describe('generatePairingCode', () => {
  it('returns a 10-character alphanumeric code without ambiguous glyphs', () => {
    const code = generatePairingCode();
    assert.equal(code.length, 10);
    assert.match(code, /^[A-HJ-NP-Z2-9]+$/);
  });

  it('respects custom length', () => {
    assert.equal(generatePairingCode(6).length, 6);
  });
});

describe('normalizePairingCode', () => {
  it('uppercases and strips separators', () => {
    assert.equal(normalizePairingCode('ab-cd-ef-gh'), 'ABCDEFGH');
    assert.equal(normalizePairingCode('  xyz12345 '), 'XYZ12345');
  });

  it('rejects too-short or non-string values', () => {
    assert.equal(normalizePairingCode('abc'), null);
    assert.equal(normalizePairingCode(null), null);
    assert.equal(normalizePairingCode(12), null);
  });

  it('enforces the length boundaries', () => {
    assert.equal(normalizePairingCode('abcde'), null);
    assert.equal(normalizePairingCode('abcdef'), 'ABCDEF');
    assert.equal(normalizePairingCode('abcdefghijkl'), 'ABCDEFGHIJKL');
    assert.equal(normalizePairingCode('abcdefghijklm'), null);
  });
});

describe('parsePairingLimit', () => {
  it('accepts a complete positive integer', () => {
    assert.equal(parsePairingLimit('8', '1'), 8);
    assert.equal(parsePairingLimit(' 30 ', '1'), 30);
  });

  it('rejects trailing or non-numeric characters', () => {
    assert.equal(parsePairingLimit('999junk', '8'), 8);
    assert.equal(parsePairingLimit('10.5', '30'), 30);
    assert.equal(parsePairingLimit('0', '10'), 10);
    assert.equal(parsePairingLimit('-5', '10'), 10);
    assert.equal(parsePairingLimit('', '120'), 120);
  });
});

describe('normalizeNativePushPlatform', () => {
  it('accepts ios and android only', () => {
    assert.equal(normalizeNativePushPlatform('ios'), 'ios');
    assert.equal(normalizeNativePushPlatform('android'), 'android');
    assert.equal(normalizeNativePushPlatform('web'), null);
    assert.equal(normalizeNativePushPlatform(''), null);
  });
});

class FakeSegmentRateLimiter {
  counts = new Map<string, number>();
  idFromName(name: string) {
    return { name };
  }
  get(id: { name: string }) {
    const ns = this;
    return {
      async fetch(_input: string, init?: RequestInit) {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          mode?: string;
          key?: string;
          limit?: number;
        };
        if (body.mode !== 'pairing') {
          return new Response(JSON.stringify({ error: 'unsupported' }), { status: 400 });
        }
        const key = String(body.key ?? id.name);
        const limit = Number(body.limit);
        const existing = ns.counts.get(key) ?? 0;
        if (existing >= limit) {
          return new Response(JSON.stringify({ count: existing, limit, exceeded: true }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
        const count = existing + 1;
        ns.counts.set(key, count);
        return new Response(JSON.stringify({ count, limit, exceeded: count > limit }), {
          headers: { 'Content-Type': 'application/json' },
        });
      },
    };
  }
}

async function pairingEnv(db: FakePairingDb, settingOverrides: Record<string, string> = {}) {
  for (const [key, value] of Object.entries(settingOverrides)) {
    db.settings.set(key, value);
  }
  const env = { DB: db, JWT_SECRET, SEGMENT_RATE_LIMITER: new FakeSegmentRateLimiter() };
  for (const key of Object.keys(settingOverrides)) {
    await invalidateSetting(env, key, false);
  }
  return env;
}

describe('redactPushDeviceQuery', () => {
  it('redacts token and deviceId query values', () => {
    const raw = 'https://example.com/api/push/device?token=secret-token&deviceId=phone-1&keep=1';
    const redacted = redactPushDeviceQuery(raw);
    assert.equal(new URL(redacted).searchParams.get('token'), '[redacted]');
    assert.equal(new URL(redacted).searchParams.get('deviceId'), '[redacted]');
    assert.equal(new URL(redacted).searchParams.get('keep'), '1');
    assert.equal(redacted.includes('secret-token'), false);
    assert.equal(redacted.includes('phone-1'), false);
  });

  it('leaves URLs without those params unchanged', () => {
    const raw = 'https://example.com/api/push/device';
    assert.equal(redactPushDeviceQuery(raw), raw);
  });
});

describe('device pairing handlers', () => {
  it('starts, previews, completes, and redeems once', async () => {
    const db = new FakePairingDb();
    db.users.set('user-1', {
      id: 'user-1',
      email: 'viewer@example.com',
      role: 'viewer',
      totp_enabled: 0,
    });
    const env = await pairingEnv(db);

    const startRes = await handleDevicePairingStart(
      new Request('https://example.com/api/auth/device-pairing/start', {
        method: 'POST',
        body: JSON.stringify({ deviceName: 'Living Room', devicePlatform: 'tvos' }),
      }),
      env,
      {},
    );
    assert.equal(startRes.status, 201);
    const startBody = await startRes.json();
    assert.ok(startBody.pairingCode);
    assert.equal(String(startBody.pairingCode).length, 10);

    const headers = await authHeader('user-1');
    const previewRes = await handleDevicePairingPreview(
      new Request('https://example.com/api/auth/device-pairing/preview', {
        method: 'POST',
        headers,
        body: JSON.stringify({ pairingCode: startBody.pairingCode }),
      }),
      env,
      {},
    );
    assert.equal(previewRes.status, 200);
    const preview = await previewRes.json();
    assert.equal(preview.deviceName, 'Living Room');
    assert.equal(preview.devicePlatform, 'tvos');
    assert.equal(preview.status, 'pending');

    const completeRes = await handleDevicePairingComplete(
      new Request('https://example.com/api/auth/device-pairing/complete', {
        method: 'POST',
        headers,
        body: JSON.stringify({ pairingCode: startBody.pairingCode }),
      }),
      env,
      {},
    );
    assert.equal(completeRes.status, 200);

    const pollRes = await handleDevicePairingPoll(
      new Request('https://example.com/api/auth/device-pairing/poll', {
        method: 'POST',
        body: JSON.stringify({ pairingCode: startBody.pairingCode }),
      }),
      env,
      {},
    );
    assert.equal(pollRes.status, 200);
    const pollBody = await pollRes.json();
    assert.equal(pollBody.status, 'ready');
    assert.ok(pollBody.accessToken);
    assert.ok(pollBody.refreshToken);

    const pollAgain = await handleDevicePairingPoll(
      new Request('https://example.com/api/auth/device-pairing/poll', {
        method: 'POST',
        body: JSON.stringify({ pairingCode: startBody.pairingCode }),
      }),
      env,
      {},
    );
    assert.equal(pollAgain.status, 409);
  });

  it('does not consume the pairing code when refresh token insert fails', async () => {
    const db = new FakePairingDb();
    db.users.set('user-1', {
      id: 'user-1',
      email: 'viewer@example.com',
      role: 'viewer',
      totp_enabled: 0,
    });
    const env = await pairingEnv(db);
    const startRes = await handleDevicePairingStart(
      new Request('https://example.com/api/auth/device-pairing/start', {
        method: 'POST',
        body: JSON.stringify({ deviceName: 'Living Room', devicePlatform: 'tvos' }),
      }),
      env,
      {},
    );
    const { pairingCode } = await startRes.json();
    const headers = await authHeader('user-1');
    const completeRes = await handleDevicePairingComplete(
      new Request('https://example.com/api/auth/device-pairing/complete', {
        method: 'POST',
        headers,
        body: JSON.stringify({ pairingCode }),
      }),
      env,
      {},
    );
    assert.equal(completeRes.status, 200);

    db.failRefreshInsert = true;
    const failedPoll = await handleDevicePairingPoll(
      new Request('https://example.com/api/auth/device-pairing/poll', {
        method: 'POST',
        body: JSON.stringify({ pairingCode }),
      }),
      env,
      {},
    );
    assert.equal(failedPoll.status, 503);
    assert.equal((await failedPoll.json()).code, 'session_issue_failed');
    assert.equal(db.sessions[0].status, 'approved');
    assert.equal(db.sessions[0].redeemed_at, null);

    db.failRefreshInsert = false;
    const retryPoll = await handleDevicePairingPoll(
      new Request('https://example.com/api/auth/device-pairing/poll', {
        method: 'POST',
        body: JSON.stringify({ pairingCode }),
      }),
      env,
      {},
    );
    assert.equal(retryPoll.status, 200);
    const retryBody = await retryPoll.json();
    assert.equal(retryBody.status, 'ready');
    assert.ok(retryBody.accessToken);
    assert.ok(retryBody.refreshToken);
  });

  it('rejects preview without auth', async () => {
    const env = await pairingEnv(new FakePairingDb());
    const res = await handleDevicePairingPreview(
      new Request('https://example.com/api/auth/device-pairing/preview', {
        method: 'POST',
        body: JSON.stringify({ pairingCode: 'ABCDEFGH' }),
      }),
      env,
      {},
    );
    assert.equal(res.status, 401);
  });

  it('rejects preview for unknown pairing code', async () => {
    const env = await pairingEnv(new FakePairingDb());
    const headers = await authHeader('user-1');
    const res = await handleDevicePairingPreview(
      new Request('https://example.com/api/auth/device-pairing/preview', {
        method: 'POST',
        headers,
        body: JSON.stringify({ pairingCode: 'ABCDEFGH' }),
      }),
      env,
      {},
    );
    assert.equal(res.status, 404);
  });

  it('rate-limits pairing preview per code', async () => {
    const db = new FakePairingDb();
    const env = await pairingEnv(db);
    const startRes = await handleDevicePairingStart(
      new Request('https://example.com/api/auth/device-pairing/start', {
        method: 'POST',
        body: JSON.stringify({ deviceName: 'Living Room', devicePlatform: 'tvos' }),
      }),
      env,
      {},
    );
    const { pairingCode } = await startRes.json();
    const headers = await authHeader('user-1');

    for (let i = 0; i < 8; i++) {
      const res = await handleDevicePairingPreview(
        new Request('https://example.com/api/auth/device-pairing/preview', {
          method: 'POST',
          headers,
          body: JSON.stringify({ pairingCode }),
        }),
        env,
        {},
      );
      assert.equal(res.status, 200, `preview ${i + 1} should succeed`);
      await res.json();
    }

    const limited = await handleDevicePairingPreview(
      new Request('https://example.com/api/auth/device-pairing/preview', {
        method: 'POST',
        headers,
        body: JSON.stringify({ pairingCode }),
      }),
      env,
      {},
    );
    assert.equal(limited.status, 429);
    const body = await limited.json();
    assert.equal(body.code, 'rate_limited');
  });

  it('reads pairing preview per-code limit from admin_settings', async () => {
    const db = new FakePairingDb();
    const env = await pairingEnv(db, { pairing_preview_limit_per_code: '2' });
    const startRes = await handleDevicePairingStart(
      new Request('https://example.com/api/auth/device-pairing/start', {
        method: 'POST',
        body: JSON.stringify({ deviceName: 'Office', devicePlatform: 'androidtv' }),
      }),
      env,
      {},
    );
    const { pairingCode } = await startRes.json();
    const headers = await authHeader('user-1');

    for (let i = 0; i < 2; i++) {
      const res = await handleDevicePairingPreview(
        new Request('https://example.com/api/auth/device-pairing/preview', {
          method: 'POST',
          headers,
          body: JSON.stringify({ pairingCode }),
        }),
        env,
        {},
      );
      assert.equal(res.status, 200, `preview ${i + 1} should succeed`);
      await res.json();
    }

    const limited = await handleDevicePairingPreview(
      new Request('https://example.com/api/auth/device-pairing/preview', {
        method: 'POST',
        headers,
        body: JSON.stringify({ pairingCode }),
      }),
      env,
      {},
    );
    assert.equal(limited.status, 429);
  });

  it('falls back when pairing_preview_limit_per_code is not a full integer', async () => {
    const db = new FakePairingDb();
    const env = await pairingEnv(db, { pairing_preview_limit_per_code: '999junk' });
    const startRes = await handleDevicePairingStart(
      new Request('https://example.com/api/auth/device-pairing/start', {
        method: 'POST',
        body: JSON.stringify({ deviceName: 'Office', devicePlatform: 'androidtv' }),
      }),
      env,
      {},
    );
    const { pairingCode } = await startRes.json();
    const headers = await authHeader('user-1');

    for (let i = 0; i < 8; i++) {
      const res = await handleDevicePairingPreview(
        new Request('https://example.com/api/auth/device-pairing/preview', {
          method: 'POST',
          headers,
          body: JSON.stringify({ pairingCode }),
        }),
        env,
        {},
      );
      assert.equal(res.status, 200, `preview ${i + 1} should succeed under default limit 8`);
      await res.json();
    }

    const limited = await handleDevicePairingPreview(
      new Request('https://example.com/api/auth/device-pairing/preview', {
        method: 'POST',
        headers,
        body: JSON.stringify({ pairingCode }),
      }),
      env,
      {},
    );
    assert.equal(limited.status, 429);
  });

  it('rate-limits pairing start per IP from admin_settings', async () => {
    const db = new FakePairingDb();
    const env = await pairingEnv(db, { pairing_start_limit_per_ip: '1' });
    const first = await handleDevicePairingStart(
      new Request('https://example.com/api/auth/device-pairing/start', {
        method: 'POST',
        headers: { 'CF-Connecting-IP': '203.0.113.8' },
        body: '{}',
      }),
      env,
      {},
    );
    assert.equal(first.status, 201);
    await first.json();

    const second = await handleDevicePairingStart(
      new Request('https://example.com/api/auth/device-pairing/start', {
        method: 'POST',
        headers: { 'CF-Connecting-IP': '203.0.113.8' },
        body: '{}',
      }),
      env,
      {},
    );
    assert.equal(second.status, 429);
  });

  it('rate-limits pairing start with a global budget across IPs', async () => {
    const db = new FakePairingDb();
    const env = await pairingEnv(db, { pairing_start_limit_global: '1' });
    const first = await handleDevicePairingStart(
      new Request('https://example.com/api/auth/device-pairing/start', {
        method: 'POST',
        headers: { 'CF-Connecting-IP': '203.0.113.10' },
        body: '{}',
      }),
      env,
      {},
    );
    assert.equal(first.status, 201);
    await first.json();

    const second = await handleDevicePairingStart(
      new Request('https://example.com/api/auth/device-pairing/start', {
        method: 'POST',
        headers: { 'CF-Connecting-IP': '203.0.113.11' },
        body: '{}',
      }),
      env,
      {},
    );
    assert.equal(second.status, 429);
  });

  it('fails closed when SegmentRateLimiterDO is missing', async () => {
    const env = { DB: new FakePairingDb(), JWT_SECRET };
    const res = await handleDevicePairingStart(
      new Request('https://example.com/api/auth/device-pairing/start', {
        method: 'POST',
        body: '{}',
      }),
      env,
      {},
    );
    assert.equal(res.status, 429);
    assert.equal((await res.json()).code, 'rate_limited');
  });

  it('returns pending for unknown or malformed poll codes', async () => {
    const env = await pairingEnv(new FakePairingDb());
    const unknown = await handleDevicePairingPoll(
      new Request('https://example.com/api/auth/device-pairing/poll', {
        method: 'POST',
        body: JSON.stringify({ pairingCode: 'ZZZZZZZZZZ' }),
      }),
      env,
      {},
    );
    assert.equal(unknown.status, 200);
    assert.equal((await unknown.json()).status, 'pending');

    const malformed = await handleDevicePairingPoll(
      new Request('https://example.com/api/auth/device-pairing/poll', {
        method: 'POST',
        body: JSON.stringify({ pairingCode: 'ab' }),
      }),
      env,
      {},
    );
    assert.equal(malformed.status, 200);
    assert.equal((await malformed.json()).status, 'pending');
  });

  it('rejects complete without auth', async () => {
    const env = { DB: new FakePairingDb(), JWT_SECRET };
    const res = await handleDevicePairingComplete(
      new Request('https://example.com/api/auth/device-pairing/complete', {
        method: 'POST',
        body: JSON.stringify({ pairingCode: 'ABCDEFGH' }),
      }),
      env,
      {},
    );
    assert.equal(res.status, 401);
  });

  it('expires pending sessions past expires_at on poll', async () => {
    const db = new FakePairingDb();
    const env = await pairingEnv(db);
    const startRes = await handleDevicePairingStart(
      new Request('https://example.com/api/auth/device-pairing/start', {
        method: 'POST',
        body: '{}',
      }),
      env,
      {},
    );
    const { pairingCode } = await startRes.json();
    db.sessions[0].expires_at = new Date(Date.now() - 1000).toISOString();

    const pollRes = await handleDevicePairingPoll(
      new Request('https://example.com/api/auth/device-pairing/poll', {
        method: 'POST',
        body: JSON.stringify({ pairingCode }),
      }),
      env,
      {},
    );
    assert.equal(pollRes.status, 200);
    assert.equal((await pollRes.json()).status, 'expired');
  });
});

describe('native push handlers', () => {
  it('registers and refuses cross-account takeover', async () => {
    const db = new FakePairingDb();
    const env = { DB: db, JWT_SECRET };
    const headersA = await authHeader('user-a');
    const headersB = await authHeader('user-b');

    const first = await handleNativePushRegister(
      new Request('https://example.com/api/push/device', {
        method: 'POST',
        headers: headersA,
        body: JSON.stringify({ platform: 'ios', token: 'tok-1', deviceId: 'phone-a' }),
      }),
      env,
      {},
    );
    assert.equal(first.status, 201);

    const takeover = await handleNativePushRegister(
      new Request('https://example.com/api/push/device', {
        method: 'POST',
        headers: headersB,
        body: JSON.stringify({ platform: 'ios', token: 'tok-1' }),
      }),
      env,
      {},
    );
    assert.equal(takeover.status, 409);

    const reregister = await handleNativePushRegister(
      new Request('https://example.com/api/push/device', {
        method: 'POST',
        headers: headersA,
        body: JSON.stringify({ platform: 'ios', token: 'tok-1', deviceId: 'phone-a-v2' }),
      }),
      env,
      {},
    );
    assert.equal(reregister.status, 201);
    assert.equal(db.pushTokens.length, 1);
    assert.equal(db.pushTokens[0].device_id, 'phone-a-v2');

    const delQuery = await handleNativePushUnregister(
      new Request('https://example.com/api/push/device?token=tok-1', {
        method: 'DELETE',
        headers: headersA,
      }),
      env,
      {},
    );
    assert.equal(delQuery.status, 200);
    assert.equal(db.pushTokens.length, 0);

    const second = await handleNativePushRegister(
      new Request('https://example.com/api/push/device', {
        method: 'POST',
        headers: headersA,
        body: JSON.stringify({ platform: 'ios', token: 'tok-2', deviceId: 'phone-a' }),
      }),
      env,
      {},
    );
    assert.equal(second.status, 201);

    const delBody = await handleNativePushUnregister(
      new Request('https://example.com/api/push/device', {
        method: 'DELETE',
        headers: headersA,
        body: JSON.stringify({ token: 'tok-2' }),
      }),
      env,
      {},
    );
    assert.equal(delBody.status, 200);
    assert.equal(db.pushTokens.length, 0);
  });

  it('rejects unauthenticated register', async () => {
    const res = await handleNativePushRegister(
      new Request('https://example.com/api/push/device', {
        method: 'POST',
        body: JSON.stringify({ platform: 'ios', token: 'x' }),
      }),
      { DB: new FakePairingDb(), JWT_SECRET },
      {},
    );
    assert.equal(res.status, 401);
  });
});
