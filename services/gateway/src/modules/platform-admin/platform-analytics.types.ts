export type AnalyticsTables = {
  orders: boolean;
  agreements: boolean;
  deductions: boolean;
  behavior_events: boolean;
  ai_usage_logs: boolean;
  points_wallets: boolean;
  points_ledger: boolean;
};

export type AnalyticsFactStatus = {
  daily: 'ready' | 'initializing' | 'empty' | 'missing_source';
  cohort: 'ready' | 'initializing' | 'empty' | 'missing_source';
  conversion: 'ready' | 'initializing' | 'empty' | 'missing_source';
  segments: 'ready' | 'initializing' | 'empty' | 'missing_source';
};

export type AnalyticsFactsMeta = {
  refreshed_at: string | null;
  is_stale: boolean;
  refresh_in_progress: boolean;
};

export type AnalyticsFactsReadState = {
  status: AnalyticsFactStatus;
  meta: AnalyticsFactsMeta;
};

export type AnalyticsFactsMaterializedState = {
  counts: { daily: number; cohort: number; conversion: number; segments: number };
  refreshedAt: Date | null;
  status: AnalyticsFactStatus;
};

export type ResolvedAnalyticsQuery = {
  from: Date;
  to: Date;
  days: number;
  timezone: string;
  granularity: 'day' | 'week' | 'month';
  seriesStep: string;
  periodFormat: string;
  page: number;
  pageSize: number;
  segment?: 'unactivated' | 'active_7d' | 'active_30d' | 'inactive_30d';
  createdScope?: 'in_range' | 'out_of_range';
  lastLoginScope?: 'in_range' | 'out_of_range' | 'never';
  membershipType?: string;
  loginMethod?: 'wechat' | 'phone' | 'email';
  source?: string;
  paidStatus?: 'paid' | 'unpaid';
  accountStatus?: 'active' | 'deactivated' | 'all';
  sortBy?: 'created_at' | 'paid_amount_total' | 'points_balance' | 'ai_requests_total' | 'last_login_at';
  sortOrder: 'asc' | 'desc';
};

export type AnalyticsFactRefreshStateRow = {
  job_name: string;
  scope_key: string;
  app_id: string;
  timezone: string;
  from_day: Date | string;
  to_day: Date | string;
  last_refresh_started_at: Date | null;
  last_refresh_completed_at: Date | null;
  last_error: string | null;
};
