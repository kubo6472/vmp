CREATE TABLE admin_audit_logs (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  target_user_id TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_admin_audit_target_created ON admin_audit_logs(target_user_id, datetime(created_at) DESC);
CREATE INDEX idx_admin_audit_actor_created ON admin_audit_logs(actor_user_id, datetime(created_at) DESC);
CREATE INDEX idx_users_role_created ON users(role, datetime(created_at) DESC);
CREATE INDEX idx_users_email ON users(email);
