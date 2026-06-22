# App Forms 架构方案

## 背景

OPG 现在已经有 `acquisition` 模块，能管理每个 app 的用户来源选项、已登录用户来源提交、事件流水、后台统计和明细查询。这个能力适合作为“用户来源表单”的底层兼容链路，但它不应该限制表单产品只能做用户来源。

新的产品方向是把 app 工作区里的“用户来源”页面升级为通用的“表单”页面：

```text
表单
  -> 表单列表
  -> 创建表单
  -> 编辑表单问题、样式、嵌入、安全策略
  -> 查看提交记录和统计
  -> 每个 app 默认自带两个系统表单：
       1. 用户来源
       2. NPS 打分
```

网页 app、手机 app、桌面 app 都只需要嵌入 OPG 托管的 hosted form URL，不需要各端重复实现表单 UI、字段校验、提交入库、归因、统计和后台管理。

## 产品定位

App Forms 不是通用低代码页面搭建器，也不是问卷 SaaS。它是 OPG app 基座里的轻量表单能力，用于承载 app 运营、获客、反馈、满意度和基础调研。

核心目标：

- 每个 app 都有统一的托管表单入口。
- 后台页面名称从“用户来源”改为“表单”。
- 打开页面先看到表单列表，而不是直接进入用户来源统计。
- 点击某个表单进入编辑页。
- 支持自定义表单、自定义问题类型、自定义表头文案和基础样式。
- 内置系统表单“用户来源”和“NPS 打分”。
- 用户来源表单继续兼容现有 `acquisition` 统计真值。
- NPS 表单提供专门的得分统计。
- SDK、CLI、MCP 都能管理表单和读取提交。

## 开源项目调研

实施前调研并克隆了四个成熟开源表单/问卷项目，代码放在本机临时目录 `/tmp/opg-form-research`，不进入 OPG 仓库：

| 项目 | 重点阅读模块 | 可借鉴能力 | 不直接采用原因 |
| --- | --- | --- | --- |
| [Formbricks](https://github.com/formbricks/formbricks) | `packages/database/schema.prisma`、`packages/types/surveys/*`、`packages/surveys/src/lib/*`、`packages/js-core/src/lib/survey/*` | in-app/link survey、NPS、display 记录、触发器、隐藏字段、变量、结束页、配额、response pipeline、多语言、离线/重试 | 产品面完整但体量大，直接引入会把 OPG 的 app 权限、归因、SDK/CLI/MCP 边界打散 |
| [HeyForm](https://github.com/heyform/heyform) | `packages/shared-types-enums/src/form.ts`、`packages/form-renderer/src/store.ts`、`packages/answer-utils/src/*` | field kind taxonomy、逻辑条件/跳转、变量计算、隐藏字段、部分提交、答案标准化 | 渲染体验偏 conversational form，和 OPG 控制台的高密度管理体验不完全一致 |
| [Form.io JS](https://github.com/formio/formio.js) | `src/Webform.js`、`src/FormBuilder.js`、`src/components/_classes/component/*` | JSON schema 组件模型、组件注册、条件显示、计算值、schema 驱动 builder | 低代码能力过重，支持自定义 JS/CSS 会扩大安全面 |
| [SurveyJS](https://github.com/surveyjs/survey-library) | `packages/survey-core/src/questionfactory.ts`、`survey.ts`、`trigger.ts`、各 question model | question factory、page/panel、trigger、表达式、校验、ranking/matrix 等高级题型 | 适合作为独立 survey engine，不适合直接嵌入 OPG 的后端真值和权限体系 |

### 调研结论

成熟表单系统的完整业务逻辑不是“表单 + 问题 + 提交”三张表就结束，必须有以下核心层：

- Schema 层：表单配置、问题、变量、隐藏字段、结束页、逻辑规则、样式和安全策略要形成一个可版本化 manifest。
- Renderer 层：网页、手机 app、桌面 app 都只消费 manifest，不各自实现问题类型和校验。
- Answer 层：提交时既保存原始 answers，也写入 typed answer items，支持文本、数字、布尔、选项、NPS 等统计。
- Logic 层：至少支持条件显示、跳转到指定问题/结束页、设置变量、动态必填。
- Delivery 层：Hosted URL、iframe embed、in-app trigger 是同一套 form delivery 的不同入口。
- Lifecycle 层：draft、published、paused、archived 必须分离，已提交 response 需要绑定不可变发布版本。
- Integration 层：提交后触发事件、webhook、通知、AI enrichment、connector sync，但不能进入同步提交主链路。
- Abuse 层：rate limit、idempotency、honeypot、allowed origins、Turnstile/recaptcha 开关要作为平台能力。

OPG 的推荐实现是吸收这些架构，不直接引入完整第三方 form builder。原因是 OPG 的表单属于 app-scoped 控制平面能力，必须和 app、用户、权限、审计、acquisition、NPS、SDK、CLI、MCP 保持同一个真值边界。

## 当前系统真值

已有能力：

- `app_acquisition_source_options`：每个 app 的来源选项，支持 `key`、`label`、启停、是否允许补充说明、排序和 metadata。
- `user_acquisition_sources`：每个已登录用户最终归因来源，按 `(app_id, user_id)` 唯一。
- `user_acquisition_source_events`：来源提交事件流水，记录 UTM、referrer、landing path、session、IP hash、user agent。
- `AcquisitionService`：已有来源选项管理、用户提交、统计、明细查询。
- `TenantWorkspace`：当前 app 工作区有“用户来源”页面和“表单管理”入口。
- `app.acquisition.read` / `app.acquisition.write`：已有后台权限边界。

需要升级：

- 页面入口从 `用户来源` 改为 `表单`。
- 工作区 section 从 acquisition-only 升级为 forms-first。
- 后台首屏从来源提交记录改为表单列表。
- 表单编辑器从“来源选项管理”升级为通用问题编辑器。
- 数据模型从 `app_acquisition_forms` 升级为通用 `app_forms`。
- 用户来源作为内置表单类型，不再是唯一表单类型。
- NPS 作为内置表单类型，提供专用 score 聚合。

## 推荐方案

推荐实现 `App Forms` 通用模块，并让 `acquisition` 成为其中一个系统表单适配器：

```text
Platform UI:
  /platform-admin/apps/:app_id/forms
  /platform-admin/apps/:app_id/forms/:form_id

Hosted URL:
  /:app/forms/:form_key

Public API:
  GET  /:app/v1/forms/:form_key/manifest
  POST /:app/v1/forms/:form_key/responses

Admin API:
  GET    /api/v1/platform-admin/apps/:app_id/forms
  POST   /api/v1/platform-admin/apps/:app_id/forms
  GET    /api/v1/platform-admin/apps/:app_id/forms/:form_id
  PATCH  /api/v1/platform-admin/apps/:app_id/forms/:form_id
  DELETE /api/v1/platform-admin/apps/:app_id/forms/:form_id
  POST   /api/v1/platform-admin/apps/:app_id/forms/:form_id/duplicate
  POST   /api/v1/platform-admin/apps/:app_id/forms/:form_id/publish
  GET    /api/v1/platform-admin/apps/:app_id/forms/:form_id/versions
  GET    /api/v1/platform-admin/apps/:app_id/forms/:form_id/preview-manifest
  POST   /api/v1/platform-admin/apps/:app_id/forms/:form_id/questions
  PATCH  /api/v1/platform-admin/apps/:app_id/forms/:form_id/questions/:question_id
  DELETE /api/v1/platform-admin/apps/:app_id/forms/:form_id/questions/:question_id
  PUT    /api/v1/platform-admin/apps/:app_id/forms/:form_id/questions/reorder
  POST   /api/v1/platform-admin/apps/:app_id/forms/:form_id/logic
  PATCH  /api/v1/platform-admin/apps/:app_id/forms/:form_id/logic/:rule_id
  DELETE /api/v1/platform-admin/apps/:app_id/forms/:form_id/logic/:rule_id
  GET    /api/v1/platform-admin/apps/:app_id/forms/:form_id/responses
  GET    /api/v1/platform-admin/apps/:app_id/forms/:form_id/metrics
```

保留现有 acquisition API，作为兼容 API：

```text
GET  /:app/v1/acquisition/source-options
POST /:app/v1/users/me/acquisition-source
GET  /api/v1/platform-admin/apps/:app_id/acquisition/summary
GET  /api/v1/platform-admin/apps/:app_id/acquisition/users
```

新的用户来源表单提交后，要同时写入通用 form responses 和现有 acquisition 表，这样不会破坏已有统计和后台依赖。

## 核心架构

App Forms 分成五层实现：

```text
Platform Admin
  forms list
  form editor
  questions / logic / endings / theme / responses / metrics

Schema Service
  mutable draft tables
  publish validation
  immutable app_form_versions.schema_json
  manifest cache / ETag

Hosted Renderer
  /:app/forms/:form_key
  AppFormManifestV1 -> React renderer
  postMessage resize / submitted / auth bridge

Submission Runtime
  optional auth
  origin / rate limit / honeypot / idempotency
  typed validation
  raw response + answer items
  system adapters: acquisition / NPS

Async Pipeline
  event bus
  notifications
  webhooks / connectors
  AI enrichment
  future daily rollups
```

### Manifest 契约

Public renderer 和 SDK 不直接读后台 draft 表，只读发布后的 manifest：

```json
{
  "schema_version": "app_form_manifest_v1",
  "form": {
    "id": "form_...",
    "form_key": "nps",
    "kind": "NPS",
    "published_version_id": "ver_...",
    "version_number": 3,
    "status": "ACTIVE",
    "locale": "zh-CN",
    "languages": ["zh-CN"]
  },
  "blocks": [
    {
      "block_key": "nps_score",
      "type": "question",
      "question": {
        "question_key": "nps_score",
        "question_type": "nps",
        "label": "你有多大可能把我们推荐给朋友或同事？",
        "required": true,
        "validation": { "min": 0, "max": 10 }
      }
    }
  ],
  "hidden_fields": [
    { "key": "utm_source", "source": "query" },
    { "key": "campaign", "source": "host" }
  ],
  "variables": [
    { "key": "score_bucket", "type": "string", "default": "" }
  ],
  "logic": [
    {
      "rule_key": "detractor_reason_required",
      "when": {
        "all": [
          { "left": { "type": "answer", "key": "nps_score" }, "op": "less_or_equal", "right": 6 }
        ]
      },
      "actions": [
        { "type": "require", "target": "nps_reason" }
      ]
    }
  ],
  "endings": [
    {
      "ending_key": "default",
      "type": "message",
      "title": "已提交",
      "message": "感谢你的反馈"
    }
  ],
  "theme": {},
  "security": {}
}
```

设计原则：

- Draft 可频繁保存，published manifest 必须不可变。
- Public submit 必须带上 `published_version_id` 或 `version_number`，后端以该版本校验 answers。
- 表单编辑后不会改变历史 response 的问题定义，response 仍能按提交时 schema 渲染。
- Logic 使用受控 JSON DSL，不允许用户自定义 JavaScript。
- Renderer 只实现 OPG 支持的问题类型和动作，不暴露通用低代码能力。

## 方案对比

| 方案 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- |
| 继续只做用户来源表单 | 改动小，现有模块可复用 | 未来 NPS、调研、报名、满意度都要重复做 | 不推荐 |
| 用 `tenant-site` contact/newsletter 扩展 | 已支持匿名邮箱提交 | 语义是官网消息，不是通用 app 表单；问题类型和统计不匹配 | 不推荐 |
| 用 `app-schema` 动态表做所有表单 | 灵活，能自定义字段 | 表单渲染、提交、嵌入、安全、统计仍要自研；对运营用户太底层 | 不作为主线 |
| 直接引入第三方 form builder | 功能完整，短期 UI 能力多 | 数据、权限、归因、SDK/CLI/MCP、私有部署边界不可控；Form.io/SurveyJS 级别的通用低代码引擎过重 | 不推荐 |
| 自研 App Forms，吸收成熟项目的 schema/runtime/logic 模型 | 与 OPG app、权限、统计、嵌入、SDK/CLI/MCP 边界一致；可控、安全、轻量 | 需要新增通用表单模型、发布版本和轻量 renderer | 推荐 |

## 信息架构

### 工作区导航

当前：

```text
用户来源
```

目标：

```text
表单
```

导航描述建议：

```text
表单
收集用户来源、NPS 和自定义问题
```

路由建议：

```text
/platform-admin/apps/:app_id/forms
/platform-admin/apps/:app_id/forms/:form_id
```

兼容：

```text
/platform-admin/apps/:app_id/acquisition
  -> redirect /platform-admin/apps/:app_id/forms
```

### 表单首页

打开“表单”页面，首先展示表单列表。

布局要求：

- 使用高密度列表或表格，不做营销式卡片堆叠。
- 内置表单置顶，但视觉上不要抢占整个页面。
- 自定义表单和系统表单在同一列表里。
- 每行展示：名称、类型、状态、提交数、最近提交、是否可匿名、嵌入入口、操作。
- 顶部只有必要操作：新建表单、刷新。

表单列表字段：

```text
名称
类型
状态
提交数
最近提交
嵌入
操作
```

默认数据：

```text
用户来源     系统表单   启用   123   2026-06-22 10:30   复制 URL   编辑
NPS 打分     系统表单   启用    48   2026-06-22 09:10   复制 URL   编辑
```

### 表单编辑页

点击表单进入编辑页。

编辑页结构：

```text
表单 / 用户来源
  顶部：返回列表、draft 状态、published 版本、保存、发布、预览、复制嵌入 URL

  左侧：问题列表
    问题排序
    新增问题
    启停问题

  主区域：
    基本设置
    问题编辑
    逻辑
    结束页
    样式
    嵌入
    提交记录
    统计
```

为了避免 UI 变重，第一版可以不用复杂拖拽。问题排序用上移/下移或数字排序即可。

## 内置表单

每个 app 创建时或首次访问表单页面时，应自动拥有两个系统表单。

### 1. 用户来源

系统 key：

```text
user_source
```

form kind：

```text
ACQUISITION_SOURCE
```

默认问题：

```text
source_key
  type: source_select
  label: 你是从哪里知道我们的？
  required: true
  options_source: app_acquisition_source_options

free_text
  type: short_text
  label: 补充说明
  required: false
  visible_when: selected source allows free text

email
  type: email
  label: 邮箱
  required: false

name
  type: short_text
  label: 称呼
  required: false
```

提交行为：

- 写入 `app_form_responses`。
- 写入 `app_form_answer_items`。
- 如果有 `user_id`，同步 upsert `user_acquisition_sources`。
- 如果有 `user_id`，追加 `user_acquisition_source_events`。
- 匿名提交不写 `user_acquisition_sources`，但保留 response。
- 后台用户来源统计可以继续读旧表；表单统计读新表。

### 2. NPS 打分

系统 key：

```text
nps
```

form kind：

```text
NPS
```

默认问题：

```text
nps_score
  type: nps
  label: 你有多大可能把我们推荐给朋友或同事？
  required: true
  min: 0
  max: 10

nps_reason
  type: long_text
  label: 主要原因是什么？
  required: false

contact_permission
  type: consent
  label: 可以联系你进一步了解反馈吗？
  required: false
```

NPS 计算：

```text
promoters  = score 9-10
passives   = score 7-8
detractors = score 0-6
nps_score  = ((promoters - detractors) / total) * 100
```

NPS metrics API 要返回：

```json
{
  "total": 120,
  "nps_score": 42,
  "promoters": 70,
  "passives": 30,
  "detractors": 20,
  "average_score": 8.1,
  "trend": []
}
```

NPS 表单可以支持：

- 匿名提交。
- 已登录用户提交。
- 每用户只保留最新一次统计，或按时间窗口统计。

第一版建议：

- response 全量保留。
- metrics 默认按时间范围统计最新 response。
- 后续再做“每 30 天一次 NPS”的触发策略。

## 问题类型和逻辑能力

第一版支持的题型必须覆盖运营表单、用户来源、NPS、轻量调研和反馈场景：

| 类型 | 用途 | 备注 |
| --- | --- | --- |
| `statement` | 说明文字 | 不产生答案，可用于分隔说明 |
| `short_text` | 短文本 | 单行输入 |
| `long_text` | 长文本 | textarea |
| `email` | 邮箱 | 格式校验 |
| `phone` | 手机号 | 仅做宽松校验 |
| `url` | 链接 | 格式校验 |
| `number` | 数字 | 支持 min/max |
| `rating` | 普通评分 | 支持 1-5、1-10 |
| `nps` | NPS 0-10 | NPS 系统表单专用，也可自定义使用 |
| `single_select` | 单选 | options_json |
| `multi_select` | 多选 | options_json |
| `boolean` | 是/否 | switch/checkbox |
| `consent` | 同意项 | 适合隐私授权 |
| `date` | 日期 | HTML date input |
| `hidden` | 隐藏字段 | 用于来源、版本、campaign |
| `source_select` | 用户来源选择 | 绑定 `app_acquisition_source_options` |
| `opinion_scale` | 意见刻度 | 例如 1-7、1-10，NPS 之外的评分 |

暂不支持：

- 文件上传。
- 支付。
- 签名。
- 地址自动补全。
- matrix 矩阵题。
- ranking 排序题。
- 视频上传。
- 自定义 HTML / CSS / JS。

第一版支持的逻辑：

- 条件显示：`show` / `hide` 指定问题或 statement。
- 简单跳题：`jump_to` 指定后续问题或结束页。
- 动态必填：`require` 指定问题。
- 变量赋值：`set_variable`，用于 NPS bucket、评分分层、后续统计。
- 结束页：`message` 和 `redirect` 两种。

第一版不做的逻辑：

- 任意 JavaScript 表达式。
- 任意 JSON Logic 运行时。
- 循环跳转。
- 跨表单变量。
- 文件/支付相关逻辑。

逻辑 DSL：

```json
{
  "when": {
    "all": [
      { "left": { "type": "answer", "key": "plan" }, "op": "equals", "right": "team" },
      { "left": { "type": "hidden", "key": "utm_source" }, "op": "is_not_empty" }
    ]
  },
  "actions": [
    { "type": "show", "target": "team_size" },
    { "type": "jump_to", "target": "thank_you_team" }
  ]
}
```

支持的比较符：

```text
equals
not_equals
contains
not_contains
starts_with
ends_with
greater_than
greater_or_equal
less_than
less_or_equal
is_empty
is_not_empty
```

发布时必须检测：

- `jump_to` 目标存在。
- 逻辑不能形成循环。
- 不允许引用已删除或 inactive 问题。
- 操作不能修改系统必需问题的核心约束。

## 数据模型

### 通用表单表

```text
app_forms
  id uuid primary key
  app_id uuid not null references apps(id)
  form_key varchar(80) not null
  name varchar(160) not null
  description text null
  kind varchar(40) not null default 'CUSTOM'
  status varchar(24) not null default 'DRAFT'
  published_version_id uuid null
  latest_version_number integer not null default 0
  draft_revision integer not null default 1
  is_system boolean not null default false
  title varchar(180) null
  subtitle varchar(240) null
  body_text text null
  submit_label varchar(80) null
  success_title varchar(180) null
  success_message text null
  allow_anonymous boolean not null default true
  require_auth boolean not null default false
  one_response_per_user boolean not null default false
  captcha_mode varchar(24) not null default 'OFF'
  allowed_origins_json jsonb not null default '[]'
  default_language varchar(16) not null default 'zh-CN'
  languages_json jsonb not null default '["zh-CN"]'
  hidden_fields_json jsonb not null default '[]'
  variables_json jsonb not null default '[]'
  endings_json jsonb not null default '[]'
  theme_json jsonb not null default '{}'
  layout_json jsonb not null default '{}'
  behavior_json jsonb not null default '{}'
  settings_json jsonb not null default '{}'
  created_by_user_id uuid null references users(id)
  updated_by_user_id uuid null references users(id)
  created_at timestamptz not null default now()
  updated_at timestamptz not null default now()

unique (app_id, form_key)
```

迁移实现时可以在 `app_form_versions` 建完后再给 `published_version_id` 加 nullable FK；如果迁移工具处理循环引用不方便，先由 service 层保证 pointer 指向当前 form 的版本。

`kind` 枚举：

```text
CUSTOM
ACQUISITION_SOURCE
NPS
```

`status` 枚举：

```text
DRAFT
ACTIVE
PAUSED
ARCHIVED
```

### 发布版本表

后台编辑的是 draft tables，公开 manifest 使用发布版本。每次 publish 都生成不可变版本：

```text
app_form_versions
  id uuid primary key
  app_id uuid not null references apps(id)
  form_id uuid not null references app_forms(id)
  version_number integer not null
  schema_version varchar(40) not null default 'app_form_manifest_v1'
  schema_hash varchar(96) not null
  schema_json jsonb not null
  status varchar(24) not null default 'PUBLISHED'
  published_by_user_id uuid null references users(id)
  published_at timestamptz not null default now()
  created_at timestamptz not null default now()

unique (form_id, version_number)
unique (form_id, schema_hash)
```

发布流程：

```text
validate draft form
validate active questions
validate logic graph
build AppFormManifestV1
hash schema_json
insert app_form_versions
update app_forms.published_version_id / latest_version_number / status
emit app_forms.form_published
```

`PAUSED` 表单保留已发布版本但 public manifest 不可访问。`ARCHIVED` 表单只能后台查看历史提交。

### 问题表

```text
app_form_questions
  id uuid primary key
  app_id uuid not null references apps(id)
  form_id uuid not null references app_forms(id)
  question_key varchar(80) not null
  block_key varchar(80) not null
  label varchar(180) not null
  description text null
  question_type varchar(40) not null
  placeholder varchar(200) null
  help_text varchar(300) null
  required boolean not null default false
  options_json jsonb not null default '[]'
  properties_json jsonb not null default '{}'
  validation_json jsonb not null default '{}'
  display_json jsonb not null default '{}'
  localization_json jsonb not null default '{}'
  answer_schema_json jsonb not null default '{}'
  sort_order integer not null default 0
  is_active boolean not null default true
  is_system boolean not null default false
  created_at timestamptz not null default now()
  updated_at timestamptz not null default now()

unique (form_id, question_key)
```

`block_key` 默认等于 `question_key`。保留独立字段是为了后续把 statement、welcome、分组、结束页统一纳入 block graph。

### 逻辑规则表

```text
app_form_logic_rules
  id uuid primary key
  app_id uuid not null references apps(id)
  form_id uuid not null references app_forms(id)
  rule_key varchar(80) not null
  name varchar(160) null
  condition_json jsonb not null
  actions_json jsonb not null
  sort_order integer not null default 0
  is_active boolean not null default true
  created_at timestamptz not null default now()
  updated_at timestamptz not null default now()

unique (form_id, rule_key)
```

条件和动作均使用受控 JSON DSL。不要把规则塞进问题表，避免复杂表单里问题编辑和全局跳转规则互相污染。

### 提交表

```text
app_form_responses
  id uuid primary key
  app_id uuid not null references apps(id)
  form_id uuid not null references app_forms(id)
  form_version_id uuid not null references app_form_versions(id)
  version_number integer not null
  user_id uuid null references users(id)
  respondent_key varchar(160) null
  status varchar(24) not null default 'new'
  completion_status varchar(24) not null default 'submitted'
  answers_json jsonb not null default '{}'
  normalized_json jsonb not null default '{}'
  hidden_fields_json jsonb not null default '{}'
  variables_json jsonb not null default '{}'
  attribution_json jsonb not null default '{}'
  client_json jsonb not null default '{}'
  timing_json jsonb not null default '{}'
  score numeric null
  nps_bucket varchar(20) null
  ending_key varchar(80) null
  embed_origin varchar(300) null
  landing_path varchar(500) null
  referrer text null
  session_id varchar(128) null
  idempotency_key varchar(160) null
  ip_hash varchar(128) null
  user_agent varchar(512) null
  admin_note text null
  submitted_at timestamptz not null default now()
  created_at timestamptz not null default now()
  updated_at timestamptz not null default now()
```

`respondent_key` 用于匿名场景，可以取 email hash、phone hash、session id 或 app 传入的 stable anonymous id。

`completion_status` 枚举：

```text
submitted
partial
screened_out
abandoned
```

第一版 public API 只主动创建 `submitted`，但表结构预留 `partial`，用于后续 in-app trigger、离线恢复和条件跳转导致的提前结束。

### 答案明细表

为避免所有统计都扫 JSONB，第一版写 response 时同步展开 answer items：

```text
app_form_answer_items
  id uuid primary key
  app_id uuid not null references apps(id)
  form_id uuid not null references app_forms(id)
  form_version_id uuid not null references app_form_versions(id)
  response_id uuid not null references app_form_responses(id)
  question_id uuid null references app_form_questions(id) on delete set null
  question_key varchar(80) not null
  question_type varchar(40) not null
  question_snapshot_json jsonb not null default '{}'
  value_text text null
  value_number numeric null
  value_boolean boolean null
  value_json jsonb null
  created_at timestamptz not null default now()
```

### 提交后动作表

第一版不做复杂 automation builder，但要预留可配置的提交后动作：

```text
app_form_actions
  id uuid primary key
  app_id uuid not null references apps(id)
  form_id uuid not null references app_forms(id)
  action_key varchar(80) not null
  action_type varchar(40) not null
  enabled boolean not null default true
  trigger_json jsonb not null default '{}'
  config_json jsonb not null default '{}'
  created_by_user_id uuid null references users(id)
  created_at timestamptz not null default now()
  updated_at timestamptz not null default now()

unique (form_id, action_key)
```

`action_type` 第一版支持：

```text
notification
webhook
connector_sync
ai_enrichment
```

执行方式：

```text
app_forms.response_created event
  -> platform task
  -> match app_form_actions
  -> execute notification / webhook / connector / AI
  -> write task events and action result
```

Webhook 必须有超时、重试、签名和失败记录：

```text
X-OPG-Event: app_forms.response_created
X-OPG-Delivery: <delivery_id>
X-OPG-Signature: sha256=<hmac>
```

### 兼容 acquisition 表

现有表继续保留：

```text
app_acquisition_source_options
user_acquisition_sources
user_acquisition_source_events
```

用户来源系统表单的 `source_select` 继续读取 `app_acquisition_source_options`。提交时根据是否有 `user_id` 同步旧表。

### Indexes

```text
idx_app_forms_app_status_updated
  (app_id, status, updated_at desc)

idx_app_forms_app_kind
  (app_id, kind, status)

idx_app_form_questions_form_order
  (form_id, is_active, sort_order, created_at)

idx_app_form_responses_form_time
  (form_id, submitted_at desc)

idx_app_form_responses_form_version
  (form_id, form_version_id, submitted_at desc)

idx_app_form_responses_app_time
  (app_id, submitted_at desc)

idx_app_form_responses_user_time
  (app_id, user_id, submitted_at desc)

idx_app_form_responses_nps
  (app_id, form_id, nps_bucket, submitted_at desc)

idx_app_form_answer_items_question_text
  (app_id, form_id, question_key, value_text)

idx_app_form_answer_items_question_number
  (app_id, form_id, question_key, value_number)

idx_app_form_logic_rules_form_order
  (form_id, is_active, sort_order, created_at)

idx_app_form_actions_form_enabled
  (form_id, enabled, action_type)

unique nullable idempotency:
  (app_id, form_id, idempotency_key) where idempotency_key is not null
```

## API 设计

### Public manifest

```text
GET /:app/v1/forms/:form_key/manifest
```

Response:

```json
{
  "schema_version": "app_form_manifest_v1",
  "app": {
    "slug": "demo",
    "name": "Demo App",
    "brand_name": "Demo"
  },
  "form": {
    "id": "...",
    "form_key": "nps",
    "name": "NPS 打分",
    "kind": "NPS",
    "published_version_id": "...",
    "version_number": 3,
    "title": "你有多大可能把我们推荐给朋友或同事？",
    "subtitle": "",
    "submit_label": "提交",
    "success_title": "已提交",
    "success_message": "感谢你的反馈"
  },
  "blocks": [
    {
      "block_key": "nps_score",
      "type": "question",
      "question": {
        "question_key": "nps_score",
        "label": "你有多大可能把我们推荐给朋友或同事？",
        "question_type": "nps",
        "required": true,
        "validation": {
          "min": 0,
          "max": 10
        }
      }
    }
  ],
  "hidden_fields": [
    { "key": "utm_source", "source": "query" }
  ],
  "variables": [],
  "logic": [],
  "endings": [
    {
      "ending_key": "default",
      "type": "message",
      "title": "已提交",
      "message": "感谢你的反馈"
    }
  ],
  "theme": {
    "primary_color": "#111827",
    "radius": 8,
    "mode": "light"
  },
  "behavior": {
    "allow_anonymous": true,
    "require_auth": false,
    "captcha_mode": "OFF"
  }
}
```

Caching:

- `Cache-Control: public, max-age=60, stale-while-revalidate=300`
- `ETag` 基于 `published_version_id` 和 `schema_hash`。用户来源表单如果绑定 source options，source option 变更必须触发系统表单重新 publish，不能靠 public request 临时拼装。

### Public submit

```text
POST /:app/v1/forms/:form_key/responses
Authorization: Bearer <optional-user-token>
Idempotency-Key: <optional>
```

NPS request:

```json
{
  "published_version_id": "...",
  "answers": {
    "nps_score": 9,
    "nps_reason": "产品帮我节省了很多时间",
    "contact_permission": true
  },
  "attribution": {
    "landing_path": "/settings",
    "session_id": "s_123"
  },
  "client": {
    "surface": "desktop",
    "app_version": "1.2.0",
    "locale": "zh-CN"
  }
}
```

用户来源 request:

```json
{
  "version_number": 1,
  "answers": {
    "source_key": "xiaohongshu",
    "free_text": "",
    "email": "user@example.com",
    "name": "User"
  },
  "attribution": {
    "utm_source": "xhs",
    "utm_medium": "social",
    "utm_campaign": "launch",
    "landing_path": "/pricing",
    "referrer": "https://example.com/post/123",
    "session_id": "s_123"
  }
}
```

Response:

```json
{
  "message": "表单已提交",
  "item": {
    "id": "...",
    "form_key": "nps",
    "form_kind": "NPS",
    "published_version_id": "...",
    "version_number": 3,
    "user_id": null,
    "status": "new",
    "completion_status": "submitted",
    "score": 9,
    "nps_bucket": "promoter",
    "ending_key": "default",
    "submitted_at": "2026-06-22T00:00:00.000Z"
  },
  "user_bound": false
}
```

Validation rules:

- `form_key` 必须属于当前 app 且状态为 `ACTIVE`。
- `published_version_id` 或 `version_number` 必须匹配当前 published version；未传时默认当前 published version。
- `answers` 只接受 published manifest 内的问题 key。
- 必填问题必须提交。
- 不同 `question_type` 按对应规则清洗和校验。
- `source_select` 必须命中当前 app active source option。
- `source_select` 的 free text 只在 source option 允许时接受。
- `nps` 必须是 0 到 10 的整数。
- hidden fields 只接受 manifest 声明过的 key。
- logic 在后端重新执行一次，用于确认跳转、动态必填和 ending。
- `allowed_origins_json` 非空时，`Origin` / `Referer` 必须匹配。
- `require_auth = true` 时没有有效 token 直接拒绝。
- `allow_anonymous = false` 时没有有效 token 直接拒绝。
- `one_response_per_user = true` 时同一 `user_id` 或 `respondent_key` 只能保留一条有效提交。
- rate limit、honeypot 命中时写入安全日志，不写入正常 response。

### Admin forms list

```text
GET /api/v1/platform-admin/apps/:app_id/forms
```

Query:

```text
kind
status
q
page
page_size
```

Response:

```json
{
  "total": 2,
  "items": [
    {
      "id": "...",
      "form_key": "user_source",
      "name": "用户来源",
      "kind": "ACQUISITION_SOURCE",
      "is_system": true,
      "status": "ACTIVE",
      "response_count": 123,
      "last_response_at": "2026-06-22T02:30:00.000Z",
      "hosted_url": "https://opg.example.com/demo/forms/user_source"
    },
    {
      "id": "...",
      "form_key": "nps",
      "name": "NPS 打分",
      "kind": "NPS",
      "is_system": true,
      "status": "ACTIVE",
      "response_count": 48,
      "last_response_at": "2026-06-22T01:10:00.000Z",
      "hosted_url": "https://opg.example.com/demo/forms/nps"
    }
  ]
}
```

### Create form

```text
POST /api/v1/platform-admin/apps/:app_id/forms
```

Request:

```json
{
  "name": "产品调研",
  "form_key": "product_survey",
  "kind": "CUSTOM",
  "title": "产品调研",
  "allow_anonymous": true
}
```

创建规则：

- `form_key` 可由 name 自动生成。
- 新建表单默认是 `DRAFT`，需要 publish 后 public manifest 才可访问。
- `CUSTOM` 表单可删除。
- 系统表单不可删除，只能暂停或恢复。
- 每个 app 第一版最多 50 个表单。
- 每个表单第一版最多 50 个问题。

### Publish form

```text
POST /api/v1/platform-admin/apps/:app_id/forms/:form_id/publish
```

行为：

- 校验 active questions 至少 1 个可提交问题。
- 校验必填、选项、隐藏字段、变量和结束页。
- 校验 logic graph 不循环。
- 生成 `app_form_versions`。
- 更新 `published_version_id`。
- 返回 public manifest。

Response:

```json
{
  "message": "表单已发布",
  "item": {
    "form_id": "...",
    "published_version_id": "...",
    "version_number": 3,
    "schema_hash": "sha256:..."
  }
}
```

### Get / update form

```text
GET   /api/v1/platform-admin/apps/:app_id/forms/:form_id
PATCH /api/v1/platform-admin/apps/:app_id/forms/:form_id
```

PATCH 允许更新：

- name / title / subtitle / body_text
- submit_label / success_title / success_message
- status
- allow_anonymous / require_auth / one_response_per_user
- captcha_mode
- allowed_origins
- theme / layout / behavior / settings

系统表单限制：

- 不允许修改 `kind`。
- 不允许修改核心系统问题 key。
- 用户来源表单的 `source_key` 问题不能删除。
- NPS 表单的 `nps_score` 问题不能删除。

### Questions

```text
POST  /api/v1/platform-admin/apps/:app_id/forms/:form_id/questions
PATCH /api/v1/platform-admin/apps/:app_id/forms/:form_id/questions/:question_id
DELETE /api/v1/platform-admin/apps/:app_id/forms/:form_id/questions/:question_id
PUT   /api/v1/platform-admin/apps/:app_id/forms/:form_id/questions/reorder
```

新增问题 request:

```json
{
  "question_key": "usage_goal",
  "label": "你主要想用它解决什么问题？",
  "question_type": "single_select",
  "required": true,
  "options": [
    { "value": "work", "label": "工作效率" },
    { "value": "study", "label": "学习" },
    { "value": "other", "label": "其他" }
  ],
  "sort_order": 30
}
```

### Logic rules

```text
POST   /api/v1/platform-admin/apps/:app_id/forms/:form_id/logic
PATCH  /api/v1/platform-admin/apps/:app_id/forms/:form_id/logic/:rule_id
DELETE /api/v1/platform-admin/apps/:app_id/forms/:form_id/logic/:rule_id
```

新增规则 request:

```json
{
  "rule_key": "show_team_size",
  "condition": {
    "all": [
      { "left": { "type": "answer", "key": "plan" }, "op": "equals", "right": "team" }
    ]
  },
  "actions": [
    { "type": "show", "target": "team_size" },
    { "type": "require", "target": "team_size" }
  ]
}
```

### Responses

```text
GET /api/v1/platform-admin/apps/:app_id/forms/:form_id/responses
```

Query:

```text
status
from
to
q
version_number
completion_status
page
page_size
```

```text
PATCH /api/v1/platform-admin/apps/:app_id/forms/:form_id/responses/:response_id
```

允许更新：

- `status`: `new` / `reviewed` / `archived` / `spam`
- `admin_note`

### Metrics

```text
GET /api/v1/platform-admin/apps/:app_id/forms/:form_id/metrics
```

通用返回：

```json
{
  "total": 120,
  "unique_users": 80,
  "anonymous": 40,
  "last_response_at": "2026-06-22T02:30:00.000Z"
}
```

NPS 表单额外返回：

```json
{
  "nps": {
    "score": 42,
    "promoters": 70,
    "passives": 30,
    "detractors": 20,
    "average_score": 8.1
  }
}
```

用户来源表单额外返回：

```json
{
  "acquisition": {
    "by_source": [
      {
        "source_key": "xiaohongshu",
        "source_label": "小红书",
        "responses": 42,
        "bound_users": 30
      }
    ]
  }
}
```

## 后端实现细节

### 模块组织

新增 `app-forms` 模块，不把通用表单继续塞进 `acquisition`：

```text
services/gateway/src/modules/app-forms
  app-forms.module.ts
  app-forms-public.controller.ts
  app-forms-platform.controller.ts
  app-forms.service.ts
  app-forms-seed.service.ts
  app-forms-publish.service.ts
  app-forms-manifest.service.ts
  app-forms-logic.service.ts
  app-forms-answer-normalizer.ts
  app-forms-response-pipeline.service.ts
  app-forms-types.ts
  app-forms-validation.ts
```

`acquisition` 模块保留现有 API 和服务，并被 `app-forms` 的用户来源系统表单调用。

### Seed 策略

每个 app 都必须拥有两个系统表单。推荐懒加载补齐：

```text
list forms / get form / public manifest
  -> ensureDefaultForms(app_id)
  -> upsert user_source form
  -> upsert nps form
  -> upsert required system questions
  -> if no published version, publish initial system manifest
```

不要只在 app create 时 seed。历史 app 也需要自动补齐。

### Publish 流程

```text
POST /api/v1/platform-admin/apps/:app_id/forms/:form_id/publish
  -> load draft form, questions, logic rules
  -> validate system form invariants
  -> validate question keys and option values
  -> validate hidden fields and variables
  -> validate endings
  -> validate logic references
  -> detect logic cycles
  -> build AppFormManifestV1
  -> stable stringify + sha256
  -> insert app_form_versions
  -> update app_forms.published_version_id
  -> write audit event
  -> return manifest
```

发布校验失败必须返回结构化错误：

```json
{
  "error": "form_publish_failed",
  "issues": [
    { "path": "logic[0].actions[1].target", "message": "目标问题不存在" }
  ]
}
```

### Submit 流程

```text
POST /:app/v1/forms/:form_key/responses
  -> resolve app
  -> resolve active form
  -> resolve published version
  -> resolve optional user from Authorization
  -> enforce origin policy
  -> enforce anonymous/auth policy
  -> validate idempotency
  -> load manifest schema_json
  -> normalize hidden fields / attribution / client payload
  -> evaluate logic
  -> normalize typed answers
  -> validate answers against manifest and dynamic required rules
  -> insert app_form_responses
  -> insert app_form_answer_items
  -> if form.kind = ACQUISITION_SOURCE:
       sync acquisition tables
  -> if form.kind = NPS:
       compute score and bucket
  -> emit app_forms.response_created event
  -> enqueue optional enrichment task
  -> return response
```

### Optional auth

Hosted forms must not depend on third-party iframe cookies. Use optional Bearer token:

```text
resolveOptionalUserFromAuthorization(app, authorizationHeader)
```

Rules:

- 没 token：匿名提交。
- token 有效：绑定 `user_id`。
- token 属于其他 app：拒绝。
- token 无效且 `require_auth = true`：拒绝。
- token 无效且允许匿名：按匿名处理或返回明确错误；推荐返回错误，避免宿主集成误判。

### System form adapters

`AppFormsService` 内部应按 `form.kind` 调用 adapter：

```text
CUSTOM
  -> 只写 form response / answer items

ACQUISITION_SOURCE
  -> 写 form response / answer items
  -> 同步 source_key 到 acquisition tables
  -> 输出 acquisition metrics

NPS
  -> 写 form response / answer items
  -> 计算 score / bucket
  -> 输出 NPS metrics
```

不要把 NPS 逻辑写进 acquisition 模块。

### Answer normalizer

每种题型必须有统一的 normalize 和 validate 函数：

```text
normalizeAnswer(question, rawValue)
  -> { value_text?, value_number?, value_boolean?, value_json?, normalized }
```

规则：

- text/email/url/phone：trim、长度限制、格式校验。
- number/rating/nps/opinion_scale：转 number，校验 min/max/step。
- single_select/source_select：存 option value，保留 label snapshot。
- multi_select：存有序 string array，去重，拒绝非法 option。
- boolean/consent：只接受 boolean。
- date：标准化为 `YYYY-MM-DD`。
- hidden：只从 manifest 声明来源读取，不从 answers 任意写入系统字段。

后端 normalizer 是真值，前端校验只做体验优化。

## 前端实现细节

### 工作区页面改名

`TenantWorkspace` 里当前 section：

```text
key: acquisition
label: 用户来源
desc: 来源选项与提交记录
```

目标：

```text
key: forms
label: 表单
desc: 用户来源、NPS 与自定义表单
```

兼容路由：

- 新 route 使用 `forms`。
- 旧 `acquisition` route redirect 到 `forms`。
- 权限暂时复用 `app.acquisition.read/write`，但执行时建议新增 `app.forms.read/write`，并让旧权限 alias 到新权限。

### 表单列表组件

建议新增组件：

```text
apps/web/src/pages/platform/components/TenantFormsPanel.tsx
```

职责：

- 加载 forms list。
- 展示系统表单和自定义表单。
- 创建自定义表单。
- 复制 hosted URL。
- 进入编辑页。

UI：

- 表格或紧凑列表。
- 不做大卡片。
- 系统表单用小标签标识。
- 顶部只放“新建表单”和“刷新”。

### 表单编辑组件

建议新增组件：

```text
apps/web/src/pages/platform/components/TenantFormEditor.tsx
```

职责：

- 编辑基本信息。
- 管理问题。
- 管理隐藏字段、变量、逻辑和结束页。
- 编辑样式。
- 保存 draft。
- 发布并生成 immutable manifest。
- 展示嵌入 URL。
- 查看 responses 和 metrics。

编辑器第一版不做复杂拖拽：

- 问题列表支持上移/下移。
- 每次选中一个问题编辑。
- 新增问题用菜单选择问题类型。
- 系统问题只允许改文案和样式，不允许删除。
- 逻辑编辑器使用条件行 + 动作行，不展示代码编辑器。
- 结束页只支持 message / redirect 两种。
- 发布前预览读取 preview manifest，正式嵌入读取 published manifest。

### Hosted form renderer

新增 route：

```text
/:appSlug/forms/:formKey
```

组件：

```text
apps/web/src/pages/forms/HostedFormShell.tsx
apps/web/src/pages/forms/AppHostedForm.tsx
```

要求：

- 不加载平台后台导航。
- 不加载大图表库。
- 首屏就是表单。
- 移动端优先。
- 通过 CSS variables 应用主题。
- 用 `postMessage` 上报高度和提交结果。
- 使用 manifest `blocks` 渲染，不直接读后台 draft。
- 本地执行一次条件显示、跳转、动态必填，提交时后端再执行一次。
- 支持 query/host 注入 hidden fields，例如 `utm_source`、`campaign`、`anonymous_id`。
- 预留 `localStorage` 草稿恢复接口，但第一版不开启自动 partial submit。

## 嵌入协议

### iframe

```html
<iframe
  id="opg-form-nps"
  src="https://opg.example.com/demo/forms/nps"
  style="width:100%;border:0"
  loading="lazy"
  referrerpolicy="strict-origin-when-cross-origin"
></iframe>
```

### Resize

```json
{
  "type": "opg:form:resize",
  "formKey": "nps",
  "height": 520
}
```

### Auth bridge

```json
{
  "type": "opg:auth",
  "accessToken": "..."
}
```

### Submitted

```json
{
  "type": "opg:form:submitted",
  "formKey": "nps",
  "responseId": "...",
  "userBound": true
}
```

## SDK / CLI / MCP 同步

该功能是平台产品能力变更，必须同步检查 SDK、CLI、MCP schema 和 `docs/CLI_USAGE.md`。

### SDK

新增：

```ts
platform.apps.forms = {
  list(appId, query?)
  create(appId, input)
  get(appId, formId)
  update(appId, formId, input)
  delete(appId, formId)
  duplicate(appId, formId)
  publish(appId, formId)
  previewManifest(appId, formId)
  versions(appId, formId)
  questions: {
    create(appId, formId, input)
    update(appId, formId, questionId, input)
    delete(appId, formId, questionId)
    reorder(appId, formId, input)
  }
  logic: {
    create(appId, formId, input)
    update(appId, formId, ruleId, input)
    delete(appId, formId, ruleId)
  }
  responses: {
    list(appId, formId, query?)
    get(appId, formId, responseId)
    update(appId, formId, responseId, input)
  }
  metrics(appId, formId, query?)
  actions: {
    list(appId, formId)
    create(appId, formId, input)
    update(appId, formId, actionId, input)
    delete(appId, formId, actionId)
  }
}
```

Public app-scoped SDK：

```ts
client.forms.manifest(formKey)
client.forms.submit(formKey, input)
```

### CLI

新增：

```bash
opg platform forms list --app-id <id>
opg platform forms create --app-id <id> --json '{...}'
opg platform forms get --app-id <id> --form-id <id>
opg platform forms update --app-id <id> --form-id <id> --json '{...}'
opg platform forms duplicate --app-id <id> --form-id <id>
opg platform forms publish --app-id <id> --form-id <id>
opg platform forms versions --app-id <id> --form-id <id>
opg platform forms questions add --app-id <id> --form-id <id> --json '{...}'
opg platform forms questions update --app-id <id> --form-id <id> --question-id <id> --json '{...}'
opg platform forms logic add --app-id <id> --form-id <id> --json '{...}'
opg platform forms logic update --app-id <id> --form-id <id> --rule-id <id> --json '{...}'
opg platform forms logic delete --app-id <id> --form-id <id> --rule-id <id>
opg platform forms responses list --app-id <id> --form-id <id>
opg platform forms metrics --app-id <id> --form-id <id>
opg platform forms actions list --app-id <id> --form-id <id>
opg platform forms actions create --app-id <id> --form-id <id> --json '{...}'
```

### MCP tools

新增：

```text
opg_platform_app_forms_list
opg_platform_app_form_create
opg_platform_app_form_get
opg_platform_app_form_update
opg_platform_app_form_duplicate
opg_platform_app_form_publish
opg_platform_app_form_versions
opg_platform_app_form_question_create
opg_platform_app_form_question_update
opg_platform_app_form_question_delete
opg_platform_app_form_logic_create
opg_platform_app_form_logic_update
opg_platform_app_form_logic_delete
opg_platform_app_form_responses_list
opg_platform_app_form_metrics
opg_platform_app_form_actions_list
opg_platform_app_form_action_create
opg_platform_app_form_action_update
opg_platform_app_form_action_delete
```

MCP 描述要明确：

- 这是 app-scoped hosted forms。
- 内置 `user_source` 和 `nps`。
- 不是通用页面搭建器。

## AI 能力

AI 不进入同步提交主链路。表单提交必须快速、稳定、可离线重试。

推荐作为异步增强：

```text
form response created
  -> platform task
  -> AI classify / score / summarize
  -> write enrichment_json
  -> optional notification / connector sync
```

可做能力：

- 用户来源线索评分。
- 自定义表单摘要。
- NPS 原因分类。
- NPS detractor 自动提取问题标签。
- 重复线索合并建议。
- 高价值提交触发通知。

实现要求：

- 复用现有 AI Gateway 和 platform tasks。
- AI 失败不影响提交。
- AI 输出必须标记模型、版本、时间和置信度。
- 不允许浏览器端直接调用第三方 AI provider。

## 视频 / 媒体能力

第一版不做视频处理。表单是轻量数据入口，视频上传或转码会显著增加复杂度。

允许：

- logo 图片。
- header/banner 图片。
- 图片必须走现有 upload 模块或 public asset URL。

暂不支持：

- 表单内视频上传。
- 用户提交视频作为答案。
- hosted form 背景视频。
- AI 视频生成。

如果未来确实需要媒体型表单，应复用现有 upload + async video gateway，不在 forms 模块里自建视频处理。

## 必须用现成库和必须自研的部分

| 能力 | 采用方式 | 原因 |
| --- | --- | --- |
| JSON schema 校验 | 使用已有 `ajv` | 表单问题 validation 适合结构化校验 |
| 后端 DTO 基础校验 | 使用已有 `class-validator` | 与 NestJS 现有栈一致 |
| HTML 清洗 | 使用已有 `sanitize-html`，但第一版尽量不开放富文本 | 避免 XSS |
| HMAC / hash | 使用 Node `crypto` | schema hash、webhook 签名、IP hash 不需要第三方库 |
| 认证 token | 使用已有 Nest/JWT/passport 体系 | 统一 app 用户身份 |
| 异步提交后动作 | 使用现有 platform tasks / queue | AI、通知、webhook 失败不能影响提交 |
| iframe 高度 | 自研 `postMessage` 协议 | 极小协议，不需要第三方库 |
| 表单渲染 | 自研轻量 React renderer | 字段类型有限，避免引入大型 form builder |
| 表单逻辑 DSL | 自研受控 JSON DSL | 只支持安全动作，不执行用户 JS |
| 拖拽字段排序 | 第一版不做；后续如需要再评估 `dnd-kit` | 降低 UI 复杂度 |
| 反垃圾验证码 | 后续用 Cloudflare Turnstile | 不自研验证码 |
| AI 评分 | 复用 OPG AI Gateway，自研任务协议和结果入库 | 保持 provider/计费/审计边界 |
| 视频处理 | 复用 upload / video gateway，第一版不做 | 避免基础表单变重 |
| 表单模型、提交、统计 | 自研 | 这是 OPG app-scoped 真值能力 |
| SDK/CLI/MCP | 自研同步 | 必须跟 OPG 控制面一致 |

明确不作为 runtime 依赖：

- Formbricks：可参考 app survey lifecycle 和 response pipeline，不直接嵌入。
- HeyForm：可参考 field taxonomy、answer utils 和逻辑跳转，不直接嵌入。
- Form.io：可参考 schema/component 思路，不启用其自定义 JS/CSS 低代码 runtime。
- SurveyJS：可参考 question factory、trigger 和 validator，不引入完整 survey engine。

## 安全与隐私

### XSS

- 表头文案默认纯文本。
- 样式只允许受控字段：颜色、圆角、logo URL、mode。
- 不允许自定义 CSS / JS。
- 后续如支持富文本，必须 `sanitize-html` 白名单。

### CSRF / iframe

- public submit 不依赖 cookie，所以 CSRF 面较小。
- 已登录绑定通过 Bearer token 或 host `postMessage`。
- `allowed_origins` 非空时严格校验 `Origin`。
- hosted page 按 allowed origins 设置 `Content-Security-Policy: frame-ancestors ...`。

### PII

- email、phone、name 和 answers 可能是 PII，应只在有 forms read 权限的后台显示。
- IP 只存 hash，不存明文。
- user agent 截断。
- `answers_json` 不允许字段 key 伪装成系统字段。

### 滥用控制

- submission rate limit。
- honeypot。
- idempotency。
- 后台可把 response 标记为 spam。
- 高风险 app 可启用 Turnstile。

## 性能策略

### Manifest

- manifest 可缓存 60 秒。
- ETag 减少重复下载。
- ETag 使用 `published_version_id + schema_hash`。
- 发布版本的 `schema_json` 是单行读取，不在 public request 中重新拼装 draft。
- 后端查询 form、published version、source options 可并发。
- 普通表单 public manifest 只读 form + published version；`source_select` 系统表单在 source option 更新时自动重新 publish。
- hosted form renderer 不加载平台后台重组件。
- 每个 app/form_key 可以加 Redis 短缓存，publish 后按 form id 清理。

### Submit

- 同步路径只做校验、写库、轻通知。
- AI 评分、connector sync、邮件通知进入 task queue。
- idempotency 避免重复点击产生多条记录。
- 后端 logic evaluator 只处理 manifest 中的受控 DSL，禁止递归执行超过 50 条规则。
- answers normalize 一次后同时写 `answers_json`、`normalized_json` 和 `app_form_answer_items`。
- 单次 payload 限制：
  - answers JSON 最大 16KB。
  - hidden fields 最大 4KB。
  - attribution/client 最大 4KB。
  - 单个 long_text 最大 2000 chars。
  - 单个 short_text 最大 240 chars。
  - questions 第一版最多 50 个。
  - logic rules 第一版最多 50 条。

### Admin list

- responses 分页，默认 20，最大 100。
- 查询走 `(app_id, submitted_at desc)`、`(form_id, submitted_at desc)`。
- NPS 和选择题统计优先读 `app_form_answer_items`。
- 版本筛选走 `(form_id, form_version_id, submitted_at desc)`。
- 数据量大后新增 daily rollup：

```text
app_form_daily_stats
  app_id
  form_id
  question_key
  date
  response_count
  unique_users
  value_buckets_json
```

## 观测与事件

新增事件：

```text
app_forms.form_created
app_forms.form_updated
app_forms.form_deleted
app_forms.form_published
app_forms.question_created
app_forms.question_updated
app_forms.logic_updated
app_forms.response_created
app_forms.response_reviewed
app_forms.response_marked_spam
app_forms.action_succeeded
app_forms.action_failed
app_forms.nps_detractor_created
app_forms.acquisition_source_created
```

记录到：

- admin notifications：重要提交、NPS detractor、用户来源线索可通知。
- observability request events：API 成功/失败、耗时、status。
- audit events：后台配置变更、response 状态变更。
- platform tasks：AI enrichment / connector sync。

## 执行计划

要求保持 atomic commits，一个提交只做一件事。

### Commit 1: App Forms 后端模型和系统表单 seed

范围：

- 新增 `app-forms` module。
- 新增 migration：`app_forms`、`app_form_versions`、`app_form_questions`、`app_form_logic_rules`、`app_form_responses`、`app_form_answer_items`、`app_form_actions`。
- 新增 default forms seed：`user_source`、`nps`。
- 新增 form list/get/create/update/question CRUD。
- 新增 logic CRUD 和 endings/hidden fields/variables 的 form settings 更新。
- 补 permission：建议新增 `app.forms.read`、`app.forms.write`，并让旧 `app.acquisition.*` 兼容。

验收：

- `npm --prefix services/gateway run build`
- API smoke：
  - list forms 自动出现两个系统表单。
  - create custom form。
  - add question。
  - add logic rule。
  - get form detail。

### Commit 2: Publish 和 versioned manifest

范围：

- `GET /:app/v1/forms/:form_key/manifest`
- `GET /api/v1/platform-admin/apps/:app_id/forms/:form_id/preview-manifest`
- `POST /api/v1/platform-admin/apps/:app_id/forms/:form_id/publish`
- `GET /api/v1/platform-admin/apps/:app_id/forms/:form_id/versions`
- publish validator。
- manifest builder。
- logic graph validation。
- ETag / Cache-Control。

验收：

- 系统表单自动有初始 published version。
- 自定义表单 publish 后可获取 public manifest。
- 无效 logic target 发布失败。
- 循环跳转发布失败。
- 编辑 draft 不改变已发布 manifest。

### Commit 3: Public submit runtime

范围：

- `POST /:app/v1/forms/:form_key/responses`
- optional auth。
- origin policy。
- answer validation。
- hidden fields / attribution / client normalize。
- server-side logic evaluator。
- idempotency。
- NPS score / bucket。
- 用户来源 adapter 同步旧 acquisition 表。
- response_created event。

验收：

- 匿名提交 custom form。
- 匿名提交 NPS。
- 带 token 提交 NPS。
- 带 token 提交 user_source 并写入 `user_acquisition_sources`。
- invalid origin 被拒绝。
- duplicate idempotency 不重复入库。
- 提交绑定正确 `form_version_id`。
- 后端动态必填生效。

### Commit 4: Web 表单页面、编辑器和 hosted renderer

范围：

- `TenantWorkspace` nav 从“用户来源”改为“表单”。
- 新增 forms list 首页。
- 新增 form editor。
- 新增 logic/endings/hidden fields/variables 编辑。
- 新增 publish/preview UI。
- 旧 acquisition route redirect 到 forms。
- hosted form route `/\:appSlug/forms/:formKey`。
- iframe resize / submitted postMessage。
- renderer 使用 published manifest blocks。

验收：

- `npm --prefix apps/web run build`
- 表单页首屏是列表。
- 默认有“用户来源”和“NPS 打分”。
- 点击进入编辑页。
- 可新增自定义表单和问题。
- 可配置简单条件显示和跳转。
- 可发布表单并预览 published manifest。
- hosted URL 可提交。
- mobile viewport 不溢出。

### Commit 5: 用户来源兼容、NPS metrics 和 response pipeline

范围：

- 旧“用户来源”统计迁移到 forms 页面中的用户来源系统表单详情。
- 保留现有 acquisition summary/users API。
- 新增 NPS metrics panel。
- 提交记录统一从 form responses 展示。
- 新增 app_form_actions 执行器。
- notification / webhook / connector_sync / ai_enrichment 进入 platform tasks。

验收：

- 用户来源旧统计仍可读。
- forms 页面能看到用户来源提交和来源分布。
- NPS 表单能看到 score、promoters、passives、detractors。
- webhook action 失败不会影响表单提交。
- AI enrichment 失败不会影响表单提交。

### Commit 6: SDK / CLI / MCP / docs 同步

范围：

- `packages/sdk` 增加 forms API。
- `packages/cli` 增加 `opg platform forms ...`。
- MCP tools 增加 app forms 管理和查询工具。
- 更新 `docs/CLI_USAGE.md`、`packages/sdk/README.md`、`packages/cli/README.md`。
- 刷新模块文档。

验收：

- `npm run sdk:build`
- `npm run cli:build`
- CLI smoke：
  - `opg platform forms list --app-id <id>`
  - `opg platform forms metrics --app-id <id> --form-id <id>`
- MCP tools list 包含新增工具。

## 不做项

第一版明确不做：

- 通用页面搭建器。
- 拖拽式复杂 form builder。
- 自定义 CSS / JS。
- 文件上传。
- 支付表单。
- 签名表单。
- 矩阵题和排序题。
- 视频上传或视频处理。
- 多步骤漏斗表单。
- 任意脚本式复杂跳题逻辑。
- 浏览器端 AI provider 调用。
- 用 iframe cookie 作为唯一登录方案。

## 验收清单

- app 工作区页面名是“表单”。
- 打开“表单”先看到表单列表。
- 每个 app 默认有“用户来源”和“NPS 打分”两个系统表单。
- 可以创建自定义表单。
- 可以给表单添加多种问题类型。
- 可以保存 draft 并发布 immutable manifest。
- 可以配置条件显示、简单跳题、动态必填和结束页。
- 点击表单进入编辑页。
- hosted URL 可被网页 app、手机 app、桌面 app 嵌入。
- 表单可匿名提交，也可带 token 绑定当前用户。
- 每条提交绑定发布版本，后续编辑不破坏历史提交。
- 用户来源系统表单继续同步现有 acquisition 真值表。
- NPS 系统表单提供 NPS score 和 bucket 统计。
- 提交后通知、webhook、connector sync、AI enrichment 进入异步任务。
- SDK、CLI、MCP、`docs/CLI_USAGE.md` 同步更新。
- AI 增强是异步可选能力，不影响提交主链路。
- 视频处理不进入第一版。
