-- Preserve admin_audit_logs when referenced users are deleted (no CASCADE).
-- Recreate table: SQLite cannot ALTER FOREIGN KEY on an existing table.
CREATE TABLE admin_audit_logs__pr6 (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT,
  action_type TEXT NOT NULL,
  target_user_id TEXT,
  detail_json TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE SET NULL
);

INSERT INTO admin_audit_logs__pr6 (id, actor_user_id, action_type, target_user_id, detail_json, created_at)
SELECT id, actor_user_id, action_type, target_user_id, detail_json, created_at
FROM admin_audit_logs;

DROP TABLE admin_audit_logs;
ALTER TABLE admin_audit_logs__pr6 RENAME TO admin_audit_logs;

CREATE INDEX idx_admin_audit_target_created ON admin_audit_logs(target_user_id, datetime(created_at) DESC);
CREATE INDEX idx_admin_audit_actor_created ON admin_audit_logs(actor_user_id, datetime(created_at) DESC);
