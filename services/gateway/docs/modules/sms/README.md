# SMS Module

## 1. 模块职责

`src/modules/sms` 是独立短信模块，负责验证码发送、供应商/签名/模板管理、App 级短信路由、发送审计和可观测日志。

Auth、Users、PlatformAdmin 不直接维护短信表或供应商协议，只通过 `SmsService` 调用：

- `sendSmsCode()`
- `sendSmsCodeForAppId()`
- `verifySmsCodeForAppId()`
- `sendSmsCodeForAppTest()`
- `listProviders()` / `createProvider()` / `updateProvider()` / `deleteProvider()`
- `listSignatures()` / `createSignature()` / `updateSignature()` / `deleteSignature()`
- `listTemplates()` / `createTemplate()` / `updateTemplate()` / `deleteTemplate()`
- `listEvents()` / `getSummary()`

## 2. 支持的供应商格式

中国大陆主流：

- `ALIYUN_SMS`
- `TENCENT_SMS`
- `HUAWEI_SMS`
- `VOLCENGINE_SMS`

海外主流：

- `TWILIO_SMS`
- `VONAGE_SMS`
- `MESSAGEBIRD_SMS`
- `PLIVO_SMS`
- `AWS_SNS`

通用扩展：

- `GENERIC_API`

## 3. 配置模型

供应商、签名、模板均在 Web 的平台短信服务页维护，不依赖环境变量。

App 工作区通过 `app_settings.extra_json` 保存短信路由引用：

- `sms_provider_ref_id`
- `sms_signature_ref_id`
- `sms_template_ref_id`

路由解析顺序：

1. 优先使用 App 显式选择的供应商、签名、模板。
2. 未选择模板时，使用该供应商默认启用模板。
3. 未选择签名时，使用该供应商默认启用签名。
4. 未选择供应商时，使用平台默认启用供应商。
5. 模板和签名必须属于最终选中的供应商，否则拒绝发送。

## 4. 数据表

- `platform_sms_providers`
- `platform_sms_signatures`
- `platform_sms_templates`
- `auth_sms_verification_codes`
- `platform_sms_message_events`

`platform_sms_message_events` 同时记录发送事件和配置审计事件。手机号只保存 hash 和脱敏值。

## 5. 可观测性

平台接口：

- `GET /platform-admin/sms/provider-catalog`
- `GET /platform-admin/sms/events`
- `GET /platform-admin/sms/summary`

发送事件记录：

- trace id
- app id
- purpose
- provider/signature/template
- dispatch mode
- status
- provider response code/message id
- duration
- error json

## 6. 模板说明

国内供应商通常使用服务商审批后的 `template_code`。

海外文本型供应商可在模板 `meta.message_template` 配置短信正文，例如：

```text
Your verification code is {{code}}.
```

模板变量存放在 `meta.variables_example`。需要固定参数顺序的供应商可通过 `meta.variable_order` 控制参数数组顺序。
