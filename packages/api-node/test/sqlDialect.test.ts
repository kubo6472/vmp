import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  bindQuestionMarks,
  expandPostgresOnlyStatements,
  isPostgresDuplicateObjectError,
  splitExecutableSqlStatements,
  splitQuestionMarks,
  transformExecutableSql,
  translateSqliteDdl,
  translateSqliteToPostgres,
} from '../src/bindings/sqlDialect.js';

describe('expandPostgresOnlyStatements', () => {
  it('expands POSTGRES comment hints into executable SQL', () => {
    const sql = `-- POSTGRES: ALTER TABLE promo_redemptions DROP CONSTRAINT IF EXISTS promo_redemptions_promo_code_id_fkey;
DROP TABLE promo_codes;`;
    const out = expandPostgresOnlyStatements(sql);
    assert.match(out, /ALTER TABLE promo_redemptions DROP CONSTRAINT/);
    assert.match(out, /DROP TABLE promo_codes;/);
    assert.doesNotMatch(out, /--\s*POSTGRES:/i);
  });
});

describe('translateSqliteDdl migration 0039 cms_pages trigger', () => {
  it('strips SQLite trigger DDL and keeps POSTGRES replacement', () => {
    const sql = `CREATE TRIGGER IF NOT EXISTS cms_pages_set_updated_at
AFTER UPDATE ON cms_pages
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE cms_pages SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;
-- POSTGRES: CREATE OR REPLACE FUNCTION cms_pages_touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at THEN NEW.updated_at = CURRENT_TIMESTAMP; END IF; RETURN NEW; END; $$;
-- POSTGRES: DROP TRIGGER IF EXISTS cms_pages_set_updated_at ON cms_pages;
-- POSTGRES: CREATE TRIGGER cms_pages_set_updated_at BEFORE UPDATE ON cms_pages FOR EACH ROW EXECUTE PROCEDURE cms_pages_touch_updated_at();`;
    const out = translateSqliteDdl(sql);
    assert.doesNotMatch(out, /BEGIN\s+UPDATE cms_pages/i);
    assert.doesNotMatch(out, /CREATE TRIGGER IF NOT EXISTS/i);
    assert.doesNotMatch(out, /AFTER UPDATE ON cms_pages/i);
    assert.doesNotMatch(out, /WHEN NEW\.updated_at = OLD\.updated_at/i);
    assert.match(out, /CREATE OR REPLACE FUNCTION cms_pages_touch_updated_at/i);
    assert.match(out, /CREATE TRIGGER cms_pages_set_updated_at/i);
    assert.match(out, /BEFORE UPDATE ON cms_pages/i);
  });
});

describe('translateSqliteDdl migration 0036 promo_codes', () => {
  it('drops and recreates promo_redemptions FK around promo_codes table swap', () => {
    const sql = `PRAGMA foreign_keys = OFF;
INSERT INTO promo_codes__v2 SELECT id FROM promo_codes;
-- POSTGRES: ALTER TABLE promo_redemptions DROP CONSTRAINT IF EXISTS promo_redemptions_promo_code_id_fkey;
DROP TABLE promo_codes;
ALTER TABLE promo_codes__v2 RENAME TO promo_codes;
-- POSTGRES: ALTER TABLE promo_redemptions ADD CONSTRAINT promo_redemptions_promo_code_id_fkey FOREIGN KEY (promo_code_id) REFERENCES promo_codes(id) ON DELETE CASCADE;
PRAGMA foreign_keys = ON;`;
    const out = translateSqliteDdl(sql);
    assert.match(out, /DROP CONSTRAINT IF EXISTS promo_redemptions_promo_code_id_fkey/i);
    assert.match(out, /ADD CONSTRAINT promo_redemptions_promo_code_id_fkey/i);
    assert.doesNotMatch(out, /PRAGMA/i);
  });
});

describe('translateSqliteDdl migration 0060 account deletion FK cascade', () => {
  it('drops the licenses->devices FK before the offline_devices table swap', () => {
    const raw = readFileSync(
      join(import.meta.dirname, '../../api/migrations/0060_account_deletion_fk_cascade.sql'),
      'utf8',
    );
    const out = translateSqliteDdl(raw);
    const dropConstraint = out.search(
      /ALTER TABLE offline_download_licenses DROP CONSTRAINT IF EXISTS offline_download_licenses_device_id_fkey/i,
    );
    const dropDevices = out.search(/DROP TABLE offline_devices\b/i);
    assert.ok(dropConstraint >= 0, 'expected the device_id FK to be dropped for Postgres');
    assert.ok(dropDevices >= 0, 'expected offline_devices to be recreated');
    assert.ok(
      dropConstraint < dropDevices,
      'device_id FK must be dropped before offline_devices is dropped',
    );
    // PRAGMA statements are stripped for Postgres (the word may still appear in comments).
    assert.doesNotMatch(out, /^\s*PRAGMA\s+foreign_keys/im);
  });
});

describe('splitQuestionMarks', () => {
  it('splits placeholders outside quoted strings', () => {
    const parts = splitQuestionMarks(`SELECT * FROM users WHERE id = ? AND email = ?`);
    assert.deepEqual(parts, ['SELECT * FROM users WHERE id = ', ' AND email = ', '']);
    assert.equal(
      bindQuestionMarks(parts.join('?'), 2),
      'SELECT * FROM users WHERE id = $1 AND email = $2',
    );
  });

  it('ignores question marks inside string literals', () => {
    const parts = splitQuestionMarks(`WHERE note = 'a?b' AND id = ?`);
    assert.deepEqual(parts, [`WHERE note = 'a?b' AND id = `, '']);
  });

  it('handles escaped single and double quote pairs without splitting on them', () => {
    const sql = `WHERE a = 'it''s' AND b = "w""z" AND c = ?`;
    const parts = splitQuestionMarks(sql);
    assert.deepEqual(parts, [`WHERE a = 'it''s' AND b = "w""z" AND c = `, '']);
    assert.equal(
      bindQuestionMarks(parts.join('?'), 1),
      `WHERE a = 'it''s' AND b = "w""z" AND c = $1`,
    );
  });

  it('ignores question marks inside double-quoted string literals', () => {
    const parts = splitQuestionMarks(`WHERE col = "a?b" AND id = ?`);
    assert.deepEqual(parts, [`WHERE col = "a?b" AND id = `, '']);
    assert.equal(bindQuestionMarks(parts.join('?'), 1), 'WHERE col = "a?b" AND id = $1');
  });
});

describe('translateSqliteToPostgres datetime', () => {
  it('translates datetime(?) for replication cursors', () => {
    const sql = `WHERE (? = '' OR datetime(created_at) > datetime(?) OR (datetime(created_at) = datetime(?) AND id > ?))`;
    const out = translateSqliteToPostgres(sql);
    assert.match(out, /\(\?::timestamptz\)/);
    assert.doesNotMatch(out, /datetime\s*\(/i);
  });

  it('translates auth handoff expiry check', () => {
    const sql = `WHERE code = ? AND used_at IS NULL AND datetime(expires_at) > datetime('now')`;
    const out = translateSqliteToPostgres(sql);
    assert.match(out, /\(expires_at::timestamptz\)\s*>\s*CURRENT_TIMESTAMP/i);
    assert.doesNotMatch(out, /datetime\s*\(/i);
  });

  it('binds placeholders after translation', () => {
    const sql = translateSqliteToPostgres(`datetime(expires_at) > datetime('now') AND id = ?`);
    const bound = bindQuestionMarks(sql, 1);
    assert.match(bound, /\$1/);
    assert.doesNotMatch(bound, /datetime\s*\(/i);
  });
});

describe('transformExecutableSql instr', () => {
  it('translates instr() outside string literals', () => {
    const out = transformExecutableSql(`WHERE instr(content, 'hello') > 0`, (code) =>
      code.replace(/\binstr\s*\(/gi, 'strpos('),
    );
    assert.match(out, /strpos\(content/);
    assert.doesNotMatch(out, /\binstr\s*\(/i);
  });

  it('preserves instr inside single-quoted literals', () => {
    const out = transformExecutableSql(
      `WHERE note = 'instr(a,b)' AND instr(content, 'x') > 0`,
      (code) => code.replace(/\binstr\s*\(/gi, 'strpos('),
    );
    assert.match(out, /note = 'instr\(a,b\)'/);
    assert.match(out, /strpos\(content/);
  });

  it('preserves instr inside dollar-quoted literals', () => {
    const out = transformExecutableSql(
      `WHERE body = $$instr(a,b)$$ AND instr(content, 'x') > 0`,
      (code) => code.replace(/\binstr\s*\(/gi, 'strpos('),
    );
    assert.match(out, /body = \$\$instr\(a,b\)\$\$/);
    assert.match(out, /strpos\(content/);
  });
});

describe('translateSqliteToPostgres instr', () => {
  it('translates instr() outside string literals', () => {
    const out = translateSqliteToPostgres(`WHERE instr(content, 'hello') > 0`);
    assert.match(out, /strpos\(content/);
    assert.doesNotMatch(out, /\binstr\s*\(/i);
  });

  it('preserves instr inside string literals', () => {
    const out = translateSqliteToPostgres(`WHERE note = 'instr(a,b)' AND instr(content, 'x') > 0`);
    assert.match(out, /note = 'instr\(a,b\)'/);
    assert.match(out, /strpos\(content/);
  });

  it('preserves instr inside double-quoted identifiers', () => {
    const out = translateSqliteToPostgres(`SELECT "instr(col)" FROM t WHERE instr(a, b) > 0`);
    assert.match(out, /"instr\(col\)"/);
    assert.match(out, /strpos\(a/);
  });

  it('preserves instr inside dollar-quoted literals', () => {
    const out = translateSqliteToPostgres(
      `WHERE body = $$keep instr(a,b) here$$ AND instr(content, 'x') > 0`,
    );
    assert.match(out, /\$\$keep instr\(a,b\) here\$\$/);
    assert.match(out, /strpos\(content/);
  });
});

describe('translateSqliteDdl migration 0049 cms playback disclosure', () => {
  it('keeps Postgres jsonb append fallback when json_insert block is stripped', () => {
    const raw = readFileSync(
      join(import.meta.dirname, '../../api/migrations/0049_cms_playback_position_notice.sql'),
      'utf8',
    );
    const out = translateSqliteDdl(raw);
    assert.match(out, /content::jsonb\s*\|\|/);
    assert.match(out, /jsonb_typeof\(content::jsonb\)\s*=\s*'array'/);
    assert.match(out, /on-demand video \(VOD\)/);
    assert.match(out, /Continue watching on your account page/);
    assert.match(out, /If you request account deletion/);
    assert.match(out, /To request erasure of your account/);
    assert.doesNotMatch(out, /SET\s+content\s*=\s*json_insert/i);
    assert.match(out, /strpos\(content/);
  });
});

describe('translateSqliteToPostgres json_insert strip', () => {
  it('strips json_insert UPDATE statement', () => {
    const sql = `UPDATE cms_pages SET content = json_insert(content, '$[#]', json('{"a":1}')), updated_at = CURRENT_TIMESTAMP WHERE id = 'test';`;
    const out = translateSqliteToPostgres(sql);
    assert.match(out, /skipped/i);
    assert.doesNotMatch(out, /SET\s+content\s*=\s*json_insert/i);
  });

  it('does not consume statements after the json_insert semicolon', () => {
    const sql = `UPDATE cms_pages SET content = json_insert(content, '$[#]', json('{"a":1}')) WHERE id = 'x'; SELECT 1;`;
    const out = translateSqliteToPostgres(sql);
    assert.match(out, /SELECT 1/);
  });

  it('does not treat semicolons inside JSON string literals as statement boundaries', () => {
    const sql = `UPDATE cms_pages SET content = json_insert(content, '$[#]', json('{"text":"a;b"}')) WHERE id = 'x'; SELECT 2;`;
    const out = translateSqliteToPostgres(sql);
    assert.match(out, /skipped/i);
    assert.match(out, /SELECT 2/);
    assert.doesNotMatch(out, /SET\s+content\s*=\s*json_insert/i);
  });

  it('does not reflow SQL without a json_insert UPDATE', () => {
    const sql = `UPDATE cms_pages SET content = REPLACE(content, 'a', 'b') WHERE id = 'x';\nSELECT 1;`;
    const out = translateSqliteToPostgres(sql);
    assert.equal(out, sql);
    assert.doesNotMatch(out, /;\n$/);
  });

  it('preserves a trailing -- POSTGRES hint when no json_insert UPDATE is present', () => {
    const sql = `UPDATE cms_pages SET title = 'x' WHERE id = 'y';\n-- POSTGRES: ALTER TABLE cms_pages ADD COLUMN IF NOT EXISTS note TEXT;`;
    const out = translateSqliteToPostgres(sql);
    assert.equal(out, sql);
    assert.match(out, /--\s*POSTGRES:\s*ALTER TABLE cms_pages ADD COLUMN IF NOT EXISTS note TEXT;/);
  });

  it('preserves a trailing -- POSTGRES hint after json_insert strip', () => {
    const sql = `UPDATE cms_pages SET content = json_insert(content, '$[#]', json('{"a":1}')) WHERE id = 'x';\n-- POSTGRES: SELECT 1;`;
    const out = translateSqliteToPostgres(sql);
    assert.match(out, /skipped/i);
    assert.match(out, /--\s*POSTGRES:\s*SELECT 1;/);
    assert.doesNotMatch(out, /SET\s+content\s*=\s*json_insert/i);
  });
});

describe('splitExecutableSqlStatements', () => {
  it('ignores semicolons inside single-quoted JSON payloads', () => {
    const sql = `UPDATE t SET c = json('{"text":"a;b"}') WHERE id = 1; SELECT 1;`;
    const statements = splitExecutableSqlStatements(sql);
    assert.equal(statements.length, 2);
    assert.match(statements[0]!, /json\('\{"text":"a;b"\}'\)/);
    assert.match(statements[1]!, /SELECT 1/);
  });
});

describe('translateSqliteToPostgres rowid', () => {
  it('maps SQLite rowid to Postgres ctid for dedup migrations', () => {
    const sql = `UPDATE subscriptions SET purchase_id = NULL
WHERE purchase_id IS NOT NULL
  AND rowid NOT IN (
    SELECT MIN(rowid) FROM subscriptions WHERE purchase_id IS NOT NULL GROUP BY purchase_id
  )`;
    const out = translateSqliteToPostgres(sql);
    assert.match(out, /\bctid\b/);
    assert.doesNotMatch(out, /\browid\b/i);
    assert.match(out, /MIN\(ctid\)/i);
  });
});

describe('translateSqliteDdl ADD COLUMN idempotency', () => {
  it('rewrites ADD COLUMN to ADD COLUMN IF NOT EXISTS (migration 0051)', () => {
    const sql =
      'ALTER TABLE subscriptions ADD COLUMN cancel_at_period_end INTEGER NOT NULL DEFAULT 0;';
    const out = translateSqliteDdl(sql);
    assert.match(out, /ADD COLUMN IF NOT EXISTS cancel_at_period_end/i);
    assert.doesNotMatch(out, /ADD COLUMN cancel_at_period_end/i);
  });

  it('does not double-insert IF NOT EXISTS', () => {
    const sql = 'ALTER TABLE t ADD COLUMN IF NOT EXISTS note TEXT;';
    const out = translateSqliteDdl(sql);
    assert.equal((out.match(/IF NOT EXISTS/gi) ?? []).length, 1);
  });
});

describe('translateSqliteToPostgres INSERT OR IGNORE', () => {
  it('appends ON CONFLICT DO NOTHING only to INSERT OR IGNORE statements', () => {
    const sql = `INSERT OR IGNORE INTO cms_pages (id, slug) VALUES ('a', 'b');
UPDATE cms_pages SET title = 'x' WHERE id = 'a';`;
    const out = translateSqliteToPostgres(sql);
    const stmts = splitExecutableSqlStatements(out);
    assert.equal(stmts.length, 2);
    assert.match(stmts[0]!, /INSERT INTO cms_pages/i);
    assert.match(stmts[0]!, /ON CONFLICT DO NOTHING/i);
    assert.match(stmts[1]!, /UPDATE cms_pages SET title/i);
    assert.doesNotMatch(stmts[1]!, /ON CONFLICT/i);
  });

  it('does not double-append ON CONFLICT when already present', () => {
    const sql = `INSERT OR IGNORE INTO t (id) VALUES ('1') ON CONFLICT DO NOTHING;`;
    const out = translateSqliteToPostgres(sql);
    assert.equal((out.match(/ON CONFLICT DO NOTHING/gi) ?? []).length, 1);
  });

  it('preserves quoted semicolons inside INSERT OR IGNORE values', () => {
    const sql = `INSERT OR IGNORE INTO notes (body) VALUES ('hello; world');
UPDATE notes SET body = 'x' WHERE body = 'hello; world';`;
    const out = translateSqliteToPostgres(sql);
    const stmts = splitExecutableSqlStatements(out);
    assert.equal(stmts.length, 2);
    assert.match(stmts[0]!, /VALUES \('hello; world'\)/i);
    assert.match(stmts[0]!, /ON CONFLICT DO NOTHING/i);
    assert.doesNotMatch(stmts[1]!, /ON CONFLICT/i);
  });

  it('preserves trailing -- POSTGRES hints without an extra semicolon on open SQL', () => {
    const sql = `INSERT OR IGNORE INTO t (id) VALUES ('1')
-- POSTGRES: ALTER TABLE t ADD COLUMN IF NOT EXISTS note TEXT`;
    const out = translateSqliteToPostgres(sql);
    assert.match(out, /INSERT INTO t \(id\) VALUES \('1'\) ON CONFLICT DO NOTHING/i);
    assert.match(out, /--\s*POSTGRES:\s*ALTER TABLE t ADD COLUMN IF NOT EXISTS note TEXT/);
    assert.doesNotMatch(out.trimEnd(), /;\s*$/);
  });

  it('keeps personal-data seed UPDATE free of ON CONFLICT (0053 shape)', () => {
    const sql = readFileSync(
      join(import.meta.dirname, '../../api/migrations/0053_cms_personal_data_sk_short_notice.sql'),
      'utf8',
    );
    const out = translateSqliteDdl(sql);
    const stmts = splitExecutableSqlStatements(out);
    const updates = stmts.filter((s) => /(^|\n)\s*UPDATE\b/i.test(s));
    assert.ok(updates.length >= 1, `expected UPDATE statements, got ${stmts.length} stmts`);
    // 0053 is UPDATE-only (ui_locale must be set out-of-band); no INSERT OR IGNORE rewrite.
    assert.equal(
      stmts.filter((s) => /\bINSERT\s+INTO\b/i.test(s)).length,
      0,
      '0053 must not contain executable INSERT after dialect translate',
    );
    for (const update of updates) {
      assert.doesNotMatch(update, /ON CONFLICT/i);
    }
  });
});

describe('isPostgresDuplicateObjectError', () => {
  it('treats duplicate_column (42701) like other duplicate DDL codes', () => {
    assert.equal(isPostgresDuplicateObjectError({ code: '42701' }), true);
    assert.equal(isPostgresDuplicateObjectError({ code: '42P07' }), true);
    assert.equal(isPostgresDuplicateObjectError({ code: '42710' }), true);
    assert.equal(isPostgresDuplicateObjectError({ code: '23505' }), false);
    assert.equal(isPostgresDuplicateObjectError(null), false);
  });
});
