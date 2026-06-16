import { BadRequestException, Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { PRISMA_CLIENT } from '../../config/database.module';
import { CloudflareEmailService } from './cloudflare-email.service';

type Row = Record<string, any>;
const EMAIL_DELIVERY_BATCH_SIZE = 20;
const EMAIL_MAX_ATTEMPTS = 4;
const EMAIL_MAX_CAMPAIGN_RECIPIENTS = 5000;

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

@Injectable()
export class EmailDeliveryService implements OnModuleInit {
  private readonly logger = new Logger(EmailDeliveryService.name);
  private schemaReady = false;
  private schemaPromise: Promise<void> | null = null;
  private processing = false;

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    private readonly cloudflareEmail: CloudflareEmailService,
  ) {}

  async onModuleInit() {
    try {
      await this.ensureSchema();
    } catch (error: any) {
      this.logger.warn(`email delivery startup warmup failed: ${error?.message || error}`);
    }
  }

  async listCloudflareAccounts() {
    await this.ensureSchema();
    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT id, name, account_id, status, notes, last_verified_at, created_at, updated_at
      FROM email_cf_accounts
      ORDER BY updated_at DESC
    `;
    return { items: rows };
  }

  async verifyCloudflareToken(payload: unknown) {
    const body = asObject(payload);
    const token = this.requiredString(body.api_token || body.apiToken, 'api_token', 2048);
    const tokenStatus = await this.cloudflareEmail.verifyToken(token);
    const accounts = await this.safeListCloudflareAccounts(token);
    return {
      ok: true,
      token: tokenStatus.result || {},
      accounts: accounts.map((account) => ({
        id: account.id,
        name: account.name,
        type: account.type || null,
      })),
    };
  }

  async createCloudflareAccount(actorUserId: string, payload: unknown) {
    await this.ensureSchema();
    const body = asObject(payload);
    const token = this.requiredString(body.api_token || body.apiToken, 'api_token', 2048);
    const selectedAccountId = this.optionalCloudflareAccountId(body.account_id || body.accountId);
    const verified = await this.resolveCloudflareAccountFromToken(token, selectedAccountId);
    const accountId = verified.id;
    const name = this.optionalString(body.name, 120) || verified.name;
    const notes = this.optionalString(body.notes, 4000);
    const status = this.normalizeActiveStatus(body.status);
    const ciphertext = this.encryptSecret(token);

    const rows = await this.prisma.$queryRaw<Row[]>`
      INSERT INTO email_cf_accounts (name, account_id, api_token_ciphertext, status, notes, created_by_user_id)
      VALUES (${name}, ${accountId}, ${ciphertext}, ${status}, ${notes}, ${actorUserId}::uuid)
      ON CONFLICT (account_id) DO UPDATE SET
        name = EXCLUDED.name,
        api_token_ciphertext = EXCLUDED.api_token_ciphertext,
        status = EXCLUDED.status,
        notes = EXCLUDED.notes,
        updated_at = now()
      RETURNING id, name, account_id, status, notes, last_verified_at, created_at, updated_at
    `;
    return rows[0];
  }

  async updateCloudflareAccount(accountUuid: string, payload: unknown) {
    await this.ensureSchema();
    const account = await this.getCloudflareAccountSecret(accountUuid);
    const body = asObject(payload);
    const rawToken = body.api_token || body.apiToken ? this.requiredString(body.api_token || body.apiToken, 'api_token', 2048) : null;
    const verified = rawToken
      ? await this.resolveCloudflareAccountFromToken(rawToken, this.optionalCloudflareAccountId(body.account_id || body.accountId))
      : null;
    const name = this.optionalString(body.name, 120) ?? verified?.name ?? account.name;
    const accountId = verified?.id ?? this.optionalCloudflareAccountId(body.account_id || body.accountId) ?? account.account_id;
    const notes = body.notes === undefined ? account.notes : this.optionalString(body.notes, 4000);
    const status = body.status === undefined ? account.status : this.normalizeActiveStatus(body.status);
    const ciphertext = rawToken ? this.encryptSecret(rawToken) : account.api_token_ciphertext;

    const rows = await this.prisma.$queryRaw<Row[]>`
      UPDATE email_cf_accounts
      SET name = ${name}, account_id = ${accountId}, api_token_ciphertext = ${ciphertext}, status = ${status}, notes = ${notes}, updated_at = now()
      WHERE id = ${accountUuid}::uuid
      RETURNING id, name, account_id, status, notes, last_verified_at, created_at, updated_at
    `;
    if (!rows[0]) throw new NotFoundException('cloudflare account not found');
    return rows[0];
  }

  async deleteCloudflareAccount(accountUuid: string) {
    await this.ensureSchema();
    await this.prisma.$executeRaw`DELETE FROM email_cf_accounts WHERE id = ${accountUuid}::uuid`;
    return { deleted: true };
  }

  async testCloudflareAccount(accountUuid: string) {
    await this.ensureSchema();
    const account = await this.getCloudflareAccountSecret(accountUuid);
    const tokenStatus = await this.cloudflareEmail.verifyToken(this.decryptSecret(account.api_token_ciphertext));
    await this.prisma.$executeRaw`UPDATE email_cf_accounts SET last_verified_at = now(), updated_at = now() WHERE id = ${accountUuid}::uuid`;
    return { ok: true, token: tokenStatus.result || {} };
  }

  async listCloudflareSendingDomains(accountUuid: string) {
    await this.ensureSchema();
    const account = await this.getCloudflareAccountSecret(accountUuid);
    try {
      const items = await this.cloudflareEmail.listSendingDomains(
        account.account_id,
        this.decryptSecret(account.api_token_ciphertext),
      );
      return { items };
    } catch (error: any) {
      this.logger.warn(`cloudflare sending domain discovery failed for ${account.account_id}: ${error?.message || error}`);
      return {
        items: [],
        warning: 'cloudflare sending domain discovery failed',
      };
    }
  }

  async listSenders(appId?: string) {
    await this.ensureSchema();
    const rows = appId
      ? await this.prisma.$queryRaw<Row[]>`
          SELECT s.*, a.name AS cf_account_name, app.slug AS app_slug, app.name AS app_name
          FROM email_senders s
          JOIN email_cf_accounts a ON a.id = s.cf_account_id
          LEFT JOIN apps app ON app.id = s.app_id
          WHERE s.app_id IS NULL OR s.app_id = ${appId}::uuid
          ORDER BY s.updated_at DESC
        `
      : await this.prisma.$queryRaw<Row[]>`
          SELECT s.*, a.name AS cf_account_name, app.slug AS app_slug, app.name AS app_name
          FROM email_senders s
          JOIN email_cf_accounts a ON a.id = s.cf_account_id
          LEFT JOIN apps app ON app.id = s.app_id
          ORDER BY s.updated_at DESC
        `;
    return { items: rows };
  }

  async createSender(actorUserId: string, payload: unknown) {
    await this.ensureSchema();
    const body = asObject(payload);
    const cfAccountId = this.requiredString(body.cf_account_id || body.cfAccountId, 'cf_account_id', 80);
    const email = this.requiredEmail(body.email);
    const displayName = this.optionalString(body.display_name || body.displayName, 160);
    const domain = email.split('@')[1];
    const purpose = this.normalizePurpose(body.purpose);
    const status = this.normalizeActiveStatus(body.status);
    const appId = this.optionalUuid(body.app_id || body.appId);
    const isDefault = Boolean(body.is_default || body.isDefault);

    const rows = await this.prisma.$queryRaw<Row[]>`
      INSERT INTO email_senders (cf_account_id, app_id, email, display_name, domain, purpose, status, is_default, created_by_user_id)
      VALUES (${cfAccountId}::uuid, ${appId}::uuid, ${email}, ${displayName}, ${domain}, ${purpose}, ${status}, ${isDefault}, ${actorUserId}::uuid)
      ON CONFLICT (LOWER(email)) DO UPDATE SET
        cf_account_id = EXCLUDED.cf_account_id,
        app_id = EXCLUDED.app_id,
        display_name = EXCLUDED.display_name,
        domain = EXCLUDED.domain,
        purpose = EXCLUDED.purpose,
        status = EXCLUDED.status,
        is_default = EXCLUDED.is_default,
        updated_at = now()
      RETURNING *
    `;
    return rows[0];
  }

  async updateSender(senderId: string, payload: unknown) {
    await this.ensureSchema();
    const current = await this.getSender(senderId);
    const body = asObject(payload);
    const cfAccountId = this.optionalUuid(body.cf_account_id || body.cfAccountId) || current.cf_account_id;
    const email = body.email === undefined ? current.email : this.requiredEmail(body.email);
    const displayName = body.display_name === undefined && body.displayName === undefined ? current.display_name : this.optionalString(body.display_name || body.displayName, 160);
    const domain = email.split('@')[1];
    const purpose = body.purpose === undefined ? current.purpose : this.normalizePurpose(body.purpose);
    const status = body.status === undefined ? current.status : this.normalizeActiveStatus(body.status);
    const appId = body.app_id === undefined && body.appId === undefined ? current.app_id : this.optionalUuid(body.app_id || body.appId);
    const isDefault = body.is_default === undefined && body.isDefault === undefined ? current.is_default : Boolean(body.is_default || body.isDefault);

    const rows = await this.prisma.$queryRaw<Row[]>`
      UPDATE email_senders
      SET cf_account_id = ${cfAccountId}::uuid,
          app_id = ${appId}::uuid,
          email = ${email},
          display_name = ${displayName},
          domain = ${domain},
          purpose = ${purpose},
          status = ${status},
          is_default = ${isDefault},
          updated_at = now()
      WHERE id = ${senderId}::uuid
      RETURNING *
    `;
    if (!rows[0]) throw new NotFoundException('email sender not found');
    return rows[0];
  }

  async deleteSender(senderId: string) {
    await this.ensureSchema();
    await this.prisma.$executeRaw`DELETE FROM email_senders WHERE id = ${senderId}::uuid`;
    return { deleted: true };
  }

  async testSender(senderId: string, payload: unknown) {
    await this.ensureSchema();
    const body = asObject(payload);
    const to = this.requiredEmail(body.to || body.email);
    const sender = await this.getSenderWithAccount(senderId);
    await this.sendWithSender(sender, to, {
      subject: 'Email sender test',
      html: '<p>Email sender test.</p>',
      text: 'Email sender test.',
    });
    await this.prisma.$executeRaw`UPDATE email_senders SET last_tested_at = now(), updated_at = now() WHERE id = ${senderId}::uuid`;
    return { ok: true };
  }

  async sendAppNotificationEmail(appId: string, to: string, message: { subject: string; html?: string; text?: string }) {
    await this.ensureSchema();
    const email = this.requiredEmail(to);
    const senderId = await this.resolveDefaultSenderId(appId, 'notification');
    const sender = await this.requireSenderForApp(senderId, appId, 'notification');
    await this.sendWithSender(sender, email, message);
    return { ok: true, sender_id: senderId };
  }

  async getAppEmailSettings(appId: string) {
    await this.ensureSchema();
    await this.requireApp(appId);
    const settingsRows = await this.prisma.$queryRaw<Row[]>`
      SELECT * FROM app_email_settings WHERE app_id = ${appId}::uuid
    `;
    const senders = await this.listSenders(appId);
    return {
      settings: settingsRows[0] || { app_id: appId },
      senders: senders.items,
    };
  }

  async updateAppEmailSettings(appId: string, payload: unknown) {
    await this.ensureSchema();
    await this.requireApp(appId);
    const body = asObject(payload);
    const marketingSenderId = this.optionalUuid(body.marketing_sender_id || body.marketingSenderId);
    const notificationSenderId = this.optionalUuid(body.notification_sender_id || body.notificationSenderId);
    if (marketingSenderId) await this.requireSenderForApp(marketingSenderId, appId, 'marketing');
    if (notificationSenderId) await this.requireSenderForApp(notificationSenderId, appId, 'notification');
    const unsubscribeBaseUrl = this.optionalString(body.unsubscribe_base_url || body.unsubscribeBaseUrl, 2048);
    const brandName = this.optionalString(body.brand_name || body.brandName, 160);
    const footerText = this.optionalString(body.footer_text || body.footerText, 4000);
    const replyToEmail = body.reply_to_email || body.replyToEmail ? this.requiredEmail(body.reply_to_email || body.replyToEmail) : null;
    const rows = await this.prisma.$queryRaw<Row[]>`
      INSERT INTO app_email_settings (app_id, marketing_sender_id, notification_sender_id, unsubscribe_base_url, brand_name, footer_text, reply_to_email)
      VALUES (${appId}::uuid, ${marketingSenderId}::uuid, ${notificationSenderId}::uuid, ${unsubscribeBaseUrl}, ${brandName}, ${footerText}, ${replyToEmail})
      ON CONFLICT (app_id) DO UPDATE SET
        marketing_sender_id = EXCLUDED.marketing_sender_id,
        notification_sender_id = EXCLUDED.notification_sender_id,
        unsubscribe_base_url = EXCLUDED.unsubscribe_base_url,
        brand_name = EXCLUDED.brand_name,
        footer_text = EXCLUDED.footer_text,
        reply_to_email = EXCLUDED.reply_to_email,
        updated_at = now()
      RETURNING *
    `;
    return { settings: rows[0] };
  }

  async listContacts(appId: string, query: Record<string, unknown>) {
    await this.ensureSchema();
    const page = this.normalizePage(query.page);
    const pageSize = this.normalizePageSize(query.page_size || query.pageSize);
    const status = this.optionalString(query.status, 32);
    const q = this.optionalString(query.q, 160);
    const like = q ? `%${q.toLowerCase()}%` : null;
    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT *, COUNT(*) OVER()::int AS total_count
      FROM email_contacts
      WHERE app_id = ${appId}::uuid
        AND (${status}::text IS NULL OR status = ${status})
        AND (${like}::text IS NULL OR LOWER(email) LIKE ${like} OR LOWER(COALESCE(display_name, '')) LIKE ${like})
      ORDER BY updated_at DESC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
    `;
    return { items: rows, total: rows[0]?.total_count || 0, page, page_size: pageSize };
  }

  async importContacts(appId: string, payload: unknown) {
    await this.ensureSchema();
    await this.requireApp(appId);
    const body = asObject(payload);
    const rows = Array.isArray(body.items) ? body.items : this.parseContactLines(String(body.text || ''));
    let imported = 0;
    for (const raw of rows) {
      const item = asObject(raw);
      const email = this.normalizeEmail(item.email || raw);
      if (!email) continue;
      const displayName = this.optionalString(item.display_name || item.displayName || item.name, 160);
      await this.prisma.$executeRaw`
        INSERT INTO email_contacts (app_id, email, display_name, source, status)
        VALUES (${appId}::uuid, ${email}, ${displayName}, 'import', 'subscribed')
        ON CONFLICT (app_id, LOWER(email)) DO UPDATE SET
          display_name = COALESCE(EXCLUDED.display_name, email_contacts.display_name),
          status = CASE WHEN email_contacts.status = 'unsubscribed' THEN email_contacts.status ELSE 'subscribed' END,
          updated_at = now()
      `;
      imported += 1;
    }
    return { imported };
  }

  async updateContact(appId: string, contactId: string, payload: unknown) {
    await this.ensureSchema();
    const body = asObject(payload);
    const status = body.status === undefined ? null : this.normalizeContactStatus(body.status);
    const displayName = body.display_name === undefined && body.displayName === undefined ? undefined : this.optionalString(body.display_name || body.displayName, 160);
    const rows = await this.prisma.$queryRaw<Row[]>`
      UPDATE email_contacts
      SET status = COALESCE(${status}, status),
          display_name = COALESCE(${displayName}, display_name),
          updated_at = now()
      WHERE id = ${contactId}::uuid AND app_id = ${appId}::uuid
      RETURNING *
    `;
    if (!rows[0]) throw new NotFoundException('email contact not found');
    if (status === 'unsubscribed' || status === 'suppressed') {
      await this.suppressEmail(appId, rows[0].email, status === 'unsubscribed' ? 'unsubscribe' : 'manual');
    }
    return rows[0];
  }

  async listTemplates(appId: string) {
    await this.ensureSchema();
    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT * FROM email_templates WHERE app_id = ${appId}::uuid ORDER BY updated_at DESC
    `;
    return { items: rows };
  }

  async saveTemplate(appId: string, payload: unknown, templateId?: string) {
    await this.ensureSchema();
    const body = asObject(payload);
    const name = this.requiredString(body.name, 'name', 160);
    const subject = this.requiredString(body.subject, 'subject', 240);
    const html = this.requiredString(body.html, 'html', 200000);
    const text = this.optionalString(body.text, 200000);
    if (templateId) {
      const rows = await this.prisma.$queryRaw<Row[]>`
        UPDATE email_templates
        SET name = ${name}, subject = ${subject}, html = ${html}, text = ${text}, updated_at = now()
        WHERE id = ${templateId}::uuid AND app_id = ${appId}::uuid
        RETURNING *
      `;
      if (!rows[0]) throw new NotFoundException('email template not found');
      return rows[0];
    }
    const rows = await this.prisma.$queryRaw<Row[]>`
      INSERT INTO email_templates (app_id, name, subject, html, text)
      VALUES (${appId}::uuid, ${name}, ${subject}, ${html}, ${text})
      RETURNING *
    `;
    return rows[0];
  }

  async listCampaigns(appId: string, query: Record<string, unknown>) {
    await this.ensureSchema();
    const page = this.normalizePage(query.page);
    const pageSize = this.normalizePageSize(query.page_size || query.pageSize);
    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT c.*, s.email AS sender_email, s.display_name AS sender_display_name,
             COALESCE(r.retry_count, 0)::int AS retry_count,
             COUNT(*) OVER()::int AS total_count
      FROM email_campaigns c
      LEFT JOIN email_senders s ON s.id = c.sender_id
      LEFT JOIN (
        SELECT campaign_id, COUNT(*) AS retry_count
        FROM email_campaign_recipients
        WHERE status = 'retry'
        GROUP BY campaign_id
      ) r ON r.campaign_id = c.id
      WHERE c.app_id = ${appId}::uuid
      ORDER BY c.updated_at DESC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
    `;
    return { items: rows, total: rows[0]?.total_count || 0, page, page_size: pageSize };
  }

  async createCampaign(appId: string, actorUserId: string, payload: unknown) {
    await this.ensureSchema();
    const body = asObject(payload);
    const templateId = this.optionalUuid(body.template_id || body.templateId);
    let template: Row | null = null;
    if (templateId) {
      const rows = await this.prisma.$queryRaw<Row[]>`SELECT * FROM email_templates WHERE id = ${templateId}::uuid AND app_id = ${appId}::uuid`;
      template = rows[0] || null;
      if (!template) throw new NotFoundException('email template not found');
    }
    const name = this.requiredString(body.name || template?.name, 'name', 180);
    const subject = this.requiredString(body.subject || template?.subject, 'subject', 240);
    const html = this.requiredString(body.html || template?.html, 'html', 200000);
    const text = this.optionalString(body.text || template?.text, 200000);
    const senderId = this.optionalUuid(body.sender_id || body.senderId) || (await this.resolveDefaultSenderId(appId, 'marketing'));
    await this.requireSenderForApp(senderId, appId, 'marketing');
    const rows = await this.prisma.$queryRaw<Row[]>`
      INSERT INTO email_campaigns (app_id, sender_id, template_id, name, subject, html, text, audience_type, created_by_user_id)
      VALUES (${appId}::uuid, ${senderId}::uuid, ${templateId}::uuid, ${name}, ${subject}, ${html}, ${text}, 'all', ${actorUserId}::uuid)
      RETURNING *
    `;
    return rows[0];
  }

  async sendTestCampaign(appId: string, campaignId: string, payload: unknown) {
    await this.ensureSchema();
    const body = asObject(payload);
    const to = this.requiredEmail(body.to || body.email);
    const campaign = await this.getCampaign(appId, campaignId);
    const sender = await this.requireSenderForApp(campaign.sender_id, appId, 'marketing');
    await this.sendWithSender(sender, to, {
      subject: campaign.subject,
      html: this.renderTemplate(campaign.html, { email: to, display_name: 'Test' }),
      text: campaign.text ? this.renderTemplate(campaign.text, { email: to, display_name: 'Test' }) : undefined,
    });
    return { ok: true };
  }

  async scheduleCampaign(appId: string, campaignId: string, payload: unknown) {
    await this.ensureSchema();
    const campaign = await this.getCampaign(appId, campaignId);
    if (!campaign.sender_id) throw new BadRequestException('sender is required');
    await this.requireSenderForApp(campaign.sender_id, appId, 'marketing');
    const body = asObject(payload);
    const scheduledAt = this.optionalString(body.scheduled_at || body.scheduledAt, 80);
    const eligibleRows = await this.prisma.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM email_contacts c
      WHERE c.app_id = ${appId}::uuid AND c.status = 'subscribed'
    `;
    if (Number(eligibleRows[0]?.count || 0) > EMAIL_MAX_CAMPAIGN_RECIPIENTS) {
      throw new BadRequestException(`email campaign recipient limit is ${EMAIL_MAX_CAMPAIGN_RECIPIENTS}`);
    }
    const rows = await this.prisma.$queryRaw<Row[]>`
      INSERT INTO email_campaign_recipients (campaign_id, contact_id, email_snapshot, display_name_snapshot, status)
      SELECT ${campaignId}::uuid, c.id, c.email, c.display_name,
             CASE WHEN s.id IS NULL THEN 'pending' ELSE 'skipped' END
      FROM email_contacts c
      LEFT JOIN email_suppression_list s ON s.app_id = c.app_id AND LOWER(s.email) = LOWER(c.email)
      WHERE c.app_id = ${appId}::uuid AND c.status = 'subscribed'
      ON CONFLICT (campaign_id, LOWER(email_snapshot)) DO NOTHING
      RETURNING id
    `;
    await this.prisma.$executeRaw`
      UPDATE email_campaigns
      SET status = 'scheduled',
          scheduled_at = COALESCE(${scheduledAt}::timestamptz, now()),
          recipient_total = (SELECT COUNT(*)::int FROM email_campaign_recipients WHERE campaign_id = ${campaignId}::uuid),
          skipped_count = (SELECT COUNT(*)::int FROM email_campaign_recipients WHERE campaign_id = ${campaignId}::uuid AND status = 'skipped'),
          updated_at = now()
      WHERE id = ${campaignId}::uuid AND app_id = ${appId}::uuid
    `;
    return { scheduled: true, recipients_created: rows.length };
  }

  async cancelCampaign(appId: string, campaignId: string) {
    await this.ensureSchema();
    await this.prisma.$executeRaw`
      UPDATE email_campaigns SET status = 'cancelled', updated_at = now()
      WHERE id = ${campaignId}::uuid AND app_id = ${appId}::uuid AND status IN ('draft', 'scheduled', 'paused')
    `;
    await this.prisma.$executeRaw`
      UPDATE email_campaign_recipients
      SET status = 'skipped', updated_at = now()
      WHERE campaign_id = ${campaignId}::uuid AND status = 'pending'
    `;
    await this.refreshCampaignCounts(campaignId);
    return { cancelled: true };
  }

  async listCampaignRecipients(appId: string, campaignId: string, query: Record<string, unknown>) {
    await this.ensureSchema();
    await this.getCampaign(appId, campaignId);
    const page = this.normalizePage(query.page);
    const pageSize = this.normalizePageSize(query.page_size || query.pageSize);
    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT *, COUNT(*) OVER()::int AS total_count
      FROM email_campaign_recipients
      WHERE campaign_id = ${campaignId}::uuid
      ORDER BY created_at DESC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
    `;
    return { items: rows, total: rows[0]?.total_count || 0, page, page_size: pageSize };
  }

  async unsubscribe(appSlug: string | undefined, token: string, emailRaw?: string) {
    await this.ensureSchema();
    const app = await this.resolveAppBySlug(appSlug);
    const email = this.normalizeEmail(emailRaw);
    if (!email || !this.verifyUnsubscribeToken(app.id, email, token)) {
      throw new BadRequestException('invalid unsubscribe token');
    }
    await this.suppressEmail(app.id, email, 'unsubscribe');
    await this.prisma.$executeRaw`
      UPDATE email_contacts SET status = 'unsubscribed', updated_at = now()
      WHERE app_id = ${app.id}::uuid AND LOWER(email) = LOWER(${email})
    `;
    return { ok: true };
  }

  @Interval(30000)
  async processPendingDeliveries() {
    if (this.processing) return;
    this.processing = true;
    try {
      await this.ensureSchema();
      const due = await this.claimDueRecipients();
      for (const item of due) {
        await this.deliverRecipient(item);
      }
    } catch (error: any) {
      this.logger.warn(`email delivery loop failed: ${error?.message || error}`);
    } finally {
      this.processing = false;
    }
  }

  private async deliverRecipient(item: Row) {
    const campaignStatus = await this.prisma.$queryRaw<Row[]>`
      SELECT status FROM email_campaigns WHERE id = ${item.campaign_id}::uuid
    `;
    if (!['scheduled', 'sending'].includes(String(campaignStatus[0]?.status || ''))) {
      await this.prisma.$executeRaw`
        UPDATE email_campaign_recipients
        SET status = 'skipped', updated_at = now()
        WHERE id = ${item.id}::uuid AND status = 'sending'
      `;
      return;
    }
    await this.prisma.$executeRaw`UPDATE email_campaigns SET status = 'sending', updated_at = now() WHERE id = ${item.campaign_id}::uuid`;
    const unsubscribeUrl = await this.buildUnsubscribeUrl(item.app_id, item.email_snapshot);
    const footer = this.optionalString(item.footer_text, 4000);
    const htmlFooter = `${footer ? `<p>${this.escapeHtml(footer)}</p>` : ''}<p><a href="${unsubscribeUrl}">退订</a></p>`;
    const textFooter = `${footer ? `\n\n${footer}` : ''}\n\n退订：${unsubscribeUrl}`;
    try {
      const result = await this.cloudflareEmail.send(item.cf_account_id, this.decryptSecret(item.api_token_ciphertext), {
        from: item.sender_display_name ? { address: item.sender_email, name: item.sender_display_name } : item.sender_email,
        to: [item.email_snapshot],
        subject: item.subject,
        html: `${this.renderTemplate(item.html, { email: item.email_snapshot, display_name: item.display_name_snapshot || '' })}${htmlFooter}`,
        text: item.text ? `${this.renderTemplate(item.text, { email: item.email_snapshot, display_name: item.display_name_snapshot || '' })}${textFooter}` : textFooter.trim(),
        reply_to: this.normalizeEmail(item.reply_to_email) || undefined,
        headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>` },
      });
      const delivered = result.result?.delivered || [];
      const bounced = result.result?.permanent_bounces || [];
      const status = bounced.some((email) => email.toLowerCase() === String(item.email_snapshot).toLowerCase()) ? 'bounced' : 'delivered';
      await this.prisma.$executeRaw`
        UPDATE email_campaign_recipients
        SET status = ${status}, provider_message_id = ${delivered[0] || null}, sent_at = now(), updated_at = now()
        WHERE id = ${item.id}::uuid
      `;
      if (status === 'bounced') await this.suppressEmail(item.app_id, item.email_snapshot, 'bounce', item.campaign_id);
    } catch (error: any) {
      await this.markDeliveryFailure(item, error);
    }
    await this.refreshCampaignCounts(item.campaign_id);
  }

  private async claimDueRecipients() {
    return this.prisma.$transaction(async (tx) => {
      const due = await tx.$queryRaw<Row[]>`
        SELECT r.id
        FROM email_campaign_recipients r
        JOIN email_campaigns c ON c.id = r.campaign_id
        JOIN email_senders s ON s.id = c.sender_id
        JOIN email_cf_accounts a ON a.id = s.cf_account_id
        WHERE r.status IN ('pending', 'retry')
          AND COALESCE(r.next_retry_at, now()) <= now()
          AND c.status IN ('scheduled', 'sending')
          AND COALESCE(c.scheduled_at, now()) <= now()
          AND s.status = 'ACTIVE'
          AND a.status = 'ACTIVE'
        ORDER BY r.created_at
        LIMIT ${EMAIL_DELIVERY_BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      `;
      const ids = due.map((row) => row.id);
      if (!ids.length) return [];
      return tx.$queryRaw<Row[]>`
        UPDATE email_campaign_recipients r
        SET status = 'sending',
            claimed_at = now(),
            last_attempt_at = now(),
            attempt_count = attempt_count + 1,
            updated_at = now()
        FROM email_campaigns c
        JOIN email_senders s ON s.id = c.sender_id
        JOIN email_cf_accounts a ON a.id = s.cf_account_id
        LEFT JOIN app_email_settings es ON es.app_id = c.app_id
        WHERE r.campaign_id = c.id
          AND r.id = ANY(${ids}::uuid[])
        RETURNING r.id, r.email_snapshot, r.display_name_snapshot, r.attempt_count,
                  c.id AS campaign_id, c.app_id, c.subject, c.html, c.text,
                  s.id AS sender_id, s.email AS sender_email, s.display_name AS sender_display_name,
                  a.account_id AS cf_account_id, a.api_token_ciphertext,
                  es.reply_to_email, es.footer_text
      `;
    });
  }

  private async markDeliveryFailure(item: Row, error: any) {
    const message = String(error?.message || error).slice(0, 2000);
    const retryable = this.isRetryableDeliveryError(error);
    const attempts = Number(item.attempt_count || 1);
    if (retryable && attempts < EMAIL_MAX_ATTEMPTS) {
      const delayMinutes = Math.min(60, 2 ** Math.max(0, attempts - 1) * 5);
      await this.prisma.$executeRaw`
        UPDATE email_campaign_recipients
        SET status = 'retry',
            error_message = ${message},
            next_retry_at = now() + (${delayMinutes}::text || ' minutes')::interval,
            updated_at = now()
        WHERE id = ${item.id}::uuid
      `;
      return;
    }
    await this.prisma.$executeRaw`
      UPDATE email_campaign_recipients
      SET status = 'failed', error_message = ${message}, next_retry_at = NULL, updated_at = now()
      WHERE id = ${item.id}::uuid
    `;
  }

  private async refreshCampaignCounts(campaignId: string) {
    await this.prisma.$executeRaw`
      UPDATE email_campaigns c
      SET delivered_count = (SELECT COUNT(*)::int FROM email_campaign_recipients WHERE campaign_id = c.id AND status IN ('delivered', 'queued')),
          failed_count = (SELECT COUNT(*)::int FROM email_campaign_recipients WHERE campaign_id = c.id AND status IN ('failed', 'bounced')),
          skipped_count = (SELECT COUNT(*)::int FROM email_campaign_recipients WHERE campaign_id = c.id AND status = 'skipped'),
          recipient_total = (SELECT COUNT(*)::int FROM email_campaign_recipients WHERE campaign_id = c.id),
          status = CASE
            WHEN c.status = 'cancelled' THEN c.status
            WHEN NOT EXISTS (SELECT 1 FROM email_campaign_recipients WHERE campaign_id = c.id AND status IN ('pending', 'retry', 'sending')) THEN 'completed'
            ELSE c.status
          END,
          updated_at = now()
      WHERE c.id = ${campaignId}::uuid
    `;
  }

  private async sendWithSender(sender: Row, to: string, message: { subject: string; html?: string; text?: string }) {
    return this.cloudflareEmail.send(sender.cf_account_id, this.decryptSecret(sender.api_token_ciphertext), {
      from: sender.display_name ? { address: sender.email, name: sender.display_name } : sender.email,
      to: [to],
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
  }

  private async getCloudflareAccountSecret(accountUuid: string) {
    const rows = await this.prisma.$queryRaw<Row[]>`SELECT * FROM email_cf_accounts WHERE id = ${accountUuid}::uuid`;
    if (!rows[0]) throw new NotFoundException('cloudflare account not found');
    return rows[0];
  }

  private async resolveCloudflareAccountFromToken(apiToken: string, selectedAccountId?: string | null) {
    await this.cloudflareEmail.verifyToken(apiToken);
    const accounts = await this.safeListCloudflareAccounts(apiToken);

    if (selectedAccountId) {
      if (!accounts.length) return { id: selectedAccountId, name: selectedAccountId };
      const matched = accounts.find((account) => account.id === selectedAccountId);
      if (!matched) throw new BadRequestException('cloudflare token cannot access selected account');
      return { id: matched.id, name: matched.name };
    }

    if (!accounts.length) throw new BadRequestException('cloudflare account_id is required');

    if (accounts.length > 1) {
      throw new BadRequestException('cloudflare account_id is required when token can access multiple accounts');
    }

    return { id: accounts[0].id, name: accounts[0].name };
  }

  private async safeListCloudflareAccounts(apiToken: string) {
    try {
      return await this.cloudflareEmail.listAccounts(apiToken);
    } catch (error: any) {
      this.logger.warn(`cloudflare account discovery failed: ${error?.message || error}`);
      return [];
    }
  }

  private async getSender(senderId: string) {
    const rows = await this.prisma.$queryRaw<Row[]>`SELECT * FROM email_senders WHERE id = ${senderId}::uuid`;
    if (!rows[0]) throw new NotFoundException('email sender not found');
    return rows[0];
  }

  private async getSenderWithAccount(senderId: string) {
    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT s.*, a.account_id AS cf_account_id, a.api_token_ciphertext
      FROM email_senders s JOIN email_cf_accounts a ON a.id = s.cf_account_id
      WHERE s.id = ${senderId}::uuid
    `;
    if (!rows[0]) throw new NotFoundException('email sender not found');
    return rows[0];
  }

  private async requireSenderForApp(senderId: string, appId: string, purpose?: 'marketing' | 'notification') {
    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT s.*, a.account_id AS cf_account_id, a.api_token_ciphertext
      FROM email_senders s
      JOIN email_cf_accounts a ON a.id = s.cf_account_id
      WHERE s.id = ${senderId}::uuid
        AND (s.app_id IS NULL OR s.app_id = ${appId}::uuid)
        AND s.status = 'ACTIVE'
        AND a.status = 'ACTIVE'
        AND (${purpose || null}::text IS NULL OR s.purpose IN (${purpose || null}, 'both'))
    `;
    if (!rows[0]) throw new BadRequestException('email sender is not available for this app');
    return rows[0];
  }

  private async getCampaign(appId: string, campaignId: string) {
    const rows = await this.prisma.$queryRaw<Row[]>`SELECT * FROM email_campaigns WHERE id = ${campaignId}::uuid AND app_id = ${appId}::uuid`;
    if (!rows[0]) throw new NotFoundException('email campaign not found');
    return rows[0];
  }

  private async resolveDefaultSenderId(appId: string, purpose: 'marketing' | 'notification') {
    const settingsRows = await this.prisma.$queryRaw<Row[]>`
      SELECT marketing_sender_id, notification_sender_id
      FROM app_email_settings
      WHERE app_id = ${appId}::uuid
    `;
    const configured = purpose === 'marketing' ? settingsRows[0]?.marketing_sender_id : settingsRows[0]?.notification_sender_id;
    if (configured) return configured;

    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT id AS sender_id
      FROM email_senders
      WHERE (app_id = ${appId}::uuid OR app_id IS NULL)
        AND status = 'ACTIVE'
        AND purpose IN (${purpose}, 'both')
      ORDER BY is_default DESC, app_id NULLS LAST, updated_at DESC
      LIMIT 1
    `;
    const senderId = rows[0]?.sender_id;
    if (!senderId) throw new BadRequestException('email sender is required');
    return senderId;
  }

  private async requireApp(appId: string) {
    const rows = await this.prisma.$queryRaw<Row[]>`SELECT id, slug, name FROM apps WHERE id = ${appId}::uuid`;
    if (!rows[0]) throw new NotFoundException('app not found');
    return rows[0];
  }

  private async resolveAppBySlug(appSlug?: string) {
    const slug = this.optionalString(appSlug, 80);
    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT id, slug, name FROM apps WHERE slug = COALESCE(${slug}, slug) ORDER BY created_at LIMIT 1
    `;
    if (!rows[0]) throw new NotFoundException('app not found');
    return rows[0];
  }

  private async buildUnsubscribeUrl(appId: string, email: string) {
    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT a.slug, s.unsubscribe_base_url
      FROM apps a LEFT JOIN app_email_settings s ON s.app_id = a.id
      WHERE a.id = ${appId}::uuid
    `;
    const app = rows[0];
    const base = this.optionalString(app?.unsubscribe_base_url, 2048) || `/${app?.slug || 'app'}/v1/email/unsubscribe`;
    const token = this.signUnsubscribeToken(appId, email);
    const separator = base.includes('?') ? '&' : '?';
    return `${base}${separator}email=${encodeURIComponent(email)}&token=${encodeURIComponent(token)}`;
  }

  private async suppressEmail(appId: string, email: string, reason: string, campaignId?: string) {
    await this.prisma.$executeRaw`
      INSERT INTO email_suppression_list (app_id, email, reason, campaign_id)
      VALUES (${appId}::uuid, ${email}, ${reason}, ${campaignId || null}::uuid)
      ON CONFLICT (app_id, LOWER(email)) DO UPDATE SET reason = EXCLUDED.reason, campaign_id = EXCLUDED.campaign_id, created_at = now()
    `;
  }

  private renderTemplate(input: string, variables: Record<string, string>) {
    return String(input || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => variables[key] || '');
  }

  private escapeHtml(input: string) {
    return String(input || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private parseContactLines(text: string) {
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [email, ...nameParts] = line.split(/[,，\t]/).map((part) => part.trim());
        return { email, display_name: nameParts.join(' ') || undefined };
      });
  }

  private encryptSecret(value: string) {
    const iv = randomBytes(12);
    const key = this.secretKey();
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
  }

  private decryptSecret(value: string) {
    const [version, ivRaw, tagRaw, encryptedRaw] = String(value || '').split(':');
    if (version !== 'v1' || !ivRaw || !tagRaw || !encryptedRaw) {
      throw new BadRequestException('invalid encrypted secret');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.secretKey(), Buffer.from(ivRaw, 'base64'));
    decipher.setAuthTag(Buffer.from(tagRaw, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(encryptedRaw, 'base64')), decipher.final()]).toString('utf8');
  }

  private secretKey() {
    return createHash('sha256')
      .update(
        process.env.PLATFORM_SECRETS_KEY
          || process.env.OUTBOUND_PROXY_ENCRYPTION_KEY
          || process.env.JWT_SECRET_KEY
          || 'email-delivery',
      )
      .digest();
  }

  private signUnsubscribeToken(appId: string, email: string) {
    return createHmac('sha256', this.secretKey()).update(`${appId}:${email.toLowerCase()}`).digest('base64url');
  }

  private verifyUnsubscribeToken(appId: string, email: string, token: string) {
    const expected = Buffer.from(this.signUnsubscribeToken(appId, email));
    const actual = Buffer.from(String(token || ''));
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private normalizeEmail(value: unknown) {
    const email = String(value || '').trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 320 ? email : '';
  }

  private requiredEmail(value: unknown) {
    const email = this.normalizeEmail(value);
    if (!email) throw new BadRequestException('valid email is required');
    return email;
  }

  private optionalString(value: unknown, max = 255) {
    const normalized = String(value ?? '').trim();
    return normalized ? normalized.slice(0, max) : null;
  }

  private optionalCloudflareAccountId(value: unknown) {
    const normalized = this.optionalString(value, 120);
    if (!normalized) return null;
    if (/^[0-9a-f]{32}$/i.test(normalized)) return normalized;
    throw new BadRequestException('valid Cloudflare account id is required');
  }

  private requiredString(value: unknown, field: string, max = 255) {
    const normalized = this.optionalString(value, max);
    if (!normalized) throw new BadRequestException(`${field} is required`);
    return normalized;
  }

  private optionalUuid(value: unknown) {
    const normalized = String(value || '').trim();
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)
      ? normalized
      : null;
  }

  private normalizeActiveStatus(value: unknown) {
    return String(value || 'ACTIVE').toUpperCase() === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE';
  }

  private normalizePurpose(value: unknown) {
    const raw = String(value || 'both').toLowerCase();
    return raw === 'marketing' || raw === 'notification' ? raw : 'both';
  }

  private normalizeContactStatus(value: unknown) {
    const raw = String(value || '').toLowerCase();
    if (['subscribed', 'unsubscribed', 'bounced', 'suppressed'].includes(raw)) return raw;
    throw new BadRequestException('invalid contact status');
  }

  private isRetryableDeliveryError(error: any) {
    const status = Number(error?.status || error?.response?.status || error?.cause?.status || 0);
    if (status === 429 || status >= 500) return true;
    const message = String(error?.message || error || '').toLowerCase();
    return ['timeout', 'timed out', 'econnreset', 'socket hang up', 'network', 'temporarily'].some((token) =>
      message.includes(token),
    );
  }

  private normalizePage(value: unknown) {
    const page = Number.parseInt(String(value || '1'), 10);
    return Number.isFinite(page) && page > 0 ? page : 1;
  }

  private normalizePageSize(value: unknown) {
    const size = Number.parseInt(String(value || '20'), 10);
    return Math.min(100, Math.max(1, Number.isFinite(size) ? size : 20));
  }

  private async ensureSchema() {
    if (this.schemaReady) return;
    if (!this.schemaPromise) {
      this.schemaPromise = this.prisma
        .$queryRaw`SELECT 1 FROM email_cf_accounts LIMIT 1`
        .then(() => {
          this.schemaReady = true;
        })
        .catch((error) => {
          this.schemaPromise = null;
          throw error;
        });
    }
    await this.schemaPromise;
  }
}
