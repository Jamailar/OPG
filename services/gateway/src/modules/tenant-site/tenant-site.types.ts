export type TenantSiteMessageType = 'newsletter' | 'contact';
export type TenantSiteMessageStatus = 'new' | 'read' | 'archived';
export type TenantSiteCookieRegion = 'eu' | 'us' | 'other';
export type TenantSiteDownloadPlatform = 'macos' | 'windows';

export type TenantSiteDownloadItem = {
  label?: string;
  version?: string;
  url?: string;
  file_key?: string;
  file_name?: string;
  file_size?: string;
  content_type?: string;
  checksum?: string;
  updated_at?: string;
  minimum_os?: string;
  architecture?: string;
};

export type TenantSiteSettings = {
  support_email?: string;
  login_url?: string;
  app_deep_link?: string;
  downloads?: {
    macos?: TenantSiteDownloadItem;
    windows?: TenantSiteDownloadItem;
  };
  legal?: {
    updated_at?: string;
    privacy_contact?: string;
    terms_contact?: string;
  };
};

export type TenantSiteMessageRow = {
  id: string;
  app_id: string;
  type: TenantSiteMessageType;
  email: string | null;
  name: string | null;
  category: string | null;
  subject: string | null;
  message: string | null;
  locale: string | null;
  source: string | null;
  context_json: unknown;
  status: TenantSiteMessageStatus;
  admin_note: string | null;
  handled_by_user_id: string | null;
  handled_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

export type TenantSiteCookieConsentRow = {
  id: string;
  app_id: string;
  consent_id: string;
  region_mode: TenantSiteCookieRegion;
  essential: boolean;
  analytics: boolean;
  marketing: boolean;
  do_not_sell_share: boolean;
  locale: string | null;
  source: string | null;
  context_json: unknown;
  created_at: Date | string;
  updated_at: Date | string;
};
