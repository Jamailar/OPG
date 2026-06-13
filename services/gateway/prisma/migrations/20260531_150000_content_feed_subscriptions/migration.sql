CREATE TABLE IF NOT EXISTS app_content_feed_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name varchar(160) NOT NULL,
  description text,
  url text NOT NULL,
  url_hash varchar(64) NOT NULL,
  feed_format varchar(24) NOT NULL DEFAULT 'rss',
  content_kind varchar(24) NOT NULL DEFAULT 'mixed',
  language_code varchar(24),
  collection_key varchar(64) NOT NULL DEFAULT 'news',
  category varchar(120),
  tags_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  visibility varchar(24) NOT NULL DEFAULT 'public',
  is_active boolean NOT NULL DEFAULT true,
  refresh_interval_seconds integer NOT NULL DEFAULT 3600,
  max_items_per_fetch integer NOT NULL DEFAULT 50,
  etag text,
  last_modified text,
  last_checked_at timestamptz,
  last_success_at timestamptz,
  next_check_at timestamptz NOT NULL DEFAULT now(),
  failure_count integer NOT NULL DEFAULT 0,
  backoff_until timestamptz,
  outbound_proxy_id uuid REFERENCES outbound_proxies(id) ON DELETE SET NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_content_feed_sources_format_check
    CHECK (feed_format IN ('rss', 'atom', 'json_feed', 'auto')),
  CONSTRAINT app_content_feed_sources_kind_check
    CHECK (content_kind IN ('article', 'audio', 'video', 'mixed')),
  CONSTRAINT app_content_feed_sources_visibility_check
    CHECK (visibility IN ('public', 'authenticated', 'admin_only')),
  CONSTRAINT app_content_feed_sources_refresh_check
    CHECK (refresh_interval_seconds >= 300 AND refresh_interval_seconds <= 604800),
  CONSTRAINT app_content_feed_sources_max_items_check
    CHECK (max_items_per_fetch >= 1 AND max_items_per_fetch <= 200),
  CONSTRAINT app_content_feed_sources_unique_url UNIQUE (app_id, url_hash)
);

CREATE INDEX IF NOT EXISTS idx_app_content_feed_sources_app_kind_language
ON app_content_feed_sources(app_id, content_kind, language_code, is_active, collection_key);

CREATE INDEX IF NOT EXISTS idx_app_content_feed_sources_due
ON app_content_feed_sources(is_active, next_check_at, backoff_until);

CREATE TABLE IF NOT EXISTS app_content_feed_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES app_content_feed_sources(id) ON DELETE CASCADE,
  item_kind varchar(24) NOT NULL DEFAULT 'article',
  language_code varchar(24),
  collection_key varchar(64) NOT NULL DEFAULT 'news',
  guid text,
  guid_hash varchar(64) NOT NULL,
  canonical_url text,
  canonical_url_hash varchar(64),
  title text NOT NULL,
  summary text,
  content_html text,
  external_url text,
  image_url text,
  author text,
  published_at timestamptz,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  duration_seconds integer,
  episode_number integer,
  season_number integer,
  status varchar(24) NOT NULL DEFAULT 'visible',
  raw_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_content_feed_items_kind_check
    CHECK (item_kind IN ('article', 'audio', 'video')),
  CONSTRAINT app_content_feed_items_status_check
    CHECK (status IN ('visible', 'hidden', 'archived')),
  CONSTRAINT app_content_feed_items_unique_guid UNIQUE (source_id, guid_hash)
);

CREATE INDEX IF NOT EXISTS idx_app_content_feed_items_app_kind_language_time
ON app_content_feed_items(app_id, item_kind, language_code, published_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_app_content_feed_items_app_collection_time
ON app_content_feed_items(app_id, collection_key, published_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_app_content_feed_items_source_time
ON app_content_feed_items(source_id, published_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_app_content_feed_items_app_status_time
ON app_content_feed_items(app_id, status, published_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS app_content_feed_enclosures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES app_content_feed_items(id) ON DELETE CASCADE,
  url text NOT NULL,
  url_hash varchar(64) NOT NULL,
  mime_type varchar(160),
  byte_length bigint,
  media_kind varchar(24) NOT NULL DEFAULT 'file',
  duration_seconds integer,
  position integer NOT NULL DEFAULT 0,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_content_feed_enclosures_kind_check
    CHECK (media_kind IN ('audio', 'video', 'image', 'file')),
  CONSTRAINT app_content_feed_enclosures_unique_url UNIQUE (item_id, url_hash)
);

CREATE INDEX IF NOT EXISTS idx_app_content_feed_enclosures_app_kind
ON app_content_feed_enclosures(app_id, media_kind, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_app_content_feed_enclosures_item
ON app_content_feed_enclosures(item_id, position);

CREATE TABLE IF NOT EXISTS app_content_feed_fetch_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES app_content_feed_sources(id) ON DELETE CASCADE,
  status varchar(24) NOT NULL,
  http_status integer,
  duration_ms integer,
  items_seen integer NOT NULL DEFAULT 0,
  items_upserted integer NOT NULL DEFAULT 0,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_content_feed_fetch_runs_status_check
    CHECK (status IN ('success', 'not_modified', 'failed', 'skipped'))
);

CREATE INDEX IF NOT EXISTS idx_app_content_feed_fetch_runs_source_time
ON app_content_feed_fetch_runs(source_id, created_at DESC);

CREATE TABLE IF NOT EXISTS app_content_feed_user_item_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES app_content_feed_items(id) ON DELETE CASCADE,
  playback_position_seconds integer NOT NULL DEFAULT 0,
  completed_at timestamptz,
  last_played_at timestamptz,
  is_saved boolean NOT NULL DEFAULT false,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_content_feed_user_item_states_unique UNIQUE (app_id, user_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_app_content_feed_user_item_states_user_time
ON app_content_feed_user_item_states(app_id, user_id, last_played_at DESC, updated_at DESC);
