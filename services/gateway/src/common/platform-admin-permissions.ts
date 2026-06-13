export const PLATFORM_APP_ADMIN_PERMISSION_CATALOG = [
  {
    key: 'app_overview_read',
    name: '应用概览',
    description: '查看应用基础信息、域名与状态',
  },
  {
    key: 'app_analytics_read',
    name: '经营分析',
    description: '查看用户、订单与增长数据',
  },
  {
    key: 'app_ai_usage_read',
    name: 'AI 调用统计',
    description: '查看 AI 调用、消耗与日志',
  },
  {
    key: 'app_api_docs_read',
    name: 'API 文档',
    description: '查看当前应用 API 文档',
  },
  {
    key: 'app_site_manage',
    name: '官网配置',
    description: '管理官网配置、表单消息与下载项',
  },
  {
    key: 'app_email_manage',
    name: '邮件',
    description: '管理应用邮件配置、联系人与批次',
  },
  {
    key: 'app_feedback_manage',
    name: '用户反馈',
    description: '查看和处理用户反馈工单',
  },
  {
    key: 'app_acquisition_manage',
    name: '用户来源',
    description: '管理来源选项并查看来源数据',
  },
  {
    key: 'app_redeem_read',
    name: '产品与兑换查询',
    description: '查看产品、订单、兑换码与兑换记录',
  },
  {
    key: 'app_redeem_products_manage',
    name: '产品配置',
    description: '管理产品与权益配置',
  },
] as const;

export const PLATFORM_APP_ADMIN_PERMISSION_KEYS = new Set(
  PLATFORM_APP_ADMIN_PERMISSION_CATALOG.map((item) => item.key),
);

export const PLATFORM_LEGACY_PERMISSION_EXPANSIONS: Record<string, string[]> = {
  admin_redeem_codes: ['app_redeem_read'],
  admin_product_payments: ['app_redeem_read', 'app_redeem_products_manage'],
};

export function normalizePlatformAppAdminPermissions(value: unknown): string[] {
  const rawKeys = Array.isArray(value) ? value : [];
  const normalized = new Set<string>();

  rawKeys.forEach((item) => {
    if (typeof item !== 'string') return;
    const key = item.trim();
    if (!key) return;
    if (PLATFORM_APP_ADMIN_PERMISSION_KEYS.has(key as any)) {
      normalized.add(key);
      return;
    }
    const expanded = PLATFORM_LEGACY_PERMISSION_EXPANSIONS[key];
    if (expanded) {
      expanded.forEach((expandedKey) => normalized.add(expandedKey));
    }
  });

  return Array.from(normalized).sort();
}

export function findInvalidPlatformAppAdminPermissions(value: unknown): string[] {
  const rawKeys = Array.isArray(value) ? value : [];
  const invalid = new Set<string>();

  rawKeys.forEach((item) => {
    if (typeof item !== 'string') return;
    const key = item.trim();
    if (!key) return;
    if (!PLATFORM_APP_ADMIN_PERMISSION_KEYS.has(key as any) && !PLATFORM_LEGACY_PERMISSION_EXPANSIONS[key]) {
      invalid.add(key);
    }
  });

  return Array.from(invalid).sort();
}
