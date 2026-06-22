export type PlatformPermissionLevel = 'read' | 'write' | 'manage' | 'sensitive';

export type PlatformAppAdminPermissionCatalogItem = {
  key: string;
  module: string;
  module_name: string;
  name: string;
  description: string;
  level: PlatformPermissionLevel;
  action: string;
  sensitive?: boolean;
  requires_super_admin?: boolean;
};

export type PlatformAppAdminRoleTemplate = {
  key: string;
  name: string;
  description: string;
  permissions: string[];
};

export const PLATFORM_APP_ADMIN_PERMISSION_CATALOG: PlatformAppAdminPermissionCatalogItem[] = [
  {
    key: 'app.overview.read',
    module: 'overview',
    module_name: '应用概览',
    name: '查看应用概览',
    description: '查看应用基础信息、域名、关键状态和基础统计。',
    level: 'read',
    action: 'read',
  },
  {
    key: 'app.analytics.read',
    module: 'analytics',
    module_name: '经营分析',
    name: '查看经营分析',
    description: '查看用户、订单、增长、留存和收入分析。',
    level: 'read',
    action: 'read',
  },
  {
    key: 'app.users.read',
    module: 'users',
    module_name: '用户',
    name: '查看用户',
    description: '查看租户用户列表和用户资料。',
    level: 'read',
    action: 'read',
  },
  {
    key: 'app.users.write',
    module: 'users',
    module_name: '用户',
    name: '管理用户状态',
    description: '停用、恢复用户，解绑用户手机号或邮箱。',
    level: 'sensitive',
    action: 'write',
    sensitive: true,
  },
  {
    key: 'app.ai.usage.read',
    module: 'ai',
    module_name: 'AI',
    name: '查看 AI 用量',
    description: '查看 AI 调用、消耗、模型与错误日志。',
    level: 'read',
    action: 'read',
  },
  {
    key: 'app.ai.routing.write',
    module: 'ai',
    module_name: 'AI',
    name: '管理 AI 路由',
    description: '配置租户模型展示、默认模型和 capability 路由。',
    level: 'write',
    action: 'write',
    sensitive: true,
  },
  {
    key: 'app.ai.points.grant',
    module: 'ai',
    module_name: 'AI',
    name: '发放 AI 积分',
    description: '手动给用户发放 AI 积分。',
    level: 'sensitive',
    action: 'grant',
    sensitive: true,
  },
  {
    key: 'app.ai.video_proxy.write',
    module: 'ai',
    module_name: 'AI',
    name: '管理视频下载加速',
    description: '开启或调整 RunningHub 视频结果代理下载与存储策略。',
    level: 'write',
    action: 'write',
    sensitive: true,
  },
  {
    key: 'app.logs.read',
    module: 'observability',
    module_name: '日志',
    name: '查看日志',
    description: '查看请求、任务、审计和运行日志。',
    level: 'read',
    action: 'read',
  },
  {
    key: 'app.notifications.read',
    module: 'notifications',
    module_name: '管理员通知',
    name: '查看通知',
    description: '查看管理员通知事件、渠道和投递记录。',
    level: 'read',
    action: 'read',
  },
  {
    key: 'app.notifications.manage',
    module: 'notifications',
    module_name: '管理员通知',
    name: '管理通知',
    description: '配置飞书机器人、邮件收件人和事件通知规则。',
    level: 'manage',
    action: 'manage',
    sensitive: true,
  },
  {
    key: 'app.api_docs.read',
    module: 'developers',
    module_name: '开发者',
    name: '查看 API 文档',
    description: '查看当前应用 API 文档、SDK 示例和接入说明。',
    level: 'read',
    action: 'read',
  },
  {
    key: 'app.developers.manage',
    module: 'developers',
    module_name: '开发者',
    name: '管理开发者授权',
    description: '创建、查看和撤销 SDK / Codex 开发者授权。',
    level: 'manage',
    action: 'manage',
    sensitive: true,
  },
  {
    key: 'app.site.read',
    module: 'site',
    module_name: '官网',
    name: '查看官网配置',
    description: '查看官网配置、下载项、表单消息和 Cookie 偏好。',
    level: 'read',
    action: 'read',
  },
  {
    key: 'app.site.write',
    module: 'site',
    module_name: '官网',
    name: '管理官网配置',
    description: '修改官网配置、处理官网消息和上传下载项。',
    level: 'write',
    action: 'write',
  },
  {
    key: 'app.email.read',
    module: 'email',
    module_name: '邮件',
    name: '查看邮件',
    description: '查看联系人、模板、发件人和邮件批次。',
    level: 'read',
    action: 'read',
  },
  {
    key: 'app.email.write',
    module: 'email',
    module_name: '邮件',
    name: '管理邮件资产',
    description: '管理联系人、模板、发件人和邮件批次。',
    level: 'write',
    action: 'write',
  },
  {
    key: 'app.email.send',
    module: 'email',
    module_name: '邮件',
    name: '发送邮件',
    description: '发送测试邮件、排期或取消邮件批次。',
    level: 'sensitive',
    action: 'send',
    sensitive: true,
  },
  {
    key: 'app.feedback.read',
    module: 'feedback',
    module_name: '用户反馈',
    name: '查看反馈',
    description: '查看用户反馈、评论和处理记录。',
    level: 'read',
    action: 'read',
  },
  {
    key: 'app.feedback.review',
    module: 'feedback',
    module_name: '用户反馈',
    name: '处理反馈',
    description: '更新反馈状态、优先级和处理备注。',
    level: 'write',
    action: 'review',
  },
  {
    key: 'app.feedback.reward',
    module: 'feedback',
    module_name: '用户反馈',
    name: '反馈奖励',
    description: '处理反馈奖励或补偿。',
    level: 'sensitive',
    action: 'reward',
    sensitive: true,
  },
  {
    key: 'app.acquisition.read',
    module: 'acquisition',
    module_name: '用户来源',
    name: '查看用户来源',
    description: '查看来源选项和用户来源提交记录。',
    level: 'read',
    action: 'read',
  },
  {
    key: 'app.acquisition.write',
    module: 'acquisition',
    module_name: '用户来源',
    name: '管理用户来源',
    description: '创建、编辑、排序和删除来源选项。',
    level: 'write',
    action: 'write',
  },
  {
    key: 'app.forms.read',
    module: 'forms',
    module_name: '表单',
    name: '查看表单',
    description: '查看表单列表、发布版本、提交记录和统计。',
    level: 'read',
    action: 'read',
  },
  {
    key: 'app.forms.write',
    module: 'forms',
    module_name: '表单',
    name: '管理表单',
    description: '创建、编辑、发布表单，并维护问题、逻辑和动作。',
    level: 'write',
    action: 'write',
  },
  {
    key: 'app.products.read',
    module: 'commerce',
    module_name: '产品与支付',
    name: '查看产品',
    description: '查看产品、权益包和支付商品配置。',
    level: 'read',
    action: 'read',
  },
  {
    key: 'app.products.write',
    module: 'commerce',
    module_name: '产品与支付',
    name: '管理产品',
    description: '创建、编辑和删除产品、权益包和支付商品配置。',
    level: 'write',
    action: 'write',
  },
  {
    key: 'app.orders.read',
    module: 'commerce',
    module_name: '产品与支付',
    name: '查看订单',
    description: '查看订单、签约和扣款记录。',
    level: 'read',
    action: 'read',
  },
  {
    key: 'app.orders.refund',
    module: 'commerce',
    module_name: '产品与支付',
    name: '订单退款',
    description: '发起订单退款。',
    level: 'sensitive',
    action: 'refund',
    sensitive: true,
  },
  {
    key: 'app.orders.charge',
    module: 'commerce',
    module_name: '产品与支付',
    name: '手动扣款',
    description: '执行手动扣款、自动扣款任务或签约解约。',
    level: 'sensitive',
    action: 'charge',
    sensitive: true,
  },
  {
    key: 'app.redeem.codes.read',
    module: 'redeem',
    module_name: '兑换码',
    name: '查看兑换码',
    description: '查看兑换码、批次和兑换记录。',
    level: 'read',
    action: 'read',
  },
  {
    key: 'app.redeem.codes.create',
    module: 'redeem',
    module_name: '兑换码',
    name: '创建兑换码',
    description: '创建兑换码批次。',
    level: 'write',
    action: 'create',
    sensitive: true,
  },
  {
    key: 'app.redeem.codes.void',
    module: 'redeem',
    module_name: '兑换码',
    name: '作废兑换码',
    description: '作废指定兑换码。',
    level: 'sensitive',
    action: 'void',
    sensitive: true,
  },
  {
    key: 'app.redeem.redemptions.revoke',
    module: 'redeem',
    module_name: '兑换码',
    name: '撤销兑换记录',
    description: '撤销兑换记录并回收权益。',
    level: 'sensitive',
    action: 'revoke',
    sensitive: true,
  },
  {
    key: 'app.redeem.packages.distribute',
    module: 'redeem',
    module_name: '兑换码',
    name: '分发权益包',
    description: '按用户身份手动分发权益包。',
    level: 'sensitive',
    action: 'distribute',
    sensitive: true,
  },
  {
    key: 'app.build.read',
    module: 'build',
    module_name: '数据构建',
    name: '查看数据构建',
    description: '查看构建、任务和数据库工作区状态。',
    level: 'read',
    action: 'read',
  },
  {
    key: 'app.schema.read',
    module: 'schema',
    module_name: '数据结构',
    name: '查看数据结构',
    description: '查看应用表结构、字段和策略。',
    level: 'read',
    action: 'read',
  },
  {
    key: 'app.schema.write',
    module: 'schema',
    module_name: '数据结构',
    name: '管理数据结构',
    description: '创建、修改和删除应用表结构、字段和策略。',
    level: 'sensitive',
    action: 'write',
    sensitive: true,
  },
  {
    key: 'app.runtime.manage',
    module: 'runtime',
    module_name: '运行时',
    name: '管理运行时',
    description: '管理函数、工作流、连接器、模块、存储和 agent 配置。',
    level: 'manage',
    action: 'manage',
    sensitive: true,
  },
  {
    key: 'app.admins.manage',
    module: 'admins',
    module_name: '管理员',
    name: '管理管理员',
    description: '创建管理员、重置密码、启停账号和调整权限。',
    level: 'sensitive',
    action: 'manage',
    sensitive: true,
    requires_super_admin: true,
  },
] as const;

export const PLATFORM_APP_ADMIN_PERMISSION_KEYS = new Set(
  PLATFORM_APP_ADMIN_PERMISSION_CATALOG.map((item) => item.key),
);

export const PLATFORM_PERMISSION_DEPENDENCIES: Record<string, string[]> = {
  'app.users.write': ['app.users.read'],
  'app.ai.routing.write': ['app.ai.usage.read'],
  'app.ai.points.grant': ['app.ai.usage.read'],
  'app.ai.video_proxy.write': ['app.ai.usage.read'],
  'app.notifications.manage': ['app.notifications.read'],
  'app.developers.manage': ['app.api_docs.read'],
  'app.site.write': ['app.site.read'],
  'app.email.write': ['app.email.read'],
  'app.email.send': ['app.email.read'],
  'app.feedback.review': ['app.feedback.read'],
  'app.feedback.reward': ['app.feedback.read', 'app.feedback.review'],
  'app.acquisition.write': ['app.acquisition.read'],
  'app.forms.write': ['app.forms.read'],
  'app.products.write': ['app.products.read'],
  'app.orders.refund': ['app.orders.read'],
  'app.orders.charge': ['app.orders.read'],
  'app.redeem.codes.create': ['app.redeem.codes.read'],
  'app.redeem.codes.void': ['app.redeem.codes.read'],
  'app.redeem.redemptions.revoke': ['app.redeem.codes.read'],
  'app.redeem.packages.distribute': ['app.products.read', 'app.redeem.codes.read'],
  'app.schema.write': ['app.schema.read'],
};

export const PLATFORM_PERMISSION_ALIASES: Record<string, string[]> = {
  app_overview_read: ['app.overview.read'],
  app_analytics_read: ['app.analytics.read'],
  app_ai_usage_read: ['app.ai.usage.read'],
  app_logs_read: ['app.logs.read'],
  app_notifications_manage: ['app.notifications.read', 'app.notifications.manage'],
  app_api_docs_read: ['app.api_docs.read'],
  app_site_manage: ['app.site.read', 'app.site.write'],
  app_email_manage: ['app.email.read', 'app.email.write', 'app.email.send'],
  app_feedback_manage: ['app.feedback.read', 'app.feedback.review', 'app.feedback.reward'],
  app_acquisition_manage: ['app.acquisition.read', 'app.acquisition.write'],
  app_forms_manage: ['app.forms.read', 'app.forms.write'],
  app_redeem_read: ['app.products.read', 'app.orders.read', 'app.redeem.codes.read'],
  app_redeem_products_manage: ['app.products.read', 'app.products.write'],
  admin_accounts: ['app.admins.manage'],
  admin_redeem_codes: ['app.redeem.codes.read', 'app.redeem.codes.create', 'app.redeem.codes.void'],
  admin_product_payments: ['app.products.read', 'app.products.write', 'app.orders.read', 'app.orders.refund', 'app.orders.charge'],
};

export const PLATFORM_LEGACY_PERMISSION_EXPANSIONS = PLATFORM_PERMISSION_ALIASES;

export const PLATFORM_APP_ADMIN_ROLE_TEMPLATES: PlatformAppAdminRoleTemplate[] = [
  {
    key: 'readonly',
    name: '只读观察员',
    description: '查看概览、分析、日志、API 文档和主要运营数据。',
    permissions: [
      'app.overview.read',
      'app.analytics.read',
      'app.ai.usage.read',
      'app.logs.read',
      'app.notifications.read',
      'app.api_docs.read',
      'app.site.read',
      'app.email.read',
      'app.feedback.read',
      'app.acquisition.read',
      'app.forms.read',
      'app.products.read',
      'app.orders.read',
      'app.redeem.codes.read',
      'app.build.read',
      'app.schema.read',
    ],
  },
  {
    key: 'operations',
    name: '运营',
    description: '处理反馈、来源、产品、订单和兑换码日常运营。',
    permissions: [
      'app.overview.read',
      'app.analytics.read',
      'app.feedback.read',
      'app.feedback.review',
      'app.notifications.read',
      'app.notifications.manage',
      'app.acquisition.read',
      'app.acquisition.write',
      'app.forms.read',
      'app.forms.write',
      'app.products.read',
      'app.products.write',
      'app.orders.read',
      'app.redeem.codes.read',
      'app.redeem.codes.create',
    ],
  },
  {
    key: 'support',
    name: '客服',
    description: '查看用户、订单与反馈，并处理反馈状态。',
    permissions: ['app.overview.read', 'app.users.read', 'app.orders.read', 'app.feedback.read', 'app.feedback.review', 'app.notifications.read', 'app.redeem.codes.read'],
  },
  {
    key: 'commerce',
    name: '产品与支付',
    description: '管理产品、订单、兑换码和支付联调。',
    permissions: [
      'app.overview.read',
      'app.analytics.read',
      'app.products.read',
      'app.products.write',
      'app.orders.read',
      'app.orders.refund',
      'app.orders.charge',
      'app.redeem.codes.read',
      'app.redeem.codes.create',
      'app.redeem.codes.void',
      'app.redeem.redemptions.revoke',
      'app.redeem.packages.distribute',
    ],
  },
  {
    key: 'marketing',
    name: '营销',
    description: '管理用户来源、邮件和官网触达。',
    permissions: [
      'app.overview.read',
      'app.analytics.read',
      'app.acquisition.read',
      'app.acquisition.write',
      'app.forms.read',
      'app.forms.write',
      'app.email.read',
      'app.email.write',
      'app.email.send',
      'app.site.read',
      'app.site.write',
    ],
  },
  {
    key: 'ai_operator',
    name: 'AI 运营',
    description: '查看 AI 用量并维护模型路由、默认模型和视频下载加速。',
    permissions: ['app.overview.read', 'app.ai.usage.read', 'app.ai.routing.write', 'app.ai.video_proxy.write', 'app.notifications.read', 'app.logs.read'],
  },
  {
    key: 'developer',
    name: '开发者',
    description: '查看开发文档、日志、构建状态和数据结构。',
    permissions: ['app.overview.read', 'app.api_docs.read', 'app.logs.read', 'app.build.read', 'app.schema.read', 'app.developers.manage'],
  },
];

export function expandPlatformAppAdminPermissions(keys: Iterable<string>): string[] {
  const normalized = new Set<string>();
  const queue = Array.from(keys);

  while (queue.length > 0) {
    const raw = queue.shift();
    if (typeof raw !== 'string') continue;
    const key = raw.trim();
    if (!key) continue;

    const expanded = PLATFORM_PERMISSION_ALIASES[key] || [key];
    for (const expandedKey of expanded) {
      if (!PLATFORM_APP_ADMIN_PERMISSION_KEYS.has(expandedKey)) continue;
      if (normalized.has(expandedKey)) continue;
      normalized.add(expandedKey);
      const dependencies = PLATFORM_PERMISSION_DEPENDENCIES[expandedKey] || [];
      dependencies.forEach((dependency) => queue.push(dependency));
    }
  }

  return Array.from(normalized).sort();
}

export function normalizePlatformAppAdminPermissions(value: unknown): string[] {
  return expandPlatformAppAdminPermissions(Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []);
}

export function findInvalidPlatformAppAdminPermissions(value: unknown): string[] {
  const rawKeys = Array.isArray(value) ? value : [];
  const invalid = new Set<string>();

  rawKeys.forEach((item) => {
    if (typeof item !== 'string') return;
    const key = item.trim();
    if (!key) return;
    if (!PLATFORM_APP_ADMIN_PERMISSION_KEYS.has(key) && !PLATFORM_PERMISSION_ALIASES[key]) {
      invalid.add(key);
    }
  });

  return Array.from(invalid).sort();
}
