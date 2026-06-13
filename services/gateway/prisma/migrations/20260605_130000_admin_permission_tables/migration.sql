CREATE TABLE IF NOT EXISTS admin_page_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  admin_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  allowed_pages jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_permission_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name varchar(80) NOT NULL,
  description text,
  page_permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE admin_page_permissions ADD COLUMN IF NOT EXISTS app_id uuid;
ALTER TABLE admin_page_permissions ADD COLUMN IF NOT EXISTS admin_user_id uuid;
ALTER TABLE admin_page_permissions ADD COLUMN IF NOT EXISTS allowed_pages jsonb DEFAULT '[]'::jsonb;
ALTER TABLE admin_page_permissions ADD COLUMN IF NOT EXISTS created_by_user_id uuid;
ALTER TABLE admin_page_permissions ADD COLUMN IF NOT EXISTS updated_by_user_id uuid;
ALTER TABLE admin_page_permissions ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE admin_page_permissions ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

ALTER TABLE admin_permission_groups ADD COLUMN IF NOT EXISTS app_id uuid;
ALTER TABLE admin_permission_groups ADD COLUMN IF NOT EXISTS name varchar(80);
ALTER TABLE admin_permission_groups ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE admin_permission_groups ADD COLUMN IF NOT EXISTS page_permissions jsonb DEFAULT '[]'::jsonb;
ALTER TABLE admin_permission_groups ADD COLUMN IF NOT EXISTS created_by_user_id uuid;
ALTER TABLE admin_permission_groups ADD COLUMN IF NOT EXISTS updated_by_user_id uuid;
ALTER TABLE admin_permission_groups ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE admin_permission_groups ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

UPDATE admin_page_permissions p
SET app_id = u.app_id
FROM users u
WHERE p.app_id IS NULL
  AND p.admin_user_id = u.id;

UPDATE admin_permission_groups
SET app_id = (SELECT id FROM apps ORDER BY created_at ASC LIMIT 1)
WHERE app_id IS NULL;

ALTER TABLE admin_page_permissions ALTER COLUMN allowed_pages SET DEFAULT '[]';
ALTER TABLE admin_page_permissions ALTER COLUMN allowed_pages SET NOT NULL;
ALTER TABLE admin_page_permissions ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE admin_page_permissions ALTER COLUMN created_at SET NOT NULL;
ALTER TABLE admin_page_permissions ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE admin_page_permissions ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE admin_page_permissions ALTER COLUMN app_id SET NOT NULL;
ALTER TABLE admin_page_permissions ALTER COLUMN admin_user_id SET NOT NULL;
ALTER TABLE admin_page_permissions ALTER COLUMN created_by_user_id SET NOT NULL;
ALTER TABLE admin_page_permissions ALTER COLUMN updated_by_user_id SET NOT NULL;

ALTER TABLE admin_permission_groups ALTER COLUMN page_permissions SET DEFAULT '[]';
ALTER TABLE admin_permission_groups ALTER COLUMN page_permissions SET NOT NULL;
ALTER TABLE admin_permission_groups ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE admin_permission_groups ALTER COLUMN created_at SET NOT NULL;
ALTER TABLE admin_permission_groups ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE admin_permission_groups ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE admin_permission_groups ALTER COLUMN app_id SET NOT NULL;
ALTER TABLE admin_permission_groups ALTER COLUMN name SET NOT NULL;
ALTER TABLE admin_permission_groups ALTER COLUMN created_by_user_id SET NOT NULL;
ALTER TABLE admin_permission_groups ALTER COLUMN updated_by_user_id SET NOT NULL;

ALTER TABLE admin_page_permissions DROP CONSTRAINT IF EXISTS admin_page_permissions_admin_user_id_key;
DROP INDEX IF EXISTS ix_admin_page_permissions_admin_user_id;
ALTER TABLE admin_permission_groups DROP CONSTRAINT IF EXISTS admin_permission_groups_name_key;
DROP INDEX IF EXISTS ix_admin_permission_groups_name;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_admin_page_permissions_app_id'
  ) THEN
    ALTER TABLE admin_page_permissions
      ADD CONSTRAINT fk_admin_page_permissions_app_id
      FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_admin_page_permissions_admin_user_id'
  ) THEN
    ALTER TABLE admin_page_permissions
      ADD CONSTRAINT fk_admin_page_permissions_admin_user_id
      FOREIGN KEY (admin_user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_admin_page_permissions_created_by_user_id'
  ) THEN
    ALTER TABLE admin_page_permissions
      ADD CONSTRAINT fk_admin_page_permissions_created_by_user_id
      FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_admin_page_permissions_updated_by_user_id'
  ) THEN
    ALTER TABLE admin_page_permissions
      ADD CONSTRAINT fk_admin_page_permissions_updated_by_user_id
      FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE RESTRICT;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_admin_permission_groups_app_id'
  ) THEN
    ALTER TABLE admin_permission_groups
      ADD CONSTRAINT fk_admin_permission_groups_app_id
      FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_admin_permission_groups_created_by_user_id'
  ) THEN
    ALTER TABLE admin_permission_groups
      ADD CONSTRAINT fk_admin_permission_groups_created_by_user_id
      FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_admin_permission_groups_updated_by_user_id'
  ) THEN
    ALTER TABLE admin_permission_groups
      ADD CONSTRAINT fk_admin_permission_groups_updated_by_user_id
      FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_admin_page_permissions_app_admin_user
ON admin_page_permissions(app_id, admin_user_id);

CREATE INDEX IF NOT EXISTS idx_admin_page_permissions_app_id
ON admin_page_permissions(app_id);

CREATE INDEX IF NOT EXISTS idx_admin_page_permissions_created_by_user_id
ON admin_page_permissions(created_by_user_id);

CREATE INDEX IF NOT EXISTS idx_admin_page_permissions_updated_by_user_id
ON admin_page_permissions(updated_by_user_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_admin_permission_groups_app_name
ON admin_permission_groups(app_id, name);

CREATE INDEX IF NOT EXISTS idx_admin_permission_groups_app_id
ON admin_permission_groups(app_id);

CREATE INDEX IF NOT EXISTS idx_admin_permission_groups_created_by_user_id
ON admin_permission_groups(created_by_user_id);

CREATE INDEX IF NOT EXISTS idx_admin_permission_groups_updated_by_user_id
ON admin_permission_groups(updated_by_user_id);
