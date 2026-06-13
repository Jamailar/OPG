CREATE TABLE IF NOT EXISTS app_acquisition_source_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  key varchar(64) NOT NULL,
  label varchar(120) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  allow_free_text boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_acquisition_source_options_unique_key UNIQUE (app_id, key)
);

CREATE INDEX IF NOT EXISTS idx_app_acquisition_source_options_active
ON app_acquisition_source_options(app_id, is_active, sort_order, created_at);

CREATE TABLE IF NOT EXISTS user_acquisition_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_key varchar(64) NOT NULL,
  source_label_snapshot varchar(120) NOT NULL,
  free_text varchar(240),
  utm_source varchar(120),
  utm_medium varchar(120),
  utm_campaign varchar(180),
  referrer text,
  landing_path varchar(500),
  session_id varchar(128),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_acquisition_sources_unique_user UNIQUE (app_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_acquisition_sources_app_source_time
ON user_acquisition_sources(app_id, source_key, submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_acquisition_sources_app_time
ON user_acquisition_sources(app_id, submitted_at DESC);

CREATE TABLE IF NOT EXISTS user_acquisition_source_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_key varchar(64) NOT NULL,
  source_label_snapshot varchar(120) NOT NULL,
  free_text varchar(240),
  utm_source varchar(120),
  utm_medium varchar(120),
  utm_campaign varchar(180),
  referrer text,
  landing_path varchar(500),
  session_id varchar(128),
  ip_hash varchar(128),
  user_agent varchar(512),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_acquisition_source_events_app_source_time
ON user_acquisition_source_events(app_id, source_key, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_acquisition_source_events_app_user_time
ON user_acquisition_source_events(app_id, user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_acquisition_source_events_app_time
ON user_acquisition_source_events(app_id, created_at DESC);

INSERT INTO app_acquisition_source_options (app_id, key, label, is_active, allow_free_text, sort_order)
SELECT apps.id, defaults.key, defaults.label, true, defaults.allow_free_text, defaults.sort_order
FROM apps
CROSS JOIN (
  VALUES
    ('google_search', 'Google 搜索', false, 10),
    ('xiaohongshu', '小红书', false, 20),
    ('wechat', '微信', false, 30),
    ('friend_referral', '朋友推荐', false, 40),
    ('app_store', '应用商店', false, 50),
    ('paid_ads', '广告', false, 60),
    ('other', '其他', true, 100)
) AS defaults(key, label, allow_free_text, sort_order)
ON CONFLICT (app_id, key) DO NOTHING;
