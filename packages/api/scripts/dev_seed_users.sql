INSERT OR IGNORE INTO users (id, email, role) VALUES
  ('seed_super_admin', 'owner@example.com', 'super_admin'),
  ('seed_admin', 'admin@example.com', 'admin'),
  ('seed_editor', 'editor@example.com', 'editor'),
  ('seed_viewer', 'viewer@example.com', 'viewer');
