import { BadRequestException, Injectable } from '@nestjs/common';
import { CloudflareEmailSendPayload, CloudflareEmailSendResult } from './email-delivery.types';

type CloudflareApiResponse<T> = {
  success?: boolean;
  result?: T;
  errors?: Array<{ message?: string }>;
};

@Injectable()
export class CloudflareEmailService {
  async verifyToken(apiToken: string) {
    return this.request('https://api.cloudflare.com/client/v4/user/tokens/verify', apiToken);
  }

  async listAccounts(apiToken: string) {
    const data = await this.request<Array<{ id: string; name: string; type?: string }>>(
      'https://api.cloudflare.com/client/v4/accounts?per_page=50',
      apiToken,
    );
    return Array.isArray(data.result) ? data.result : [];
  }

  async listSendingDomains(accountId: string, apiToken: string) {
    const zones = await this.request<Array<{ id: string; name: string }>>(
      `https://api.cloudflare.com/client/v4/zones?account.id=${encodeURIComponent(accountId)}&per_page=50`,
      apiToken,
    );
    const zoneItems = Array.isArray(zones.result) ? zones.result : [];
    const domains: Array<{ id: string; name: string; enabled: boolean; zone_id: string; zone_name: string }> = [];

    for (const zone of zoneItems) {
      const subdomains = await this.request<
        Array<{ id?: string; tag?: string; name: string; enabled?: boolean }>
      >(`https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zone.id)}/email/sending/subdomains`, apiToken);
      for (const item of Array.isArray(subdomains.result) ? subdomains.result : []) {
        domains.push({
          id: item.id || item.tag || item.name,
          name: item.name,
          enabled: item.enabled !== false,
          zone_id: zone.id,
          zone_name: zone.name,
        });
      }
    }

    return domains.sort((a, b) => a.name.localeCompare(b.name));
  }

  async send(accountId: string, apiToken: string, payload: CloudflareEmailSendPayload): Promise<CloudflareEmailSendResult> {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/email/sending/send`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = (await response.json().catch(() => ({}))) as CloudflareEmailSendResult;
    if (!response.ok || data.success === false) {
      const message = data.errors?.[0]?.message || `Cloudflare email send failed with HTTP ${response.status}`;
      throw new BadRequestException(`Cloudflare Email Sending failed: ${message}`);
    }
    return data;
  }

  private async request<T>(url: string, apiToken: string): Promise<CloudflareApiResponse<T>> {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
    });
    const data = (await response.json().catch(() => ({}))) as CloudflareApiResponse<T>;
    if (!response.ok || data.success === false) {
      const message = data.errors?.[0]?.message || `Cloudflare API failed with HTTP ${response.status}`;
      throw new BadRequestException(`Cloudflare API failed: ${message}`);
    }
    return data;
  }
}
