CREATE TABLE IF NOT EXISTS app_data_tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  slug varchar(80) NOT NULL,
  physical_table_name varchar(160) NOT NULL,
  display_name varchar(160) NULL,
  description text NULL,
  primary_key varchar(80) NOT NULL DEFAULT 'id',
  owner_column varchar(80) NULL,
  soft_delete_column varchar(80) NULL,
  status varchar(24) NOT NULL DEFAULT 'ACTIVE',
  settings_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_data_tables_status_check CHECK (status IN ('ACTIVE', 'INACTIVE', 'DELETED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_data_tables_app_slug_unique
  ON app_data_tables(app_id, slug)
  WHERE status <> 'DELETED';

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_data_tables_physical_name_unique
  ON app_data_tables(physical_table_name)
  WHERE status <> 'DELETED';

CREATE INDEX IF NOT EXISTS idx_app_data_tables_app_status_updated
  ON app_data_tables(app_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS app_data_columns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  table_id uuid NOT NULL REFERENCES app_data_tables(id) ON DELETE CASCADE,
  slug varchar(80) NOT NULL,
  physical_column_name varchar(80) NOT NULL,
  data_type varchar(40) NOT NULL,
  is_nullable boolean NOT NULL DEFAULT true,
  default_value_json jsonb NULL,
  is_unique boolean NOT NULL DEFAULT false,
  is_indexed boolean NOT NULL DEFAULT false,
  is_hidden boolean NOT NULL DEFAULT false,
  is_readonly boolean NOT NULL DEFAULT false,
  validation_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  display_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ordinal_position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_data_columns_table_slug_unique
  ON app_data_columns(table_id, slug);

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_data_columns_table_physical_unique
  ON app_data_columns(table_id, physical_column_name);

CREATE INDEX IF NOT EXISTS idx_app_data_columns_app_table_position
  ON app_data_columns(app_id, table_id, ordinal_position ASC, created_at ASC);

CREATE TABLE IF NOT EXISTS app_data_indexes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  table_id uuid NOT NULL REFERENCES app_data_tables(id) ON DELETE CASCADE,
  slug varchar(100) NOT NULL,
  index_type varchar(24) NOT NULL DEFAULT 'btree',
  columns_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  where_json jsonb NULL,
  is_unique boolean NOT NULL DEFAULT false,
  physical_index_name varchar(180) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_data_indexes_table_slug_unique
  ON app_data_indexes(table_id, slug);

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_data_indexes_physical_unique
  ON app_data_indexes(physical_index_name);

CREATE INDEX IF NOT EXISTS idx_app_data_indexes_app_table
  ON app_data_indexes(app_id, table_id, created_at DESC);

CREATE TABLE IF NOT EXISTS app_data_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  table_id uuid NOT NULL REFERENCES app_data_tables(id) ON DELETE CASCADE,
  action varchar(24) NOT NULL,
  effect varchar(16) NOT NULL DEFAULT 'allow',
  roles_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  condition_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  field_mask_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  status varchar(24) NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_data_policies_action_check CHECK (action IN ('read', 'create', 'update', 'delete', 'all')),
  CONSTRAINT app_data_policies_effect_check CHECK (effect IN ('allow', 'deny')),
  CONSTRAINT app_data_policies_status_check CHECK (status IN ('ACTIVE', 'INACTIVE', 'DELETED'))
);

CREATE INDEX IF NOT EXISTS idx_app_data_policies_app_table_status
  ON app_data_policies(app_id, table_id, status, action);

CREATE TABLE IF NOT EXISTS app_schema_migrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  migration_key varchar(120) NOT NULL,
  title varchar(200) NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'PENDING',
  dry_run_sql text NULL,
  applied_sql text NULL,
  rollback_hint text NULL,
  checksum varchar(64) NOT NULL,
  created_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  applied_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz NULL,
  CONSTRAINT app_schema_migrations_status_check CHECK (status IN ('PENDING', 'DRY_RUN', 'APPLIED', 'FAILED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_schema_migrations_app_key_unique
  ON app_schema_migrations(app_id, migration_key);

CREATE INDEX IF NOT EXISTS idx_app_schema_migrations_app_created
  ON app_schema_migrations(app_id, created_at DESC);

CREATE TABLE IF NOT EXISTS app_schema_change_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  actor_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  actor_api_key_id uuid NULL,
  resource_type varchar(60) NOT NULL,
  resource_id uuid NULL,
  action varchar(80) NOT NULL,
  before_json jsonb NULL,
  after_json jsonb NULL,
  sql_hash varchar(64) NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_app_schema_change_events_app_created
  ON app_schema_change_events(app_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_app_schema_change_events_resource
  ON app_schema_change_events(app_id, resource_type, resource_id, created_at DESC);
