import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import configuration from '../../config/configuration';
import { PRISMA_CLIENT } from '../../config/database.module';
import { buildOutboundProxySecretKey, encryptOutboundProxyPassword } from './outbound-proxy.crypto';
import { OutboundHttpClientService } from './outbound-http-client.service';
import { OutboundProxyProtocol, OutboundProxyRow, OutboundProxyStatus } from './outbound-proxy.types';

type ProxyInput = {
  name?: string;
  protocol?: string;
  host?: string;
  port?: number | string;
  username?: string | null;
  password?: string | null;
  clear_password?: boolean;
  region?: string | null;
  status?: string;
};

type ProxyImportItem = ProxyInput & {
  url?: string;
};

type ProxyCheckLogRow = {
  id: string;
  proxy_id: string;
  check_type: string;
  target_url: string;
  success: boolean;
  status_code: number | null;
  latency_ms: number | null;
  detected_ip: string | null;
  region: string | null;
  error_message: string | null;
  created_at: Date;
};

type ProxyRuntimeCheckResult = {
  check_type: string;
  target_url: string;
  success: boolean;
  status_code: number | null;
  latency_ms: number | null;
  detected_ip: string | null;
  region: string | null;
  error_message: string | null;
};

const DEFAULT_TEST_URL = 'https://api.ipify.org?format=json';
const GOOGLE_TEST_URL = 'https://accounts.google.com/.well-known/openid-configuration';
const OPENAI_TEST_URL = 'https://api.openai.com/v1/models';

@Injectable()
export class OutboundProxyService {
  private readonly secretKey: Buffer;

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(configuration.KEY) private readonly config: ConfigType<typeof configuration>,
    private readonly outboundHttp: OutboundHttpClientService,
  ) {
    this.secretKey = buildOutboundProxySecretKey(
      process.env.PLATFORM_SECRETS_KEY || process.env.OUTBOUND_PROXY_ENCRYPTION_KEY || this.config.jwt.secret,
    );
  }

  async listProxies(query: { q?: string; protocol?: string; status?: string } = {}) {
    const params: unknown[] = [];
    const where: string[] = [];
    const q = String(query.q || '').trim();
    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      where.push(`(LOWER(p.name) LIKE $${params.length} OR LOWER(p.host) LIKE $${params.length} OR LOWER(COALESCE(p.region, '')) LIKE $${params.length})`);
    }
    const protocol = String(query.protocol || '').trim().toLowerCase();
    if (protocol && protocol !== 'all') {
      params.push(this.normalizeProtocol(protocol));
      where.push(`p.protocol = $${params.length}`);
    }
    const status = String(query.status || '').trim().toLowerCase();
    if (status && status !== 'all') {
      params.push(this.normalizeStatus(status));
      where.push(`p.status = $${params.length}`);
    }
    const rows = await (this.prisma.$queryRawUnsafe(
      `
        SELECT
          p.*,
          COALESCE(ai_refs.count, 0)::bigint AS ai_source_count,
          COALESCE(google_refs.count, 0)::bigint AS google_oauth_client_count
        FROM outbound_proxies p
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::bigint AS count
          FROM ai_global_sources s
          WHERE s.outbound_proxy_id = p.id
        ) ai_refs ON true
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::bigint AS count
          FROM google_oauth_clients g
          WHERE g.outbound_proxy_id = p.id
        ) google_refs ON true
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY p.updated_at DESC, p.created_at DESC
      `,
      ...params,
    ) as Promise<Array<OutboundProxyRow & {
      ai_source_count: bigint;
      google_oauth_client_count: bigint;
    }>>);
    return {
      items: rows.map((row) => this.serializeProxy(row)),
    };
  }

  async createProxy(actorUserId: string, payload: ProxyInput) {
    const input = this.normalizeProxyInput(payload, false);
    await this.ensureProxyEndpointAvailable(input.protocol, input.host, input.port, input.username);
    const rows = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO outbound_proxies (
         id, name, protocol, host, port, username, encrypted_password, region, status, created_by_user_id, updated_by_user_id
       ) VALUES (
         gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9::uuid, $9::uuid
       )
       RETURNING *`,
      input.name,
      input.protocol,
      input.host,
      input.port,
      input.username,
      input.encryptedPassword,
      input.region,
      input.status,
      actorUserId,
    ) as Promise<OutboundProxyRow[]>);
    return this.getProxy(rows[0].id);
  }

  async updateProxy(proxyId: string, actorUserId: string, payload: ProxyInput) {
    const existing = await this.getProxyRow(proxyId);
    const merged = this.normalizeProxyInput({
      name: payload.name === undefined ? existing.name : payload.name,
      protocol: payload.protocol === undefined ? existing.protocol : payload.protocol,
      host: payload.host === undefined ? existing.host : payload.host,
      port: payload.port === undefined ? existing.port : payload.port,
      username: payload.username === undefined ? existing.username : payload.username,
      password: payload.password,
      clear_password: payload.clear_password,
      region: payload.region === undefined ? existing.region : payload.region,
      status: payload.status === undefined ? existing.status : payload.status,
    }, true);
    const encryptedPassword = payload.password === undefined && !payload.clear_password
      ? existing.encrypted_password
      : merged.encryptedPassword;
    await this.ensureProxyEndpointAvailable(merged.protocol, merged.host, merged.port, merged.username, proxyId);
    await this.prisma.$executeRawUnsafe(
      `UPDATE outbound_proxies
       SET name = $2,
           protocol = $3,
           host = $4,
           port = $5,
           username = $6,
           encrypted_password = $7,
           region = $8,
           status = $9,
           updated_by_user_id = $10::uuid,
           updated_at = now()
       WHERE id = $1::uuid`,
      proxyId,
      merged.name,
      merged.protocol,
      merged.host,
      merged.port,
      merged.username,
      encryptedPassword,
      merged.region,
      merged.status,
      actorUserId,
    );
    this.outboundHttp.clearProxyCache(proxyId);
    return this.getProxy(proxyId);
  }

  async deleteProxy(proxyId: string) {
    await this.getProxyRow(proxyId);
    const refs = await this.countReferences(proxyId);
    if (refs.reference_count > 0) {
      throw new ConflictException('该代理仍被使用，请先解除绑定或禁用');
    }
    await this.prisma.$executeRawUnsafe(`DELETE FROM outbound_proxies WHERE id = $1::uuid`, proxyId);
    this.outboundHttp.clearProxyCache(proxyId);
    return { success: true };
  }

  async getProxy(proxyId: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `
        SELECT
          p.*,
          COALESCE(ai_refs.count, 0)::bigint AS ai_source_count,
          COALESCE(google_refs.count, 0)::bigint AS google_oauth_client_count
        FROM outbound_proxies p
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::bigint AS count FROM ai_global_sources s WHERE s.outbound_proxy_id = p.id
        ) ai_refs ON true
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::bigint AS count FROM google_oauth_clients g WHERE g.outbound_proxy_id = p.id
        ) google_refs ON true
        WHERE p.id = $1::uuid
        LIMIT 1
      `,
      proxyId,
    ) as Promise<Array<OutboundProxyRow & {
      ai_source_count: bigint;
      google_oauth_client_count: bigint;
    }>>);
    if (!rows[0]) {
      throw new NotFoundException('代理不存在');
    }
    return this.serializeProxy(rows[0]);
  }

  async testProxy(proxyId: string, payload: { target_url?: string; quality?: boolean } = {}) {
    const proxy = await this.getProxyRow(proxyId);
    const quality = payload.quality === true;
    const targets = quality
      ? [
          { type: 'basic', url: DEFAULT_TEST_URL },
          { type: 'google', url: GOOGLE_TEST_URL },
          { type: 'openai', url: OPENAI_TEST_URL },
        ]
      : [{ type: 'basic', url: String(payload.target_url || '').trim() || DEFAULT_TEST_URL }];

    await this.prisma.$executeRawUnsafe(
      `UPDATE outbound_proxies SET status = 'checking', updated_at = now() WHERE id = $1::uuid`,
      proxy.id,
    );
    this.outboundHttp.clearProxyCache(proxy.id);

    const results: ProxyRuntimeCheckResult[] = [];
    for (const target of targets) {
      results.push(await this.runSingleCheck(proxy.id, target.type, target.url));
    }
    const successCount = results.filter((item) => item.success).length;
    const lastBasic = results.find((item) => item.detected_ip) || results[0];
    const detectedStatus: OutboundProxyStatus = successCount === targets.length ? 'active' : 'unhealthy';
    const nextStatus: OutboundProxyStatus = proxy.status === 'disabled' ? 'disabled' : detectedStatus;
    const nextFailCount = detectedStatus === 'active' ? 0 : proxy.fail_count + 1;
    await this.prisma.$executeRawUnsafe(
      `UPDATE outbound_proxies
       SET status = $2,
           latency_ms = $3,
           detected_ip = $4,
           region = COALESCE($5, region),
           fail_count = $6,
           last_checked_at = now(),
           updated_at = now()
       WHERE id = $1::uuid`,
      proxy.id,
      nextStatus,
      lastBasic?.latency_ms ?? null,
      lastBasic?.detected_ip ?? null,
      lastBasic?.region ?? null,
      nextFailCount,
    );
    this.outboundHttp.clearProxyCache(proxy.id);
    return {
      proxy_id: proxy.id,
      ok: detectedStatus === 'active',
      status: nextStatus,
      success_count: successCount,
      total_count: targets.length,
      results,
    };
  }

  async batchTest(payload: { ids?: string[]; quality?: boolean; concurrency?: number } = {}) {
    const ids = Array.from(new Set((payload.ids || []).map((item) => String(item || '').trim()).filter(Boolean)));
    const targetIds = ids.length > 0
      ? ids
      : (await (this.prisma.$queryRawUnsafe(
          `SELECT id FROM outbound_proxies WHERE status <> 'disabled' ORDER BY updated_at DESC`,
        ) as Promise<Array<{ id: string }>>)).map((row) => row.id);
    const concurrency = Math.min(10, Math.max(1, Number(payload.concurrency || 5) || 5));
    const results: any[] = [];
    for (let index = 0; index < targetIds.length; index += concurrency) {
      const batch = targetIds.slice(index, index + concurrency);
      const settled = await Promise.all(batch.map((proxyId) => (
        this.testProxy(proxyId, { quality: payload.quality !== false }).catch((error: any) => ({
          proxy_id: proxyId,
          ok: false,
          status: 'unhealthy',
          error_message: this.truncate(error?.message || String(error), 500),
        }))
      )));
      results.push(...settled);
    }
    return {
      total: targetIds.length,
      ok: results.filter((item) => item.ok).length,
      failed: results.filter((item) => !item.ok).length,
      items: results,
    };
  }

  async importProxies(actorUserId: string, payload: { text?: string; items?: ProxyImportItem[] }) {
    const items = this.parseImportPayload(payload);
    const imported: unknown[] = [];
    const failed: Array<{ input: string; error_message: string }> = [];
    for (const item of items) {
      try {
        imported.push(await this.createProxy(actorUserId, item));
      } catch (error: any) {
        failed.push({
          input: item.url || item.host || item.name || '',
          error_message: this.truncate(error?.message || String(error), 500),
        });
      }
    }
    return {
      imported: imported.length,
      failed: failed.length,
      items: imported,
      errors: failed,
    };
  }

  async exportProxies() {
    const response = await this.listProxies();
    return {
      exported_at: new Date().toISOString(),
      items: response.items.map((item: any) => ({
        name: item.name,
        protocol: item.protocol,
        host: item.host,
        port: item.port,
        username: item.username || '',
        region: item.region || '',
        status: item.status,
        detected_ip: item.detected_ip || '',
        latency_ms: item.latency_ms,
        last_checked_at: item.last_checked_at,
        reference_count: item.reference_count,
      })),
    };
  }

  async listCheckLogs(proxyId: string, query: { limit?: number } = {}) {
    await this.getProxyRow(proxyId);
    const limit = Math.min(200, Math.max(1, Number(query.limit || 50) || 50));
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM outbound_proxy_check_logs
       WHERE proxy_id = $1::uuid
       ORDER BY created_at DESC
       LIMIT $2`,
      proxyId,
      limit,
    ) as Promise<ProxyCheckLogRow[]>);
    return {
      items: rows,
    };
  }

  private async runSingleCheck(proxyId: string, checkType: string, targetUrl: string) {
    const startedAt = Date.now();
    let statusCode: number | null = null;
    let detectedIp: string | null = null;
    let region: string | null = null;
    try {
      const response = await this.outboundHttp.fetch(targetUrl, {
        method: 'GET',
        headers: { accept: 'application/json,text/plain,*/*' },
      }, {
        proxyId,
        allowDisabled: true,
        timeoutMs: 15000,
      });
      statusCode = response.status;
      const text = await response.text().catch(() => '');
      if (targetUrl.includes('api.ipify.org')) {
        const payload = this.tryParseJson(text);
        detectedIp = String(payload?.ip || '').trim() || this.extractIp(text);
      }
      const success = response.ok || [400, 401, 403, 405].includes(response.status);
      const result = {
        check_type: checkType,
        target_url: targetUrl,
        success,
        status_code: statusCode,
        latency_ms: Date.now() - startedAt,
        detected_ip: detectedIp,
        region,
        error_message: success ? null : this.truncate(text || response.statusText, 500),
      };
      await this.insertCheckLog(proxyId, result);
      return result;
    } catch (error: any) {
      const result = {
        check_type: checkType,
        target_url: targetUrl,
        success: false,
        status_code: statusCode,
        latency_ms: Date.now() - startedAt,
        detected_ip: detectedIp,
        region,
        error_message: this.truncate(error?.message || String(error), 500),
      };
      await this.insertCheckLog(proxyId, result);
      return result;
    }
  }

  private async insertCheckLog(proxyId: string, result: {
    check_type: string;
    target_url: string;
    success: boolean;
    status_code: number | null;
    latency_ms: number | null;
    detected_ip: string | null;
    region: string | null;
    error_message: string | null;
  }) {
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO outbound_proxy_check_logs (
         proxy_id, check_type, target_url, success, status_code, latency_ms, detected_ip, region, error_message
       ) VALUES (
         $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9
       )`,
      proxyId,
      result.check_type,
      result.target_url,
      result.success,
      result.status_code,
      result.latency_ms,
      result.detected_ip,
      result.region,
      result.error_message,
    );
    await this.prisma.$executeRawUnsafe(
      `DELETE FROM outbound_proxy_check_logs
       WHERE proxy_id = $1::uuid
         AND id NOT IN (
           SELECT id FROM outbound_proxy_check_logs
           WHERE proxy_id = $1::uuid
           ORDER BY created_at DESC
           LIMIT 200
         )`,
      proxyId,
    ).catch(() => undefined);
  }

  private parseImportPayload(payload: { text?: string; items?: ProxyImportItem[] }): ProxyImportItem[] {
    const rawItems = Array.isArray(payload.items) ? payload.items : [];
    const text = String(payload.text || '').trim();
    const items: ProxyImportItem[] = [...rawItems];
    if (text) {
      const parsed = this.tryParseJson(text);
      if (Array.isArray(parsed)) {
        items.push(...parsed);
      } else {
        text.split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .forEach((line) => items.push(this.parseProxyUrl(line)));
      }
    }
    return items.map((item) => item.url ? this.parseProxyUrl(item.url, item) : item);
  }

  private parseProxyUrl(rawUrl: string, fallback: ProxyImportItem = {}): ProxyImportItem {
    try {
      const url = new URL(rawUrl);
      const protocol = url.protocol.replace(':', '').toLowerCase();
      return {
        ...fallback,
        name: fallback.name || `${url.hostname}:${url.port || this.defaultPort(protocol)}`,
        protocol,
        host: url.hostname,
        port: url.port || this.defaultPort(protocol),
        username: decodeURIComponent(url.username || ''),
        password: decodeURIComponent(url.password || ''),
      };
    } catch {
      return {
        ...fallback,
        name: fallback.name || rawUrl,
        host: fallback.host || rawUrl,
      };
    }
  }

  private defaultPort(protocol: string) {
    if (protocol === 'https') return 443;
    if (protocol === 'socks5') return 1080;
    return 8080;
  }

  private normalizeProxyInput(payload: ProxyInput, allowPasswordEmpty: boolean) {
    const protocol = this.normalizeProtocol(payload.protocol || 'http');
    const name = String(payload.name || '').trim();
    const host = String(payload.host || '').trim();
    const port = Number(payload.port);
    const status = this.normalizeStatus(payload.status || 'active');
    if (!name) throw new BadRequestException('name is required');
    if (!host) throw new BadRequestException('host is required');
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new BadRequestException('port must be between 1 and 65535');
    }
    const username = String(payload.username || '').trim() || null;
    const rawPassword = String(payload.password || '').trim();
    const encryptedPassword = payload.clear_password
      ? null
      : rawPassword
        ? encryptOutboundProxyPassword(rawPassword, this.secretKey)
        : allowPasswordEmpty
          ? null
          : null;
    return {
      name,
      protocol,
      host,
      port,
      username,
      encryptedPassword,
      region: String(payload.region || '').trim() || null,
      status,
    };
  }

  private normalizeProtocol(value: string): OutboundProxyProtocol {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'http' || normalized === 'https' || normalized === 'socks5') {
      return normalized;
    }
    throw new BadRequestException('protocol must be http, https or socks5');
  }

  private normalizeStatus(value: string): OutboundProxyStatus {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'active' || normalized === 'unhealthy' || normalized === 'disabled' || normalized === 'checking') {
      return normalized;
    }
    throw new BadRequestException('status must be active, unhealthy, disabled or checking');
  }

  private async getProxyRow(proxyId: string): Promise<OutboundProxyRow> {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT * FROM outbound_proxies WHERE id = $1::uuid LIMIT 1`,
      proxyId,
    ) as Promise<OutboundProxyRow[]>);
    if (!rows[0]) {
      throw new NotFoundException('代理不存在');
    }
    return rows[0];
  }

  private async countReferences(proxyId: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::bigint FROM ai_global_sources WHERE outbound_proxy_id = $1::uuid) AS ai_source_count,
         (SELECT COUNT(*)::bigint FROM google_oauth_clients WHERE outbound_proxy_id = $1::uuid) AS google_oauth_client_count`,
      proxyId,
    ) as Promise<Array<{ ai_source_count: bigint; google_oauth_client_count: bigint }>>);
    const aiSourceCount = Number(rows[0]?.ai_source_count || 0);
    const googleOAuthClientCount = Number(rows[0]?.google_oauth_client_count || 0);
    return {
      ai_source_count: aiSourceCount,
      google_oauth_client_count: googleOAuthClientCount,
      reference_count: aiSourceCount + googleOAuthClientCount,
    };
  }

  private async ensureProxyEndpointAvailable(
    protocol: OutboundProxyProtocol,
    host: string,
    port: number,
    username: string | null,
    exceptProxyId?: string,
  ) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id
       FROM outbound_proxies
       WHERE protocol = $1
         AND LOWER(host) = LOWER($2)
         AND port = $3
         AND COALESCE(username, '') = COALESCE($4, '')
         ${exceptProxyId ? 'AND id <> $5::uuid' : ''}
       LIMIT 1`,
      ...(exceptProxyId
        ? [protocol, host, port, username, exceptProxyId]
        : [protocol, host, port, username]),
    ) as Promise<Array<{ id: string }>>);
    if (rows[0]) {
      throw new ConflictException('代理地址已存在');
    }
  }

  private serializeProxy(row: OutboundProxyRow & { ai_source_count?: bigint; google_oauth_client_count?: bigint }) {
    const aiSourceCount = Number(row.ai_source_count || 0);
    const googleOAuthClientCount = Number(row.google_oauth_client_count || 0);
    return {
      id: row.id,
      name: row.name,
      protocol: row.protocol,
      host: row.host,
      port: row.port,
      username: row.username || '',
      has_password: !!row.encrypted_password,
      password_masked: row.encrypted_password ? '***' : '',
      region: row.region || '',
      status: row.status,
      latency_ms: row.latency_ms,
      detected_ip: row.detected_ip,
      fail_count: row.fail_count,
      last_checked_at: row.last_checked_at,
      ai_source_count: aiSourceCount,
      google_oauth_client_count: googleOAuthClientCount,
      reference_count: aiSourceCount + googleOAuthClientCount,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private tryParseJson(value: string): any {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  private extractIp(value: string): string | null {
    return value.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/)?.[0] || null;
  }

  private truncate(value: string, max: number) {
    const text = String(value || '');
    return text.length > max ? `${text.slice(0, max)}...` : text;
  }
}
