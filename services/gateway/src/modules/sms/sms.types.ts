export type SmsProviderType =
  | 'GENERIC_API'
  | 'ALIYUN_SMS'
  | 'TENCENT_SMS'
  | 'HUAWEI_SMS'
  | 'VOLCENGINE_SMS'
  | 'TWILIO_SMS'
  | 'VONAGE_SMS'
  | 'MESSAGEBIRD_SMS'
  | 'PLIVO_SMS'
  | 'AWS_SNS';

export type SmsDispatchMode = 'SYNC' | 'ASYNC';

export type SmsProviderRow = {
  id: string;
  provider_type: SmsProviderType;
  name: string;
  is_active: boolean;
  is_default: boolean;
  config_json: unknown;
  notes: string | null;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
};

export type SmsSignatureRow = {
  id: string;
  provider_id: string;
  sign_name: string;
  is_active: boolean;
  is_default: boolean;
  notes: string | null;
  meta_json: unknown;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
};

export type SmsTemplateRow = {
  id: string;
  provider_id: string;
  template_code: string;
  template_name: string | null;
  is_active: boolean;
  is_default: boolean;
  notes: string | null;
  meta_json: unknown;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
};

export type SmsRouteConfigResolved = {
  provider: SmsProviderRow;
  signature: SmsSignatureRow;
  template: SmsTemplateRow | null;
};

export type SmsSendPurpose = 'login' | 'register' | 'phone_bind' | 'test' | 'verification';

export type SmsDispatchResult = {
  ok: boolean;
  provider_message_id?: string | null;
  status_code?: number | null;
  response_code?: string | null;
  response_message?: string | null;
  request_url?: string | null;
  raw_response?: unknown;
};
