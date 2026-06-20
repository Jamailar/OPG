export type AppRuntimeTemplate = {
  key: string;
  version: string;
  name: string;
  category: 'ai' | 'commerce' | 'content' | 'auth' | 'operations';
  summary: string;
  modules: string[];
  creates: {
    ai_blocks?: Array<Record<string, unknown>>;
    video_blocks?: Array<Record<string, unknown>>;
    functions?: Array<Record<string, unknown>>;
    workflows?: Array<Record<string, unknown>>;
    storage_buckets?: Array<Record<string, unknown>>;
  };
};

export const APP_RUNTIME_TEMPLATES: AppRuntimeTemplate[] = [
  {
    key: 'ai-text-app',
    version: '2026-06-20',
    name: 'AI Text App',
    category: 'ai',
    summary: 'Text generation block, payload normalization function, and one workflow pipeline.',
    modules: ['ai_gateway', 'app_blocks', 'app_functions', 'app_workflows', 'observability'],
    creates: {
      ai_blocks: [
        {
          slug: 'quick_reply',
          type: 'text_generation',
          model_slot: 'default_text',
          prompt_template: 'Answer clearly for {{topic}}.',
          input_schema_json: { type: 'object', properties: { topic: { type: 'string' } } },
          output_schema_json: { type: 'object' },
          settings_json: { payload: { temperature: 0.4 } },
        },
      ],
      functions: [
        {
          slug: 'normalize_payload',
          entrypoint: 'handler',
          source_json: { kind: 'transform', pick: ['topic', 'user_id'], set: { normalized: true } },
          trigger_json: { kind: 'manual' },
        },
      ],
      workflows: [
        {
          slug: 'generate_text_pipeline',
          name: 'Generate text pipeline',
          steps_json: [
            { id: 'normalize', type: 'function.invoke', function: 'normalize_payload' },
            { id: 'generate', type: 'ai.generate_text', block: 'quick_reply' },
          ],
          trigger_json: { kind: 'manual' },
        },
      ],
    },
  },
  {
    key: 'ai-video-app',
    version: '2026-06-20',
    name: 'AI Video App',
    category: 'ai',
    summary: 'Video generation block, output storage bucket, and runtime observability hooks.',
    modules: ['ai_gateway', 'video_jobs', 'storage', 'observability'],
    creates: {
      video_blocks: [
        {
          slug: 'generate_video',
          provider_slot: 'default_video',
          input_schema_json: { type: 'object', properties: { prompt: { type: 'string' } } },
          output_schema_json: { type: 'object' },
          settings_json: { payload: { mode: 'text-to-video' } },
        },
      ],
      storage_buckets: [
        { slug: 'video_outputs', policy_json: { visibility: 'private' }, quota_json: { retention_days: 30 } },
      ],
    },
  },
  {
    key: 'membership-app',
    version: '2026-06-20',
    name: 'Membership App',
    category: 'commerce',
    summary: 'Payment, redeem, auth, SMS, and entitlement modules grouped for paid apps.',
    modules: ['auth', 'payments', 'redeem', 'sms', 'observability'],
    creates: {},
  },
  {
    key: 'content-site',
    version: '2026-06-20',
    name: 'Content Site',
    category: 'content',
    summary: 'Tenant site, email, public asset storage, and behavior analytics modules.',
    modules: ['tenant_site', 'email', 'storage', 'behavior_analytics', 'observability'],
    creates: {
      storage_buckets: [
        { slug: 'public_assets', policy_json: { visibility: 'public-read' }, quota_json: { retention_days: null } },
      ],
    },
  },
  {
    key: 'wechat-login-app',
    version: '2026-06-20',
    name: 'WeChat Login App',
    category: 'auth',
    summary: 'Auth, OAuth credential references, SMS verification, and audit readiness.',
    modules: ['auth', 'oauth', 'sms', 'observability'],
    creates: {},
  },
];

export function getAppRuntimeTemplate(templateKey: string) {
  return APP_RUNTIME_TEMPLATES.find((template) => template.key === templateKey);
}
