export type EmailSenderPurpose = 'marketing' | 'notification' | 'both';
export type EmailStatus = 'ACTIVE' | 'INACTIVE';
export type EmailContactStatus = 'subscribed' | 'unsubscribed' | 'bounced' | 'suppressed';
export type EmailCampaignStatus = 'draft' | 'scheduled' | 'sending' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface CloudflareEmailSendPayload {
  from: string | { address: string; name?: string };
  to: string[];
  subject: string;
  html?: string;
  text?: string;
  reply_to?: string;
  headers?: Record<string, string>;
}

export interface CloudflareEmailSendResult {
  success: boolean;
  result?: {
    delivered?: string[];
    queued?: string[];
    permanent_bounces?: string[];
  };
  errors?: Array<{ code?: string | number; message?: string }>;
}
