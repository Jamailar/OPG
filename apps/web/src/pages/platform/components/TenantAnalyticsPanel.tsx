import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  PlatformTenantAnalyticsOverview,
  PlatformTenantConversionAnalytics,
  PlatformTenantGrowthAnalytics,
  PlatformTenantProfileAnalytics,
  PlatformTenantRetentionAnalytics,
  PlatformTenantUsersAnalytics,
  platformApi,
} from '@/lib/api';
import { pickApiData, pickApiErrorMessage } from '@/lib/api-response';
import TrendMultiLineChart from '@/pages/platform/components/TrendMultiLineChart';

type AnalyticsSubPage = 'overview' | 'growth' | 'retention' | 'profiles' | 'conversion' | 'users';
type RangePreset = 7 | 30 | 90 | 180 | 365 | 'custom';
type Granularity = 'day' | 'week' | 'month';
type UserSortKey = 'created_at' | 'paid_amount_total' | 'points_balance' | 'ai_requests_total' | 'last_login_at';
type SortOrder = 'asc' | 'desc';

type Props = {
  appId: string;
};

const ANALYTICS_SUB_NAV: Array<{ key: AnalyticsSubPage; label: string; desc: string }> = [
  { key: 'overview', label: '总览', desc: '核心 KPI 与数据状态' },
  { key: 'growth', label: '增长', desc: '注册、激活、来源' },
  { key: 'retention', label: '留存', desc: 'cohort、回流、流失' },
  { key: 'profiles', label: '画像', desc: '会员、登录方式、分层' },
  { key: 'conversion', label: '转化', desc: '注册到付费漏斗' },
  { key: 'users', label: '用户明细', desc: '可筛选用户列表' },
];

const RANGE_PRESET_OPTIONS: Array<{ value: RangePreset; label: string }> = [
  { value: 7, label: '7 天' },
  { value: 30, label: '30 天' },
  { value: 90, label: '90 天' },
  { value: 180, label: '180 天' },
  { value: 365, label: '365 天' },
  { value: 'custom', label: '自定义' },
];

const GRANULARITY_OPTIONS: Array<{ value: Granularity; label: string }> = [
  { value: 'day', label: '日' },
  { value: 'week', label: '周' },
  { value: 'month', label: '月' },
];

function resolveAnalyticsSubPage(pathname: string, appId: string): AnalyticsSubPage {
  const marker = `/platform-admin/apps/${appId}/analytics`;
  const idx = pathname.indexOf(marker);
  if (idx === -1) return 'overview';
  const rest = pathname.slice(idx + marker.length).replace(/^\/+/, '');
  const section = rest.split('/')[0];
  if (!section) return 'overview';
  return ANALYTICS_SUB_NAV.find((item) => item.key === section)?.key || 'overview';
}

function formatCount(value?: number | null) {
  return new Intl.NumberFormat('zh-CN').format(Number(value || 0));
}

function formatCurrency(value?: number | null) {
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', maximumFractionDigits: 2 }).format(
    Number(value || 0),
  );
}

function formatPercent(value?: number | null) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

function formatDateTime(value?: string | null) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function buildBarWidth(value: number, max: number) {
  if (max <= 0) return '0%';
  return `${Math.max(4, (value / max) * 100)}%`;
}

function heatmapStyle(rate: number) {
  const alpha = Math.max(0.08, Math.min(0.94, rate));
  return {
    background: `rgba(196, 83, 45, ${alpha})`,
    color: rate > 0.45 ? '#fff' : '#3f2319',
  };
}

function renderEmptyNote(message: string) {
  return <div className="analytics-empty-note">{message}</div>;
}

function buildDeltaMeta(current?: number, previous?: number) {
  const safeCurrent = Number(current || 0);
  const safePrevious = Number(previous || 0);
  const diff = safeCurrent - safePrevious;
  const denominator = Math.max(Math.abs(safePrevious), 1);
  const percent = Math.abs(diff / denominator) * 100;

  if (!safePrevious && !safeCurrent) {
    return { tone: 'flat', text: '较前日 持平' };
  }

  if (Math.abs(diff) < 0.0001) {
    return { tone: 'flat', text: '较前日 持平' };
  }

  return {
    tone: diff > 0 ? 'up' : 'down',
    text: `较前日 ${diff > 0 ? '↑' : '↓'} ${percent.toFixed(1)}%`,
  };
}

function buildSparklineGeometry(values: number[], width = 120, height = 54) {
  if (!values.length) {
    return {
      linePath: '',
      areaPath: '',
      points: [] as Array<{ x: number; y: number }>,
      width,
      height,
    };
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, 1);
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const points = values.map((value, index) => {
    const x = index * step;
    const y = height - ((value - min) / range) * (height - 8) - 4;
    return { x, y };
  });
  const linePath = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
  const areaPath = `${linePath} L ${points[points.length - 1]?.x ?? width} ${height} L ${points[0]?.x ?? 0} ${height} Z`;

  return { linePath, areaPath, points, width, height };
}

function OverviewSparkline({
  values,
  color,
  gradientId,
  dark = false,
}: {
  values: number[];
  color: string;
  gradientId: string;
  dark?: boolean;
}) {
  const { linePath, areaPath, points, width, height } = buildSparklineGeometry(values);
  const lastPoint = points[points.length - 1];

  if (!linePath) return null;

  return (
    <svg
      aria-hidden="true"
      className="tenant-analytics-overview-sparkline"
      fill="none"
      focusable="false"
      viewBox={`0 0 ${width} ${height}`}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={dark ? 0.3 : 0.22} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gradientId})`} />
      <path d={linePath} stroke={color} strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.4" />
      {lastPoint ? <circle cx={lastPoint.x} cy={lastPoint.y} fill={color} r="3.6" /> : null}
    </svg>
  );
}

function OverviewMetricIcon({
  kind,
  className,
}: {
  kind:
    | 'users'
    | 'active'
    | 'revenue'
    | 'arr'
    | 'insight-1'
    | 'insight-2'
    | 'insight-3'
    | 'insight-4'
    | 'conversion-register'
    | 'conversion-activate'
    | 'conversion-engage'
    | 'conversion-pay'
    | 'conversion-repeat'
    | 'conversion-summary'
    | 'conversion-drop'
    | 'conversion-note';
  className?: string;
}) {
  if (kind === 'users') {
    return (
      <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 24 24">
        <path d="M12 12C14.4853 12 16.5 9.98528 16.5 7.5C16.5 5.01472 14.4853 3 12 3C9.51472 3 7.5 5.01472 7.5 7.5C7.5 9.98528 9.51472 12 12 12Z" fill="currentColor" />
        <path d="M4 20.25C4 16.7982 7.13401 14 11 14H13C16.866 14 20 16.7982 20 20.25C20 20.6642 19.6642 21 19.25 21H4.75C4.33579 21 4 20.6642 4 20.25Z" fill="currentColor" />
      </svg>
    );
  }

  if (kind === 'active') {
    return (
      <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 24 24">
        <path d="M7 7.5H17C18.6569 7.5 20 8.84315 20 10.5V15.5C20 17.1569 18.6569 18.5 17 18.5H11L7 21V18.5C5.34315 18.5 4 17.1569 4 15.5V10.5C4 8.84315 5.34315 7.5 7 7.5Z" fill="currentColor" />
        <path d="M9 12H10.5M13.5 12H15M9 15H15" stroke="#fff" strokeLinecap="round" strokeWidth="1.8" />
      </svg>
    );
  }

  if (kind === 'revenue') {
    return (
      <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 24 24">
        <circle cx="12" cy="12" fill="currentColor" r="9" />
        <path d="M9.5 8.5H14.5M12 7V17M14.8 9.5C14.8 8.39543 13.5464 7.5 12 7.5C10.4536 7.5 9.2 8.39543 9.2 9.5C9.2 10.6046 10.4536 11.5 12 11.5C13.5464 11.5 14.8 12.3954 14.8 13.5C14.8 14.6046 13.5464 15.5 12 15.5C10.4536 15.5 9.2 14.6046 9.2 13.5" stroke="#fff" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      </svg>
    );
  }

  if (kind === 'arr') {
    return (
      <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 24 24">
        <rect fill="currentColor" height="18" rx="5" width="18" x="3" y="3" />
        <path d="M8.5 9H15.5M12 8V16M15.2 10C15.2 9.17157 13.7675 8.5 12 8.5C10.2325 8.5 8.8 9.17157 8.8 10C8.8 10.8284 10.2325 11.5 12 11.5C13.7675 11.5 15.2 12.1716 15.2 13C15.2 13.8284 13.7675 14.5 12 14.5C10.2325 14.5 8.8 13.8284 8.8 13" stroke="#fff" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      </svg>
    );
  }

  if (kind === 'insight-1') {
    return (
      <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 24 24">
        <rect fill="currentColor" height="18" rx="5" width="18" x="3" y="3" />
        <path d="M12 7L16 10V15H8V10L12 7Z" stroke="#fff" strokeLinejoin="round" strokeWidth="1.8" />
      </svg>
    );
  }

  if (kind === 'insight-2') {
    return (
      <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 24 24">
        <rect fill="currentColor" height="18" rx="5" width="18" x="3" y="3" />
        <path d="M8 15L11 12L13 14L16 9" stroke="#fff" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      </svg>
    );
  }

  if (kind === 'insight-3') {
    return (
      <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 24 24">
        <rect fill="currentColor" height="18" rx="5" width="18" x="3" y="3" />
        <path d="M8 15C8 12.7909 9.79086 11 12 11C14.2091 11 16 12.7909 16 15" stroke="#fff" strokeLinecap="round" strokeWidth="1.8" />
        <path d="M12 8V13" stroke="#fff" strokeLinecap="round" strokeWidth="1.8" />
      </svg>
    );
  }

  if (kind === 'conversion-register') {
    return (
      <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 24 24">
        <path d="M10.5 12.5C12.9853 12.5 15 10.4853 15 8C15 5.51472 12.9853 3.5 10.5 3.5C8.01472 3.5 6 5.51472 6 8C6 10.4853 8.01472 12.5 10.5 12.5Z" fill="currentColor" />
        <path d="M3.5 19.5C3.5 16.4624 6.18629 14 9.5 14H11.5C14.8137 14 17.5 16.4624 17.5 19.5" fill="currentColor" />
        <path d="M19 8.5V15.5M15.5 12H22.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.9" />
      </svg>
    );
  }

  if (kind === 'conversion-activate') {
    return (
      <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 24 24">
        <path d="M13 2.8L6.7 13.2H11L10.2 21.2L17.3 10.8H13L13 2.8Z" fill="currentColor" />
      </svg>
    );
  }

  if (kind === 'conversion-engage') {
    return (
      <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 24 24">
        <path d="M5 19H19" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
        <path d="M7.5 16V11.5" stroke="currentColor" strokeLinecap="round" strokeWidth="2.2" />
        <path d="M12 16V7.5" stroke="currentColor" strokeLinecap="round" strokeWidth="2.2" />
        <path d="M16.5 16V4.5" stroke="currentColor" strokeLinecap="round" strokeWidth="2.2" />
      </svg>
    );
  }

  if (kind === 'conversion-pay') {
    return (
      <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 24 24">
        <rect x="3.5" y="6.5" width="17" height="11" rx="3" stroke="currentColor" strokeWidth="1.8" />
        <path d="M7.5 11.5H13.5M10.5 9V14" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
        <circle cx="17" cy="12" r="1.2" fill="currentColor" />
      </svg>
    );
  }

  if (kind === 'conversion-repeat') {
    return (
      <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 24 24">
        <path d="M8 7H18V17" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
        <path d="M18 7L6 19" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
        <path d="M6 11V19H14" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      </svg>
    );
  }

  if (kind === 'conversion-summary') {
    return (
      <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 24 24">
        <path d="M6.5 18.5H17.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
        <path d="M8 15V10.5" stroke="currentColor" strokeLinecap="round" strokeWidth="2.1" />
        <path d="M12 15V7.5" stroke="currentColor" strokeLinecap="round" strokeWidth="2.1" />
        <path d="M16 15V5" stroke="currentColor" strokeLinecap="round" strokeWidth="2.1" />
      </svg>
    );
  }

  if (kind === 'conversion-drop') {
    return (
      <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 24 24">
        <path d="M6 7V13H12" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
        <path d="M18 17V11H12" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
        <path d="M6 7L10 11" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
        <path d="M18 17L14 13" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
      </svg>
    );
  }

  if (kind === 'conversion-note') {
    return (
      <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.8" />
        <path d="M12 10V16" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
        <circle cx="12" cy="7.5" r="1.1" fill="currentColor" />
      </svg>
    );
  }

  return (
      <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 24 24">
        <rect fill="currentColor" height="18" rx="5" width="18" x="3" y="3" />
        <path d="M8 15H16M8 12H16M8 9H13" stroke="#fff" strokeLinecap="round" strokeWidth="1.8" />
    </svg>
  );
}

export default function TenantAnalyticsPanel({ appId }: Props) {
  const location = useLocation();
  const navigate = useNavigate();
  const activeSubPage = useMemo(() => resolveAnalyticsSubPage(location.pathname, appId), [location.pathname, appId]);
  const activeSubPageMeta = useMemo(
    () => ANALYTICS_SUB_NAV.find((item) => item.key === activeSubPage),
    [activeSubPage],
  );

  const [rangePreset, setRangePreset] = useState<RangePreset>(7);
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [timezone, setTimezone] = useState('Asia/Shanghai');
  const [granularity, setGranularity] = useState<Granularity>('day');
  const [refreshKey, setRefreshKey] = useState(0);
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState('');

  const [overview, setOverview] = useState<PlatformTenantAnalyticsOverview | null>(null);
  const [growth, setGrowth] = useState<PlatformTenantGrowthAnalytics | null>(null);
  const [retention, setRetention] = useState<PlatformTenantRetentionAnalytics | null>(null);
  const [profiles, setProfiles] = useState<PlatformTenantProfileAnalytics | null>(null);
  const [conversion, setConversion] = useState<PlatformTenantConversionAnalytics | null>(null);
  const [users, setUsers] = useState<PlatformTenantUsersAnalytics | null>(null);
  const [selectedUserId, setSelectedUserId] = useState('');

  const [membershipTypeFilter, setMembershipTypeFilter] = useState('');
  const [loginMethodFilter, setLoginMethodFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [segmentFilter, setSegmentFilter] = useState('');
  const [createdScopeFilter, setCreatedScopeFilter] = useState<'in_range' | 'out_of_range' | ''>('');
  const [lastLoginScopeFilter, setLastLoginScopeFilter] = useState<'in_range' | 'out_of_range' | 'never' | ''>('');
  const [paidStatusFilter, setPaidStatusFilter] = useState('');
  const [accountStatusFilter, setAccountStatusFilter] = useState<'active' | 'deactivated' | 'all'>('active');
  const [usersSortBy, setUsersSortBy] = useState<UserSortKey>('created_at');
  const [usersSortOrder, setUsersSortOrder] = useState<SortOrder>('desc');
  const [usersPage, setUsersPage] = useState(1);

  const rangeParams = useMemo(() => {
    const base = { timezone, granularity };
    if (rangePreset === 'custom' && customFrom && customTo) {
      return { ...base, from: customFrom, to: customTo };
    }
    if (rangePreset === 'custom') {
      return base;
    }
    return { ...base, days: rangePreset };
  }, [customFrom, customTo, granularity, rangePreset, timezone]);

  const selectedUser = useMemo(
    () => users?.items.find((item) => item.id === selectedUserId) || users?.items[0] || null,
    [selectedUserId, users],
  );

  useEffect(() => {
    const exactAnalyticsPath = `/platform-admin/apps/${appId}/analytics`;
    if (location.pathname === exactAnalyticsPath || location.pathname === `${exactAnalyticsPath}/`) {
      navigate(`${exactAnalyticsPath}/overview`, { replace: true });
    }
  }, [appId, location.pathname, navigate]);

  useEffect(() => {
    if (activeSubPage !== 'users') {
      setUsersPage(1);
    }
  }, [activeSubPage]);

  useEffect(() => {
    setUsersPage(1);
  }, [membershipTypeFilter, loginMethodFilter, sourceFilter, segmentFilter, createdScopeFilter, lastLoginScopeFilter, paidStatusFilter, accountStatusFilter, usersSortBy, usersSortOrder, rangePreset, customFrom, customTo, timezone, granularity]);

  const changeUsersSort = (key: UserSortKey) => {
    if (usersSortBy === key) {
      setUsersSortOrder((prev) => (prev === 'desc' ? 'asc' : 'desc'));
      return;
    }
    setUsersSortBy(key);
    setUsersSortOrder('desc');
  };

  const renderSortButton = (key: UserSortKey, label: string) => (
    <button className="table-sort-button" type="button" onClick={() => changeUsersSort(key)}>
      <span>{label}</span>
      {usersSortBy === key ? <span>{usersSortOrder === 'desc' ? '降序' : '升序'}</span> : null}
    </button>
  );

  useEffect(() => {
    if (!users?.items.length) {
      return;
    }
    if (!selectedUserId || !users.items.some((item) => item.id === selectedUserId)) {
      setSelectedUserId(users.items[0].id);
    }
  }, [selectedUserId, users]);

  useEffect(() => {
    if (!appId) return;
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setErrorText('');
      try {
        if (activeSubPage === 'overview') {
          const response = await platformApi.getAppAnalyticsOverview(appId, rangeParams);
          if (!cancelled) setOverview(pickApiData<PlatformTenantAnalyticsOverview>(response) || response);
          return;
        }
        if (activeSubPage === 'growth') {
          const response = await platformApi.getAppAnalyticsGrowth(appId, rangeParams);
          if (!cancelled) setGrowth(pickApiData<PlatformTenantGrowthAnalytics>(response) || response);
          return;
        }
        if (activeSubPage === 'retention') {
          const response = await platformApi.getAppAnalyticsRetention(appId, rangeParams);
          if (!cancelled) setRetention(pickApiData<PlatformTenantRetentionAnalytics>(response) || response);
          return;
        }
        if (activeSubPage === 'profiles') {
          const response = await platformApi.getAppAnalyticsProfiles(appId, rangeParams);
          if (!cancelled) setProfiles(pickApiData<PlatformTenantProfileAnalytics>(response) || response);
          return;
        }
        if (activeSubPage === 'conversion') {
          const response = await platformApi.getAppAnalyticsConversion(appId, rangeParams);
          if (!cancelled) setConversion(pickApiData<PlatformTenantConversionAnalytics>(response) || response);
          return;
        }
        const response = await platformApi.getAppAnalyticsUsers(appId, {
          ...rangeParams,
          segment: segmentFilter || undefined,
          created_scope: createdScopeFilter || undefined,
          last_login_scope: lastLoginScopeFilter || undefined,
          membership_type: membershipTypeFilter || undefined,
          login_method: loginMethodFilter || undefined,
          source: sourceFilter || undefined,
          paid_status: paidStatusFilter || undefined,
          account_status: accountStatusFilter,
          sort_by: usersSortBy,
          sort_order: usersSortOrder,
          page: usersPage,
          page_size: 20,
        });
        if (!cancelled) {
          const payload = pickApiData<PlatformTenantUsersAnalytics>(response) || response;
          setUsers(payload);
        }
      } catch (error: unknown) {
        if (!cancelled) {
          setErrorText(pickApiErrorMessage(error, '加载用户分析失败'));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    load().catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [
    activeSubPage,
    appId,
    createdScopeFilter,
    lastLoginScopeFilter,
    loginMethodFilter,
    membershipTypeFilter,
    paidStatusFilter,
    rangeParams,
    refreshKey,
    segmentFilter,
    sourceFilter,
    accountStatusFilter,
    usersSortBy,
    usersSortOrder,
    usersPage,
  ]);

  const runUserAction = async (action: 'deactivate' | 'restore' | 'unlink-phone' | 'unlink-email', userId: string) => {
    const selected = users?.items.find((item) => item.id === userId);
    if (!selected || loading) return;
    const label = selected.display_name || selected.email || userId;
    const confirmText =
      action === 'deactivate'
        ? `确认注销用户「${label}」吗？`
        : action === 'restore'
          ? `确认恢复用户「${label}」吗？`
          : action === 'unlink-phone'
            ? `确认解绑用户「${label}」的手机号吗？`
            : `确认解绑用户「${label}」的邮箱吗？`;
    if (!window.confirm(confirmText)) return;
    setLoading(true);
    setErrorText('');
    try {
      if (action === 'deactivate') {
        await platformApi.deactivateTenantUser(appId, userId);
      } else if (action === 'restore') {
        await platformApi.restoreTenantUser(appId, userId);
      } else if (action === 'unlink-phone') {
        await platformApi.unlinkTenantUserPhone(appId, userId);
      } else {
        await platformApi.unlinkTenantUserEmail(appId, userId);
      }
      setRefreshKey((prev) => prev + 1);
    } catch (error: unknown) {
      setErrorText(pickApiErrorMessage(error, '操作失败'));
    } finally {
      setLoading(false);
    }
  };

  const renderRangeInfo = () => {
    const range =
      overview?.range || growth?.range || retention?.range || profiles?.range || conversion?.range || users?.range || null;
    if (!range) return '尚未加载';
    return `${range.from.slice(0, 10)} 至 ${range.to.slice(0, 10)} · ${range.timezone} · ${range.granularity}`;
  };

  const renderOverviewPage = () => {
    if (!overview) return null;
    const overviewTrendData = overview.trends.map((item) => ({
      label: item.period,
      users_total: item.users_total,
      registrations: item.registrations,
      active_users: item.active_users,
      revenue: item.revenue,
      paid_users: item.paid_users,
    }));
    const trendValues = {
      users: overview.trends.map((item) => item.users_total),
      active: overview.trends.map((item) => item.active_users),
      revenue: overview.trends.map((item) => item.revenue),
      paid: overview.trends.map((item) => item.paid_users),
      registrations: overview.trends.map((item) => item.registrations),
    };
    const latestTrend = overview.trends[overview.trends.length - 1];
    const previousTrend = overview.trends[Math.max(overview.trends.length - 2, 0)];
    const topMetricCards = [
      {
        key: 'users',
        label: '累计用户',
        value: formatCount(overview.summary.users_total),
        note: '有效用户基数',
        delta: buildDeltaMeta(latestTrend?.users_total, previousTrend?.users_total),
        color: '#5B6CFF',
        softColor: '#EEF1FF',
        icon: 'users' as const,
        values: trendValues.users,
        dark: false,
      },
      {
        key: 'active',
        label: '窗口活跃用户',
        value: formatCount(overview.summary.active_users_in_range),
        note: '当前统计窗口内去重活跃',
        delta: buildDeltaMeta(latestTrend?.active_users, previousTrend?.active_users),
        color: '#58C84D',
        softColor: '#EBFAEC',
        icon: 'active' as const,
        values: trendValues.active,
        dark: false,
      },
      {
        key: 'revenue',
        label: '窗口收入',
        value: formatCurrency(overview.summary.paid_amount_in_range),
        note: '当前窗口已支付收入',
        delta: buildDeltaMeta(latestTrend?.revenue, previousTrend?.revenue),
        color: '#FF9B17',
        softColor: '#FFF3E1',
        icon: 'revenue' as const,
        values: trendValues.revenue,
        dark: false,
      },
      {
        key: 'arr',
        label: 'ARR',
        value: formatCurrency(overview.summary.arr_estimate),
        note: '近 7 天收入年化估算',
        delta: buildDeltaMeta(latestTrend?.revenue, previousTrend?.revenue),
        color: '#A35BFF',
        softColor: '#F1E7FF',
        icon: 'arr' as const,
        values: trendValues.revenue,
        dark: true,
      },
    ];
    const coreMetricItems = [
      {
        key: 'dau',
        label: 'DAU',
        value: formatCount(overview.summary.dau_latest),
        note: '最近 1 天去重活跃',
        color: '#4F9CF7',
        softColor: '#EAF4FF',
        values: trendValues.active,
      },
      {
        key: 'wau',
        label: 'WAU',
        value: formatCount(overview.summary.wau_latest),
        note: '最近 7 天去重活跃',
        color: '#49C96E',
        softColor: '#EAF9EF',
        values: trendValues.users,
      },
      {
        key: 'mau',
        label: 'MAU',
        value: formatCount(overview.summary.mau_latest),
        note: '最近 30 天去重活跃',
        color: '#A35BFF',
        softColor: '#F1E7FF',
        values: trendValues.users,
      },
      {
        key: 'pay-rate',
        label: '付费渗透率',
        value: formatPercent(overview.summary.pay_rate),
        note: `激活率 ${formatPercent(overview.summary.activation_rate)}`,
        color: '#FF9B17',
        softColor: '#FFF3E1',
        values: trendValues.revenue,
      },
      {
        key: 'paid-users',
        label: '累计付费用户',
        value: formatCount(overview.summary.paid_users_total),
        note: `充值用户 ${formatCount(overview.summary.recharge_users_total)}`,
        color: '#4F9CF7',
        softColor: '#EAF4FF',
        values: trendValues.paid,
      },
      {
        key: 'arr',
        label: 'ARR',
        value: formatCurrency(overview.summary.arr_estimate),
        note: `近 7 天收入 ${formatCurrency(overview.summary.paid_amount_7d)}`,
        color: '#A35BFF',
        softColor: '#F1E7FF',
        values: trendValues.revenue,
      },
    ];
    const tableReadyRatio =
      Object.values(overview.tables).filter(Boolean).length / Math.max(Object.keys(overview.tables).length, 1);
    const insightItems = [
      {
        key: 'active-users',
        label: '活跃用户数',
        value: formatCount(overview.summary.active_users_in_range),
        note: buildDeltaMeta(latestTrend?.active_users, previousTrend?.active_users).text,
        icon: 'insight-1' as const,
        color: '#4F9CF7',
        softColor: '#EAF4FF',
      },
      {
        key: 'user-growth',
        label: '用户增长趋势',
        value: buildDeltaMeta(latestTrend?.users_total, previousTrend?.users_total).tone === 'down' ? '波动' : '稳定上升',
        note: buildDeltaMeta(latestTrend?.users_total, previousTrend?.users_total).text,
        icon: 'insight-2' as const,
        color: '#63C37D',
        softColor: '#ECFAF0',
      },
      {
        key: 'revenue-growth',
        label: '收入趋势',
        value: buildDeltaMeta(latestTrend?.revenue, previousTrend?.revenue).tone === 'down' ? '回落' : '上升',
        note: buildDeltaMeta(latestTrend?.revenue, previousTrend?.revenue).text,
        icon: 'insight-3' as const,
        color: '#FF9B17',
        softColor: '#FFF3E1',
      },
      {
        key: 'data-ready',
        label: '数据就绪率',
        value: `${Math.round(tableReadyRatio * 100)}%`,
        note: `${Object.values(overview.tables).filter(Boolean).length}/${Object.keys(overview.tables).length} 张表可用`,
        icon: 'insight-4' as const,
        color: '#A35BFF',
        softColor: '#F1E7FF',
      },
    ];
    return (
      <div className="tenant-analytics-page tenant-analytics-overview-page">
        <section className="tenant-analytics-overview-metrics">
          <div className="tenant-analytics-overview-primary-grid">
            {topMetricCards.map((item) => (
              <article
                key={item.key}
                className={`tenant-analytics-overview-kpi-card ${item.dark ? 'dark' : ''}`}
                style={{
                  ['--overview-accent' as string]: item.color,
                  ['--overview-accent-soft' as string]: item.softColor,
                }}
              >
                <div className="tenant-analytics-overview-kpi-head">
                  <div className="tenant-analytics-overview-kpi-icon">
                    <OverviewMetricIcon kind={item.icon} />
                  </div>
                  <div className="tenant-analytics-overview-kpi-copy">
                    <span>{item.label}</span>
                    <strong>{item.value}</strong>
                  </div>
                </div>
                <div className="tenant-analytics-overview-kpi-meta">
                  <small>{item.note}</small>
                  <p className={`tenant-analytics-overview-kpi-delta ${item.delta.tone}`}>{item.delta.text}</p>
                </div>
                <div className="tenant-analytics-overview-kpi-chart">
                  <OverviewSparkline
                    color={item.color}
                    dark={item.dark}
                    gradientId={`overview-kpi-${item.key}`}
                    values={item.values}
                  />
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="tenant-analytics-overview-bottom-grid">
          <section className="card tenant-analytics-panel tenant-analytics-overview-core-panel">
            <div className="platform-section-head">
              <h3>核心指标</h3>
            </div>
            <div className="tenant-analytics-overview-secondary-grid">
              {coreMetricItems.map((item) => (
                <article
                  key={item.key}
                  className="tenant-analytics-overview-core-metric"
                  style={{
                    ['--metric-accent' as string]: item.color,
                    ['--metric-accent-soft' as string]: item.softColor,
                  }}
                >
                  <span>{item.label}</span>
                  <strong>{item.value}</strong>
                  <small>{item.note}</small>
                  <OverviewSparkline color={item.color} gradientId={`overview-core-${item.key}`} values={item.values} />
                </article>
              ))}
            </div>
          </section>
        </section>

        <section className="tenant-analytics-overview-main-grid">
          <section className="card tenant-analytics-panel tenant-analytics-overview-chart-panel">
            <div className="platform-section-head">
              <h3>用户分析趋势</h3>
            </div>
            <TrendMultiLineChart
              className="tenant-analytics-overview-chart-core"
              data={overviewTrendData}
              series={[
                { key: 'users_total', label: '累计用户', color: '#4F7CF7', strokeWidth: 3.2, yAxisId: 'users-total', axis: 'left' },
                { key: 'active_users', label: '活跃用户', color: '#45C26B', yAxisId: 'growth-metrics', axis: 'right' },
                { key: 'registrations', label: '新增用户', color: '#8B5CFF', yAxisId: 'growth-metrics', axis: 'right' },
              ]}
              emptyText="当前窗口暂无用户增长趋势数据"
              tooltipExtras={(datum) => [
                { label: '收入', value: formatCurrency(Number(datum.revenue || 0)) },
                { label: '付费用户', value: formatCount(Number(datum.paid_users || 0)) },
              ]}
            />
          </section>

          <section className="card tenant-analytics-panel tenant-analytics-overview-insights-panel">
            <div className="platform-section-head">
              <h3>数据洞察</h3>
              <span className="tenant-analytics-overview-panel-link">查看全部</span>
            </div>
            <div className="tenant-analytics-overview-insight-list">
              {insightItems.map((item) => (
                <article
                  key={item.key}
                  className="tenant-analytics-overview-insight-row"
                  style={{
                    ['--insight-accent' as string]: item.color,
                    ['--insight-accent-soft' as string]: item.softColor,
                  }}
                >
                  <div className="tenant-analytics-overview-insight-row-icon">
                    <OverviewMetricIcon kind={item.icon} />
                  </div>
                  <div className="tenant-analytics-overview-insight-row-main">
                    <span>{item.label}</span>
                    <strong>{item.value}</strong>
                  </div>
                  <small>{item.note}</small>
                </article>
              ))}
            </div>
          </section>
        </section>
      </div>
    );
  };

  const renderGrowthPage = () => {
    if (!growth) return null;
    const growthTrendData = growth.registrations_trend.map((item) => ({
      label: item.period,
      users_total: item.users_total,
      registrations: item.registrations,
      activated_users: item.activated_users,
      active_users: item.active_users,
    }));
    const sourceMax = Math.max(...growth.source_distribution.map((item) => item.users_count), 0);
    const methodMax = Math.max(...growth.login_method_distribution.map((item) => item.users_count), 0);
    return (
      <div className="tenant-analytics-page">
        <section className="card tenant-analytics-card-grid">
          <article className="tenant-analytics-metric-card">
            <span>今日注册</span>
            <strong>{formatCount(growth.summary.registered_today)}</strong>
            <small>近 7 天 {formatCount(growth.summary.registered_7d)}</small>
          </article>
          <article className="tenant-analytics-metric-card">
            <span>窗口注册</span>
            <strong>{formatCount(growth.summary.registered_in_range)}</strong>
            <small>30 天 {formatCount(growth.summary.registered_30d)}</small>
          </article>
          <article className="tenant-analytics-metric-card">
            <span>激活人数</span>
            <strong>{formatCount(growth.summary.activated_in_range)}</strong>
            <small>激活率 {formatPercent(growth.summary.activation_rate)}</small>
          </article>
          <article className="tenant-analytics-metric-card">
            <span>首次登录</span>
            <strong>{formatCount(growth.summary.first_login_in_range)}</strong>
            <small>窗口内完成首登</small>
          </article>
          <article className="tenant-analytics-metric-card">
            <span>日活 DAU</span>
            <strong>{formatCount(growth.summary.dau_latest)}</strong>
            <small>最近 1 天去重活跃</small>
          </article>
          <article className="tenant-analytics-metric-card">
            <span>周活 WAU</span>
            <strong>{formatCount(growth.summary.wau_latest)}</strong>
            <small>最近 7 天去重活跃</small>
          </article>
          <article className="tenant-analytics-metric-card">
            <span>月活 MAU</span>
            <strong>{formatCount(growth.summary.mau_latest)}</strong>
            <small>最近 30 天去重活跃</small>
          </article>
        </section>

        <section className="card tenant-analytics-panel">
          <div className="platform-section-head">
            <h3>注册与激活趋势</h3>
          </div>
          <TrendMultiLineChart
            data={growthTrendData}
            series={[
              { key: 'users_total', label: '用户总数', color: '#2563EB', strokeWidth: 4 },
              { key: 'registrations', label: '新增用户', color: '#C65C34' },
              { key: 'activated_users', label: '激活用户', color: '#A16207' },
              { key: 'active_users', label: '活跃用户', color: '#4F665D' },
            ]}
            emptyText="当前窗口暂无注册与激活趋势数据"
          />
        </section>

        <section className="tenant-analytics-two-col">
          <section className="card tenant-analytics-panel">
            <div className="platform-section-head">
              <h3>登录方式</h3>
            </div>
            <div className="tenant-analytics-list-bars">
              {growth.login_method_distribution.length > 0 ? growth.login_method_distribution.map((item) => (
                <article key={item.login_method} className="tenant-analytics-list-item">
                  <div className="tenant-analytics-list-head">
                    <span>{item.login_method}</span>
                    <strong>{formatCount(item.users_count)}</strong>
                  </div>
                  <div className="tenant-analytics-list-bar">
                    <div style={{ width: buildBarWidth(item.users_count, methodMax) }} />
                  </div>
                </article>
              )) : renderEmptyNote('当前暂无登录方式统计')}
            </div>
          </section>
          <section className="card tenant-analytics-panel">
            <div className="platform-section-head">
              <h3>注册来源</h3>
            </div>
            <div className="tenant-analytics-list-bars">
              {growth.source_distribution.length > 0 ? growth.source_distribution.map((item) => (
                <article key={item.source} className="tenant-analytics-list-item">
                  <div className="tenant-analytics-list-head">
                    <span>{item.source}</span>
                    <strong>{formatCount(item.users_count)}</strong>
                  </div>
                  <div className="tenant-analytics-list-bar">
                    <div style={{ width: buildBarWidth(item.users_count, sourceMax) }} />
                  </div>
                </article>
              )) : renderEmptyNote('当前暂无注册来源统计')}
            </div>
          </section>
        </section>
      </div>
    );
  };

  const renderRetentionPage = () => {
    if (!retention) return null;
    const lifecycleMax = Math.max(...retention.lifecycle_distribution.map((item) => item.users_count), 0);
    return (
      <div className="tenant-analytics-page">
        <section className="card tenant-analytics-card-grid">
          <article className="tenant-analytics-metric-card">
            <span>D1 留存</span>
            <strong>{formatPercent(retention.summary.d1_retention)}</strong>
            <small>D7 {formatPercent(retention.summary.d7_retention)}</small>
          </article>
          <article className="tenant-analytics-metric-card">
            <span>D14 留存</span>
            <strong>{formatPercent(retention.summary.d14_retention)}</strong>
            <small>D30 {formatPercent(retention.summary.d30_retention)}</small>
          </article>
          <article className="tenant-analytics-metric-card">
            <span>回流用户</span>
            <strong>{formatCount(retention.summary.reactivated_users)}</strong>
            <small>沉睡 {formatCount(retention.summary.dormant_users)}</small>
          </article>
          <article className="tenant-analytics-metric-card">
            <span>流失用户</span>
            <strong>{formatCount(retention.summary.churned_users)}</strong>
            <small>窗口内历史留存 cohort</small>
          </article>
        </section>

        <section className="card tenant-analytics-panel">
          <div className="platform-section-head">
            <h3>Cohort 热力图</h3>
          </div>
          <div className="platform-api-table-wrap">
            <table className="table tenant-analytics-heatmap">
              <thead>
                <tr>
                  <th>注册批次</th>
                  <th>样本</th>
                  <th>D1</th>
                  <th>D3</th>
                  <th>D7</th>
                  <th>D14</th>
                  <th>D30</th>
                </tr>
              </thead>
              <tbody>
                {retention.cohorts.length > 0 ? retention.cohorts.map((item) => (
                  <tr key={item.cohort_period}>
                    <td>{item.cohort_period}</td>
                    <td>{formatCount(item.cohort_size)}</td>
                    <td style={heatmapStyle(item.d1)}>{formatPercent(item.d1)}</td>
                    <td style={heatmapStyle(item.d3)}>{formatPercent(item.d3)}</td>
                    <td style={heatmapStyle(item.d7)}>{formatPercent(item.d7)}</td>
                    <td style={heatmapStyle(item.d14)}>{formatPercent(item.d14)}</td>
                    <td style={heatmapStyle(item.d30)}>{formatPercent(item.d30)}</td>
                  </tr>
                )) : (
                  <tr>
                    <td colSpan={7}>{renderEmptyNote('当前窗口暂无 cohort 留存数据')}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="tenant-analytics-two-col">
          <section className="card tenant-analytics-panel">
            <div className="platform-section-head">
              <h3>生命周期分层</h3>
            </div>
            <div className="tenant-analytics-list-bars">
              {retention.lifecycle_distribution.length > 0 ? retention.lifecycle_distribution.map((item) => (
                <article key={item.segment} className="tenant-analytics-list-item">
                  <div className="tenant-analytics-list-head">
                    <span>{item.segment}</span>
                    <strong>{formatCount(item.users_count)}</strong>
                  </div>
                  <div className="tenant-analytics-list-bar">
                    <div style={{ width: buildBarWidth(item.users_count, lifecycleMax) }} />
                  </div>
                </article>
              )) : renderEmptyNote('当前暂无生命周期分层数据')}
            </div>
          </section>
          <section className="card tenant-analytics-panel">
            <div className="platform-section-head">
              <h3>回流趋势</h3>
            </div>
            <TrendMultiLineChart
              data={retention.reactivation_trend.map((item) => ({
                label: item.period,
                users_total: item.users_total,
                reactivated_users: item.reactivated_users,
              }))}
              series={[
                { key: 'users_total', label: '用户总数', color: '#2563EB', strokeWidth: 4 },
                { key: 'reactivated_users', label: '回流用户', color: '#A16207' },
              ]}
              emptyText="当前窗口暂无回流趋势"
            />
          </section>
        </section>
      </div>
    );
  };

  const renderProfilesPage = () => {
    if (!profiles) return null;
    const membershipMax = Math.max(...profiles.membership_distribution.map((item) => item.users_count), 0);
    const loginMethodMax = Math.max(...profiles.login_method_distribution.map((item) => item.users_count), 0);
    const sourceMax = Math.max(...profiles.source_distribution.map((item) => item.users_count), 0);
    const activityMax = Math.max(...profiles.activity_segments.map((item) => item.users_count), 0);
    const paymentMax = Math.max(...profiles.payment_segments.map((item) => item.users_count), 0);
    return (
      <div className="tenant-analytics-page">
        <section className="tenant-analytics-two-col">
          <section className="card tenant-analytics-panel">
            <div className="platform-section-head">
              <h3>会员结构</h3>
            </div>
            <div className="tenant-analytics-list-bars">
              {profiles.membership_distribution.length > 0 ? profiles.membership_distribution.map((item) => (
                <article key={item.membership_type} className="tenant-analytics-list-item">
                  <div className="tenant-analytics-list-head">
                    <span>{item.membership_type}</span>
                    <strong>{formatCount(item.users_count)}</strong>
                  </div>
                  <div className="tenant-analytics-list-bar">
                    <div style={{ width: buildBarWidth(item.users_count, membershipMax) }} />
                  </div>
                </article>
              )) : renderEmptyNote('当前暂无会员结构数据')}
            </div>
          </section>
          <section className="card tenant-analytics-panel">
            <div className="platform-section-head">
              <h3>登录方式</h3>
            </div>
            <div className="tenant-analytics-list-bars">
              {profiles.login_method_distribution.length > 0 ? profiles.login_method_distribution.map((item) => (
                <article key={item.login_method} className="tenant-analytics-list-item">
                  <div className="tenant-analytics-list-head">
                    <span>{item.login_method}</span>
                    <strong>{formatCount(item.users_count)}</strong>
                  </div>
                  <div className="tenant-analytics-list-bar">
                    <div style={{ width: buildBarWidth(item.users_count, loginMethodMax) }} />
                  </div>
                </article>
              )) : renderEmptyNote('当前暂无登录方式分布')}
            </div>
          </section>
        </section>

        <section className="tenant-analytics-two-col">
          <section className="card tenant-analytics-panel">
            <div className="platform-section-head">
              <h3>来源分布</h3>
            </div>
            <div className="tenant-analytics-list-bars">
              {profiles.source_distribution.length > 0 ? profiles.source_distribution.map((item) => (
                <article key={item.source} className="tenant-analytics-list-item">
                  <div className="tenant-analytics-list-head">
                    <span>{item.source}</span>
                    <strong>{formatCount(item.users_count)}</strong>
                  </div>
                  <div className="tenant-analytics-list-bar">
                    <div style={{ width: buildBarWidth(item.users_count, sourceMax) }} />
                  </div>
                </article>
              )) : renderEmptyNote('当前暂无来源分布')}
            </div>
          </section>
          <section className="card tenant-analytics-panel">
            <div className="platform-section-head">
              <h3>活跃分层</h3>
            </div>
            <div className="tenant-analytics-list-bars">
              {profiles.activity_segments.length > 0 ? profiles.activity_segments.map((item) => (
                <article key={item.segment} className="tenant-analytics-list-item">
                  <div className="tenant-analytics-list-head">
                    <span>{item.segment}</span>
                    <strong>{formatCount(item.users_count)}</strong>
                  </div>
                  <div className="tenant-analytics-list-bar">
                    <div style={{ width: buildBarWidth(item.users_count, activityMax) }} />
                  </div>
                </article>
              )) : renderEmptyNote('当前暂无活跃分层')}
            </div>
          </section>
        </section>

        <section className="tenant-analytics-two-col">
          <section className="card tenant-analytics-panel">
            <div className="platform-section-head">
              <h3>付费分层</h3>
            </div>
            <div className="tenant-analytics-list-bars">
              {profiles.payment_segments.length > 0 ? profiles.payment_segments.map((item) => (
                <article key={item.segment} className="tenant-analytics-list-item">
                  <div className="tenant-analytics-list-head">
                    <span>{item.segment}</span>
                    <strong>{formatCount(item.users_count)}</strong>
                  </div>
                  <div className="tenant-analytics-list-bar">
                    <div style={{ width: buildBarWidth(item.users_count, paymentMax) }} />
                  </div>
                </article>
              )) : renderEmptyNote('当前暂无付费分层')}
            </div>
          </section>
        </section>

        <section className="card tenant-analytics-panel">
          <div className="platform-section-head">
            <h3>当前数据缺口</h3>
          </div>
          <div className="tenant-analytics-gap-grid">
            {profiles.data_gaps.map((item) => (
              <article key={item.key} className="tenant-analytics-gap-card">
                <span>{item.label}</span>
                <strong>{item.ready ? '已采集' : '待补齐'}</strong>
                <p>{item.note}</p>
              </article>
            ))}
          </div>
        </section>
      </div>
    );
  };

  const renderConversionPage = () => {
    if (!conversion) return null;
    const funnelBaseUsers = conversion.funnel[0]?.users || 0;
    const paidStep =
      conversion.funnel.find((step) => /付费/.test(step.label) || /paid/i.test(step.key)) ||
      conversion.funnel[conversion.funnel.length - 2] ||
      null;
    const repeatStep =
      conversion.funnel.find((step) => /复购/.test(step.label) || /repeat/i.test(step.key)) ||
      conversion.funnel[conversion.funnel.length - 1] ||
      null;
    const biggestDrop = conversion.funnel.slice(1).reduce<{
      currentLabel: string;
      previousLabel: string;
      dropRate: number;
      lostUsers: number;
    } | null>((best, step, index) => {
      const previous = conversion.funnel[index];
      const dropRate = Math.max(0, 1 - Number(step.conversion_from_previous || 0));
      const lostUsers = Math.max(0, Number(previous?.users || 0) - Number(step.users || 0));
      if (!best || dropRate > best.dropRate) {
        return {
          currentLabel: step.label,
          previousLabel: previous?.label || '上一步',
          dropRate,
          lostUsers,
        };
      }
      return best;
    }, null);
    const totalRevenue = conversion.payment_trend.reduce((sum, item) => sum + Number(item.revenue || 0), 0);
    const peakPaidUsers = conversion.payment_trend.reduce((max, item) => Math.max(max, Number(item.paid_users || 0)), 0);
    const peakRepeatBuyers = conversion.payment_trend.reduce((max, item) => Math.max(max, Number(item.repeat_buyers || 0)), 0);
    const repeatShareOfPaid = paidStep && Number(paidStep.users || 0) > 0
      ? Number(repeatStep?.users || 0) / Number(paidStep.users || 0)
      : 0;
    const conversionPalette = [
      {
        accent: '#3B82F6',
        soft: '#EFF6FF',
        border: '#93C5FD',
        icon: 'conversion-register' as const,
      },
      {
        accent: '#4BBF64',
        soft: '#F0FDF4',
        border: '#86EFAC',
        icon: 'conversion-activate' as const,
      },
      {
        accent: '#F08A24',
        soft: '#FFF7ED',
        border: '#FDBA74',
        icon: 'conversion-engage' as const,
      },
      {
        accent: '#8B5CF6',
        soft: '#F5F3FF',
        border: '#C4B5FD',
        icon: 'conversion-pay' as const,
      },
      {
        accent: '#F97362',
        soft: '#FFF1F2',
        border: '#FDA4AF',
        icon: 'conversion-repeat' as const,
      },
    ];

    return (
      <div className="tenant-analytics-page">
        <section className="card tenant-analytics-panel tenant-analytics-conversion-shell">
          <div className="platform-section-head">
            <h3>漏斗</h3>
          </div>
          <div className="tenant-analytics-conversion-layout">
            <div className="tenant-analytics-conversion-funnel">
              {conversion.funnel.length > 0 ? conversion.funnel.map((step, index) => {
                const palette = conversionPalette[index] || conversionPalette[conversionPalette.length - 1];
                const widthFloor = [100, 94, 88, 58, 52][index] ?? 52;
                const widthPercent =
                  funnelBaseUsers > 0
                    ? Math.max(widthFloor, Math.round((step.users / funnelBaseUsers) * 100) - index * 6)
                    : widthFloor;
                const nextStep = conversion.funnel[index + 1];
                const nextDropRate =
                  nextStep && Number(step.users || 0) > 0
                    ? Math.max(0, 1 - Number(nextStep.conversion_from_previous || 0))
                    : 0;
                return (
                  <div key={step.key} className="tenant-analytics-conversion-step-wrap" style={{ width: `${widthPercent}%` }}>
                    <article
                      className={`tenant-analytics-conversion-step ${index === 0 ? 'is-anchor' : ''}`}
                      style={{
                        ['--conversion-accent' as string]: palette.accent,
                        ['--conversion-accent-soft' as string]: palette.soft,
                        ['--conversion-accent-border' as string]: palette.border,
                      }}
                    >
                      <div className="tenant-analytics-conversion-step-surface">
                        <div className="tenant-analytics-conversion-step-icon">
                          <OverviewMetricIcon kind={palette.icon} />
                        </div>
                        <div className="tenant-analytics-conversion-step-body">
                          <div className="tenant-analytics-conversion-step-head">
                            <div className="tenant-analytics-conversion-step-title">
                              <span>{`步骤 ${index + 1}`}</span>
                              <strong>{step.label}</strong>
                            </div>
                            <div className="tenant-analytics-conversion-step-value">{formatCount(step.users)}</div>
                          </div>
                          <div className="tenant-analytics-conversion-step-meta">
                            <small>从起点 {formatPercent(step.conversion_from_start)}</small>
                            <small>{index === 0 ? '起点基准 100%' : `环比上一步 ${formatPercent(step.conversion_from_previous)}`}</small>
                          </div>
                        </div>
                      </div>
                    </article>
                    {index < conversion.funnel.length - 1 ? (
                      <div className="tenant-analytics-conversion-connector">
                        <div className="tenant-analytics-conversion-connector-arrow">↓</div>
                        <div className="tenant-analytics-conversion-connector-chip">
                          {`流失 ${formatCount(Math.max(0, Number(step.users || 0) - Number(nextStep?.users || 0)))} (${formatPercent(nextDropRate)})`}
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              }) : renderEmptyNote('当前窗口暂无转化漏斗数据')}
            </div>

            <aside className="tenant-analytics-conversion-insights">
              <article className="tenant-analytics-conversion-summary-card">
                <div className="platform-section-head">
                  <h4>漏斗概览</h4>
                </div>
                <div className="tenant-analytics-conversion-summary-list">
                  <div className="tenant-analytics-conversion-summary-item">
                    <div className="tenant-analytics-conversion-summary-item-icon summary">
                      <OverviewMetricIcon kind="conversion-summary" />
                    </div>
                    <div className="tenant-analytics-conversion-summary-item-main">
                      <span>整体转化率</span>
                      <small>注册 → 首次付费</small>
                    </div>
                    <strong>{paidStep ? formatPercent(paidStep.conversion_from_start) : '--'}</strong>
                  </div>
                  <div className="tenant-analytics-conversion-summary-item">
                    <div className="tenant-analytics-conversion-summary-item-icon paid">
                      <OverviewMetricIcon kind="conversion-pay" />
                    </div>
                    <div className="tenant-analytics-conversion-summary-item-main">
                      <span>付费转化率</span>
                      <small>活跃 → 首次付费</small>
                    </div>
                    <strong>{paidStep ? formatPercent(paidStep.conversion_from_previous) : '--'}</strong>
                  </div>
                  <div className="tenant-analytics-conversion-summary-item">
                    <div className="tenant-analytics-conversion-summary-item-icon repeat">
                      <OverviewMetricIcon kind="conversion-repeat" />
                    </div>
                    <div className="tenant-analytics-conversion-summary-item-main">
                      <span>复购用户占比</span>
                      <small>付费用户中复购</small>
                    </div>
                    <strong>{paidStep ? formatPercent(repeatShareOfPaid) : '--'}</strong>
                  </div>
                  <div className="tenant-analytics-conversion-summary-item">
                    <div className="tenant-analytics-conversion-summary-item-icon revenue">
                      <OverviewMetricIcon kind="revenue" />
                    </div>
                    <div className="tenant-analytics-conversion-summary-item-main">
                      <span>窗口收入</span>
                      <small>当前筛选窗口</small>
                    </div>
                    <strong>{formatCurrency(totalRevenue)}</strong>
                  </div>
                </div>
              </article>

              <article className="tenant-analytics-conversion-highlight">
                <div className="tenant-analytics-conversion-summary-item-icon drop">
                  <OverviewMetricIcon kind="conversion-drop" />
                </div>
                <div className="tenant-analytics-conversion-highlight-copy">
                  <span>最大流失点</span>
                  <p>{biggestDrop ? `${biggestDrop.previousLabel} → ${biggestDrop.currentLabel}` : '暂无可比较步骤'}</p>
                  <small>{biggestDrop ? `流失 ${formatCount(biggestDrop.lostUsers)} 用户` : '等待更多样本'}</small>
                </div>
                <strong>{biggestDrop ? formatPercent(biggestDrop.dropRate) : '--'}</strong>
              </article>

              <article className="tenant-analytics-conversion-note-card">
                <div className="platform-section-head">
                  <h4>数据说明</h4>
                </div>
                <div className="tenant-analytics-conversion-note-row">
                  <div className="tenant-analytics-conversion-summary-item-icon note">
                    <OverviewMetricIcon kind="conversion-note" />
                  </div>
                  <p>转化率基于当前统计窗口内的用户行为计算，环比展示相对上一步的保留率。</p>
                </div>
                <div className="tenant-analytics-conversion-note-row plain">
                  <p>{`峰值付费 ${formatCount(peakPaidUsers)} · 峰值复购 ${formatCount(peakRepeatBuyers)}`}</p>
                </div>
              </article>
            </aside>
          </div>
        </section>

        <section className="card tenant-analytics-panel">
          <div className="platform-section-head">
            <h3>付费与复购趋势</h3>
          </div>
          <div className="tenant-analytics-conversion-trend-summary">
            <div className="tenant-analytics-conversion-trend-pill">
              <span>窗口收入</span>
              <strong>{formatCurrency(totalRevenue)}</strong>
            </div>
            <div className="tenant-analytics-conversion-trend-pill">
              <span>峰值付费</span>
              <strong>{formatCount(peakPaidUsers)}</strong>
            </div>
            <div className="tenant-analytics-conversion-trend-pill">
              <span>峰值复购</span>
              <strong>{formatCount(peakRepeatBuyers)}</strong>
            </div>
          </div>
          <TrendMultiLineChart
            data={conversion.payment_trend.map((item) => ({
              label: item.period,
              users_total: item.users_total,
              paid_users: item.paid_users,
              repeat_buyers: item.repeat_buyers,
              revenue: item.revenue,
            }))}
            series={[
              { key: 'users_total', label: '用户总数', color: '#2563EB', strokeWidth: 4 },
              { key: 'paid_users', label: '付费用户', color: '#C65C34' },
              { key: 'repeat_buyers', label: '复购用户', color: '#A16207' },
            ]}
            emptyText="当前窗口暂无付费与复购趋势"
            tooltipExtras={(datum) => [{ label: '收入', value: formatCurrency(Number(datum.revenue || 0)) }]}
          />
        </section>
      </div>
    );
  };

  const renderUsersPage = () => {
    if (!users) return null;
    return (
      <div className="tenant-analytics-page">
        <section className="card tenant-analytics-panel">
          <div className="platform-section-head">
            <h3>筛选器</h3>
          </div>
          <div className="tenant-analytics-filter-grid">
            <div className="form-group">
              <label>用户分层</label>
              <select value={segmentFilter} onChange={(event) => setSegmentFilter(event.target.value)}>
                <option value="">全部</option>
                <option value="unactivated">未激活</option>
                <option value="active_7d">近 7 天活跃</option>
                <option value="active_30d">近 30 天活跃</option>
                <option value="inactive_30d">30 天未活跃</option>
              </select>
            </div>
            <div className="form-group">
              <label>注册时间</label>
              <select value={createdScopeFilter} onChange={(event) => setCreatedScopeFilter(event.target.value as 'in_range' | 'out_of_range' | '')}>
                <option value="">全部</option>
                <option value="in_range">当前统计窗口内</option>
                <option value="out_of_range">当前统计窗口外</option>
              </select>
            </div>
            <div className="form-group">
              <label>最后登录</label>
              <select value={lastLoginScopeFilter} onChange={(event) => setLastLoginScopeFilter(event.target.value as 'in_range' | 'out_of_range' | 'never' | '')}>
                <option value="">全部</option>
                <option value="in_range">当前统计窗口内</option>
                <option value="out_of_range">当前统计窗口外</option>
                <option value="never">从未登录</option>
              </select>
            </div>
            <div className="form-group">
              <label>会员类型</label>
              <select value={membershipTypeFilter} onChange={(event) => setMembershipTypeFilter(event.target.value)}>
                <option value="">全部</option>
                <option value="FREE">FREE</option>
                <option value="PREMIUM">PREMIUM</option>
              </select>
            </div>
            <div className="form-group">
              <label>登录方式</label>
              <select value={loginMethodFilter} onChange={(event) => setLoginMethodFilter(event.target.value)}>
                <option value="">全部</option>
                <option value="wechat">wechat</option>
                <option value="phone">phone</option>
                <option value="email">email</option>
              </select>
            </div>
            <div className="form-group">
              <label>来源</label>
              <input value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)} placeholder="如 wechat / web / email" />
            </div>
            <div className="form-group">
              <label>付费状态</label>
              <select value={paidStatusFilter} onChange={(event) => setPaidStatusFilter(event.target.value)}>
                <option value="">全部</option>
                <option value="paid">已付费</option>
                <option value="unpaid">未付费</option>
              </select>
            </div>
            <div className="form-group">
              <label>账号状态</label>
              <select value={accountStatusFilter} onChange={(event) => setAccountStatusFilter(event.target.value as 'active' | 'deactivated' | 'all')}>
                <option value="active">正常</option>
                <option value="deactivated">已注销</option>
                <option value="all">全部</option>
              </select>
            </div>
          </div>
        </section>

        <section className="tenant-analytics-users-layout">
          <section className="card tenant-analytics-panel">
            <div className="platform-section-head">
              <h3>用户列表</h3>
              <span>共 {formatCount(users.pagination.total)} 人</span>
            </div>
            <div className="platform-api-table-wrap">
              <table className="table tenant-analytics-user-table">
                <thead>
                  <tr>
                    <th>{renderSortButton('created_at', '时间')}</th>
                    <th>用户</th>
                    <th>方式</th>
                    <th>会员</th>
                    <th>{renderSortButton('paid_amount_total', '付费')}</th>
                    <th>{renderSortButton('points_balance', '积分')}</th>
                    <th>{renderSortButton('ai_requests_total', 'AI')}</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {users.items.length > 0 ? users.items.map((item) => (
                    <tr
                      key={item.id}
                      className={selectedUser?.id === item.id ? 'selected' : ''}
                      onClick={() => setSelectedUserId(item.id)}
                    >
                      <td>{formatDateTime(item.created_at)}</td>
                      <td>
                        <strong>{item.display_name || item.email}</strong>
                        <div className="tenant-analytics-table-sub">{item.deleted_at ? item.deactivated_email || item.email : item.email}</div>
                        <div className="tenant-analytics-table-sub">{item.deleted_at ? '已注销' : item.phone || '-'}</div>
                      </td>
                      <td>{item.login_method}</td>
                      <td>{item.membership_type}</td>
                      <td>{formatCurrency(item.paid_amount_total)}</td>
                      <td>{item.points_balance.toFixed(2)}</td>
                      <td>{formatCount(item.ai_requests_total)}</td>
                      <td>
                        <div className="tenant-analytics-user-actions" onClick={(event) => event.stopPropagation()}>
                          {item.deleted_at ? (
                            <button className="btn btn-secondary btn-sm" type="button" onClick={() => void runUserAction('restore', item.id)} disabled={loading}>
                              恢复
                            </button>
                          ) : (
                            <>
                              <button className="btn btn-secondary btn-sm" type="button" onClick={() => void runUserAction('unlink-phone', item.id)} disabled={loading || !item.phone}>
                                解绑手机
                              </button>
                              <button className="btn btn-secondary btn-sm" type="button" onClick={() => void runUserAction('unlink-email', item.id)} disabled={loading || !item.phone}>
                                解绑邮箱
                              </button>
                              <button className="btn btn-danger btn-sm" type="button" onClick={() => void runUserAction('deactivate', item.id)} disabled={loading}>
                                注销
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  )) : (
                    <tr>
                      <td colSpan={8}>{renderEmptyNote('当前筛选条件下暂无用户')}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="tenant-analytics-pagination">
              <button className="btn btn-secondary btn-sm" onClick={() => setUsersPage((prev) => Math.max(1, prev - 1))} disabled={usersPage <= 1 || loading}>
                上一页
              </button>
              <span>
                第 {users.pagination.page} / {Math.max(1, Math.ceil(users.pagination.total / users.pagination.page_size))} 页
              </span>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => setUsersPage((prev) => prev + 1)}
                disabled={users.pagination.page * users.pagination.page_size >= users.pagination.total || loading}
              >
                下一页
              </button>
            </div>
          </section>

          <aside className="card tenant-analytics-panel tenant-analytics-user-detail">
            <div className="platform-section-head">
              <h3>用户详情</h3>
            </div>
            {selectedUser ? (
              <div className="tenant-analytics-detail-grid">
                <div className="platform-detail-row">
                  <span>用户</span>
                  <strong>{selectedUser.display_name || selectedUser.email}</strong>
                </div>
                <div className="platform-detail-row">
                  <span>状态</span>
                  <strong>{selectedUser.deleted_at ? '已注销' : selectedUser.is_active ? '正常' : '禁用'}</strong>
                </div>
                <div className="platform-detail-row">
                  <span>邮箱</span>
                  <strong>{selectedUser.deleted_at ? selectedUser.deactivated_email || selectedUser.email : selectedUser.email}</strong>
                </div>
                <div className="platform-detail-row">
                  <span>手机号</span>
                  <strong>{selectedUser.deleted_at ? selectedUser.deactivated_phone || '-' : selectedUser.phone || '-'}</strong>
                </div>
                <div className="platform-detail-row">
                  <span>注册来源</span>
                  <strong>{selectedUser.source}</strong>
                </div>
                <div className="platform-detail-row">
                  <span>注册时间</span>
                  <strong>{formatDateTime(selectedUser.created_at)}</strong>
                </div>
                <div className="platform-detail-row">
                  <span>最后登录</span>
                  <strong>{formatDateTime(selectedUser.last_login_at)}</strong>
                </div>
                <div className="platform-detail-row">
                  <span>最后活跃</span>
                  <strong>{formatDateTime(selectedUser.last_activity_at)}</strong>
                </div>
                <div className="platform-detail-row">
                  <span>累计付费</span>
                  <strong>{formatCurrency(selectedUser.paid_amount_total)}</strong>
                </div>
                <div className="platform-detail-row">
                  <span>积分余额</span>
                  <strong>{selectedUser.points_balance.toFixed(2)}</strong>
                </div>
                <div className="platform-detail-row">
                  <span>AI 请求</span>
                  <strong>{formatCount(selectedUser.ai_requests_total)}</strong>
                </div>
                <div className="platform-detail-row">
                  <span>AI Token</span>
                  <strong>{formatCount(selectedUser.ai_total_tokens)}</strong>
                </div>
                <div className="platform-detail-row">
                  <span>AI 扣点</span>
                  <strong>{selectedUser.ai_points_spent_total.toFixed(2)}</strong>
                </div>
                <div className="platform-detail-row">
                  <span>最近事件</span>
                  <strong>{selectedUser.recent_event || '-'}</strong>
                </div>
                <div className="platform-detail-row">
                  <span>最近订单</span>
                  <strong>{selectedUser.recent_order || '-'}</strong>
                </div>
                <div className="platform-detail-row">
                  <span>最近充值</span>
                  <strong>{formatDateTime(selectedUser.recent_recharge)}</strong>
                </div>
              </div>
            ) : (
              <div className="analytics-empty-note">暂无用户</div>
            )}
          </aside>
        </section>
      </div>
    );
  };

  return (
    <div className="platform-page tenant-analytics-shell">
      <section className="tenant-analytics-hero">
        <div className="tenant-analytics-hero-head">
          <div>
            <h3>{activeSubPage === 'overview' ? '应用概览' : activeSubPageMeta?.label || '用户分析台'}</h3>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={() => setRefreshKey((prev) => prev + 1)} disabled={loading}>
            {loading ? '刷新中...' : '刷新'}
          </button>
        </div>
        <div className="tenant-analytics-toolbar">
          <div className="tenant-analytics-toolbar-block tenant-analytics-toolbar-block-wide">
            <span className="tenant-analytics-toolbar-label">时间范围</span>
            <div className="tenant-analytics-segmented-control">
              {RANGE_PRESET_OPTIONS.map((option) => (
                <button
                  key={String(option.value)}
                  type="button"
                  className={`tenant-analytics-segmented-item ${rangePreset === option.value ? 'active' : ''}`}
                  onClick={() => setRangePreset(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <div className="tenant-analytics-toolbar-block">
            <span className="tenant-analytics-toolbar-label">粒度</span>
            <div className="tenant-analytics-segmented-control tenant-analytics-segmented-control-compact">
              {GRANULARITY_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`tenant-analytics-segmented-item ${granularity === option.value ? 'active' : ''}`}
                  onClick={() => setGranularity(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <div className="tenant-analytics-toolbar-block tenant-analytics-toolbar-block-timezone">
            <span className="tenant-analytics-toolbar-label">时区</span>
            <input className="tenant-analytics-compact-input" value={timezone} onChange={(event) => setTimezone(event.target.value)} />
          </div>

          {rangePreset === 'custom' ? (
            <div className="tenant-analytics-toolbar-block tenant-analytics-toolbar-block-dates">
              <span className="tenant-analytics-toolbar-label">日期</span>
              <div className="tenant-analytics-date-range">
                <input className="tenant-analytics-compact-input" type="date" value={customFrom} onChange={(event) => setCustomFrom(event.target.value)} />
                <span>至</span>
                <input className="tenant-analytics-compact-input" type="date" value={customTo} onChange={(event) => setCustomTo(event.target.value)} />
              </div>
            </div>
          ) : null}
        </div>
        <div className="tenant-analytics-range-line">{renderRangeInfo()}</div>
      </section>

      <section className="tenant-analytics-subnav">
        {ANALYTICS_SUB_NAV.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`tenant-analytics-subnav-item ${activeSubPage === item.key ? 'active' : ''}`}
            onClick={() => navigate(`/platform-admin/apps/${appId}/analytics/${item.key}`)}
          >
            <strong>{item.label}</strong>
          </button>
        ))}
      </section>

      {errorText ? <div className="alert alert-error">{errorText}</div> : null}
      {loading && !overview && !growth && !retention && !profiles && !conversion && !users ? <div className="loading">加载中...</div> : null}

      {activeSubPage === 'overview' && renderOverviewPage()}
      {activeSubPage === 'growth' && renderGrowthPage()}
      {activeSubPage === 'retention' && renderRetentionPage()}
      {activeSubPage === 'profiles' && renderProfilesPage()}
      {activeSubPage === 'conversion' && renderConversionPage()}
      {activeSubPage === 'users' && renderUsersPage()}
    </div>
  );
}
