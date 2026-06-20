import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import Ajv from 'ajv';
import { createHash, createHmac } from 'crypto';
import { PrismaClient } from '@prisma/client';
import configuration from '../../config/configuration';
import { PRISMA_CLIENT } from '../../config/database.module';
import { AppSchemaService } from '../app-schema/app-schema.service';
import { OutboundHttpClientService } from '../outbound-proxy/outbound-http-client.service';
import { RealtimeEventsService } from '../realtime/realtime-events.service';
import {
  buildAppConnectorSecretKey,
  decryptAppConnectorSecretJson,
  encryptAppConnectorSecretJson,
} from './app-connectors.crypto';
import {
  AppConnectorActionRow,
  AppConnectorCredentialRow,
  AppConnectorRow,
  AppConnectorRunRow,
} from './app-connectors.types';

type AppRef = { id: string; slug: string; name?: string | null; status?: string | null };

type InvocationInput = {
  input?: unknown;
  credential?: unknown;
  credential_id?: unknown;
  credential_slug?: unknown;
  trigger_type?: unknown;
};

const IDENTIFIER_RE = /^[a-z][a-z0-9_]{1,78}$/;
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);
const AUTH_MODES = new Set(['none', 'bearer', 'basic', 'api_key_header', 'api_key_query', 'hmac_sha256', 'custom_template']);
const STATUS_VALUES = new Set(['ACTIVE', 'INACTIVE', 'DELETED']);
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_REQUEST_BYTES = 10 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function asPlainObject(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {};
}

@Injectable()
export class AppConnectorsService {
  private readonly logger = new Logger(AppConnectorsService.name);
  private readonly ajv = new Ajv({ allErrors: true, strict: false });
  private readonly secretKey: Buffer;

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(configuration.KEY) private readonly config: ConfigType<typeof configuration>,
    private readonly appSchemaService: AppSchemaService,
    private readonly outboundHttp: OutboundHttpClientService,
    private readonly realtimeEventsService: RealtimeEventsService,
  ) {
    this.secretKey = buildAppConnectorSecretKey(
      process.env.PLATFORM_SECRETS_KEY || process.env.OUTBOUND_PROXY_ENCRYPTION_KEY || this.config.jwt.secret,
    );
  }

  async listConnectors(appRef: string) {
    const app = await this.resolveApp(appRef);
    const rows = await (this.prisma.$queryRawUnsafe(
      `
        SELECT c.*,
               COALESCE(a.action_count, 0)::int AS action_count,
               COALESCE(k.credential_count, 0)::int AS credential_count,
               COALESCE(r.run_count_24h, 0)::int AS run_count_24h,
               COALESCE(r.failure_count_24h, 0)::int AS failure_count_24h,
               r.last_run_at
          FROM app_connectors c
          LEFT JOIN LATERAL (
            SELECT COUNT(*)::int AS action_count
              FROM app_connector_actions
             WHERE connector_id = c.id AND status <> 'DELETED'
          ) a ON true
          LEFT JOIN LATERAL (
            SELECT COUNT(*)::int AS credential_count
              FROM app_connector_credentials
             WHERE connector_id = c.id AND status <> 'DELETED'
          ) k ON true
          LEFT JOIN LATERAL (
            SELECT COUNT(*)::int AS run_count_24h,
                   COUNT(*) FILTER (WHERE status IN ('FAILED', 'TIMEOUT', 'CANCELED'))::int AS failure_count_24h,
                   MAX(created_at) AS last_run_at
              FROM app_connector_runs
             WHERE connector_id = c.id
               AND created_at >= now() - interval '24 hours'
          ) r ON true
         WHERE c.app_id = $1::uuid
           AND c.status <> 'DELETED'
         ORDER BY c.updated_at DESC, c.created_at DESC
      `,
      app.id,
    )) as Array<AppConnectorRow & Record<string, unknown>>;
    return { app, items: rows.map((row) => this.serializeConnector(row)) };
  }

  async createConnector(appRef: string, actor: any, body: Record<string, unknown>) {
    const app = await this.resolveApp(appRef);
    const input = this.normalizeConnectorInput(body, null);
    await this.assertConnectorSlugAvailable(app.id, input.slug);
    const rows = await (this.prisma.$queryRawUnsafe(
      `
        INSERT INTO app_connectors (
          app_id, slug, name, base_url, outbound_proxy_id, timeout_ms, retry_json,
          rate_limit_json, security_json, status, notes, created_by_user_id, updated_by_user_id
        ) VALUES ($1::uuid, $2, $3, $4, $5::uuid, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12::uuid, $12::uuid)
        RETURNING *
      `,
      app.id,
      input.slug,
      input.name,
      input.baseUrl,
      this.nullableUuid(input.outboundProxyId),
      input.timeoutMs,
      JSON.stringify(input.retry),
      JSON.stringify(input.rateLimit),
      JSON.stringify(input.security),
      input.status,
      input.notes,
      this.actorUserId(actor),
    )) as AppConnectorRow[];
    return { ok: true, app, connector: this.serializeConnector(rows[0]) };
  }

  async updateConnector(appRef: string, connectorRef: string, actor: any, body: Record<string, unknown>) {
    const app = await this.resolveApp(appRef);
    const existing = await this.resolveConnector(app.id, connectorRef, true);
    const input = this.normalizeConnectorInput(body, existing);
    if (input.slug !== existing.slug) {
      await this.assertConnectorSlugAvailable(app.id, input.slug, existing.id);
    }
    const rows = await (this.prisma.$queryRawUnsafe(
      `
        UPDATE app_connectors
           SET slug = $3,
               name = $4,
               base_url = $5,
               outbound_proxy_id = $6::uuid,
               timeout_ms = $7,
               retry_json = $8::jsonb,
               rate_limit_json = $9::jsonb,
               security_json = $10::jsonb,
               status = $11,
               notes = $12,
               updated_by_user_id = $13::uuid,
               updated_at = now()
         WHERE app_id = $1::uuid AND id = $2::uuid
         RETURNING *
      `,
      app.id,
      existing.id,
      input.slug,
      input.name,
      input.baseUrl,
      this.nullableUuid(input.outboundProxyId),
      input.timeoutMs,
      JSON.stringify(input.retry),
      JSON.stringify(input.rateLimit),
      JSON.stringify(input.security),
      input.status,
      input.notes,
      this.actorUserId(actor),
    )) as AppConnectorRow[];
    return { ok: true, app, connector: this.serializeConnector(rows[0]) };
  }

  async deleteConnector(appRef: string, connectorRef: string, actor: any) {
    const app = await this.resolveApp(appRef);
    const connector = await this.resolveConnector(app.id, connectorRef, true);
    await this.prisma.$executeRawUnsafe(
      `UPDATE app_connectors SET status = 'DELETED', updated_by_user_id = $3::uuid, updated_at = now() WHERE app_id = $1::uuid AND id = $2::uuid`,
      app.id,
      connector.id,
      this.actorUserId(actor),
    );
    return { ok: true, deleted: true, app, connector: this.serializeConnector({ ...connector, status: 'DELETED' }) };
  }

  async listCredentials(appRef: string, connectorRef: string) {
    const app = await this.resolveApp(appRef);
    const connector = await this.resolveConnector(app.id, connectorRef, true);
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
         FROM app_connector_credentials
        WHERE app_id = $1::uuid
          AND connector_id = $2::uuid
          AND status <> 'DELETED'
        ORDER BY updated_at DESC, created_at DESC`,
      app.id,
      connector.id,
    )) as AppConnectorCredentialRow[];
    return { app, connector: this.serializeConnector(connector), items: rows.map((row) => this.serializeCredential(row)) };
  }

  async createCredential(appRef: string, connectorRef: string, actor: any, body: Record<string, unknown>) {
    const app = await this.resolveApp(appRef);
    const connector = await this.resolveConnector(app.id, connectorRef, true);
    const input = this.normalizeCredentialInput(body, null);
    await this.assertCredentialSlugAvailable(connector.id, input.slug);
    const rows = await (this.prisma.$queryRawUnsafe(
      `
        INSERT INTO app_connector_credentials (
          app_id, connector_id, slug, auth_mode, public_config_json, secret_json_encrypted,
          status, notes, created_by_user_id, updated_by_user_id
        ) VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6, $7, $8, $9::uuid, $9::uuid)
        RETURNING *
      `,
      app.id,
      connector.id,
      input.slug,
      input.authMode,
      JSON.stringify(input.publicConfig),
      encryptAppConnectorSecretJson(input.secrets, this.secretKey),
      input.status,
      input.notes,
      this.actorUserId(actor),
    )) as AppConnectorCredentialRow[];
    return { ok: true, app, connector: this.serializeConnector(connector), credential: this.serializeCredential(rows[0]) };
  }

  async updateCredential(appRef: string, connectorRef: string, credentialRef: string, actor: any, body: Record<string, unknown>) {
    const app = await this.resolveApp(appRef);
    const connector = await this.resolveConnector(app.id, connectorRef, true);
    const existing = await this.resolveCredentialRow(app.id, connector.id, credentialRef, true);
    const input = this.normalizeCredentialInput(body, existing);
    if (input.slug !== existing.slug) {
      await this.assertCredentialSlugAvailable(connector.id, input.slug, existing.id);
    }
    const existingSecrets = decryptAppConnectorSecretJson(existing.secret_json_encrypted, this.secretKey);
    const nextSecrets = body.secrets === undefined && body.secret_json === undefined
      ? existingSecrets
      : input.secrets;
    const rows = await (this.prisma.$queryRawUnsafe(
      `
        UPDATE app_connector_credentials
           SET slug = $4,
               auth_mode = $5,
               public_config_json = $6::jsonb,
               secret_json_encrypted = $7,
               status = $8,
               notes = $9,
               updated_by_user_id = $10::uuid,
               updated_at = now()
         WHERE app_id = $1::uuid
           AND connector_id = $2::uuid
           AND id = $3::uuid
         RETURNING *
      `,
      app.id,
      connector.id,
      existing.id,
      input.slug,
      input.authMode,
      JSON.stringify(input.publicConfig),
      encryptAppConnectorSecretJson(nextSecrets, this.secretKey),
      input.status,
      input.notes,
      this.actorUserId(actor),
    )) as AppConnectorCredentialRow[];
    return { ok: true, app, connector: this.serializeConnector(connector), credential: this.serializeCredential(rows[0]) };
  }

  async deleteCredential(appRef: string, connectorRef: string, credentialRef: string, actor: any) {
    const app = await this.resolveApp(appRef);
    const connector = await this.resolveConnector(app.id, connectorRef, true);
    const credential = await this.resolveCredentialRow(app.id, connector.id, credentialRef, true);
    await this.prisma.$executeRawUnsafe(
      `UPDATE app_connector_credentials SET status = 'DELETED', updated_by_user_id = $4::uuid, updated_at = now()
        WHERE app_id = $1::uuid AND connector_id = $2::uuid AND id = $3::uuid`,
      app.id,
      connector.id,
      credential.id,
      this.actorUserId(actor),
    );
    return { ok: true, deleted: true, app, connector: this.serializeConnector(connector), credential: this.serializeCredential({ ...credential, status: 'DELETED' }) };
  }

  async listActions(appRef: string, connectorRef: string) {
    const app = await this.resolveApp(appRef);
    const connector = await this.resolveConnector(app.id, connectorRef, true);
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
         FROM app_connector_actions
        WHERE app_id = $1::uuid
          AND connector_id = $2::uuid
          AND status <> 'DELETED'
        ORDER BY updated_at DESC, created_at DESC`,
      app.id,
      connector.id,
    )) as AppConnectorActionRow[];
    return { app, connector: this.serializeConnector(connector), items: rows.map((row) => this.serializeAction(row)) };
  }

  async createAction(appRef: string, connectorRef: string, actor: any, body: Record<string, unknown>) {
    const app = await this.resolveApp(appRef);
    const connector = await this.resolveConnector(app.id, connectorRef, true);
    const input = await this.normalizeActionInput(app.id, connector.id, body, null);
    await this.assertActionRouteAvailable(connector.id, input.slug, input.method, input.pathTemplate);
    const rows = await (this.prisma.$queryRawUnsafe(
      `
        INSERT INTO app_connector_actions (
          app_id, connector_id, credential_id, slug, name, method, path_template,
          input_schema_json, request_mapping_json, response_mapping_json, error_mapping_json,
          execution_mode, poller_json, cache_json, status, created_by_user_id, updated_by_user_id
        ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13::jsonb, $14::jsonb, $15, $16::uuid, $16::uuid)
        RETURNING *
      `,
      app.id,
      connector.id,
      this.nullableUuid(input.credentialId),
      input.slug,
      input.name,
      input.method,
      input.pathTemplate,
      JSON.stringify(input.inputSchema),
      JSON.stringify(input.requestMapping),
      JSON.stringify(input.responseMapping),
      JSON.stringify(input.errorMapping),
      input.executionMode,
      JSON.stringify(input.poller),
      JSON.stringify(input.cache),
      input.status,
      this.actorUserId(actor),
    )) as AppConnectorActionRow[];
    return { ok: true, app, connector: this.serializeConnector(connector), action: this.serializeAction(rows[0]) };
  }

  async updateAction(appRef: string, connectorRef: string, actionRef: string, actor: any, body: Record<string, unknown>) {
    const app = await this.resolveApp(appRef);
    const connector = await this.resolveConnector(app.id, connectorRef, true);
    const existing = await this.resolveAction(app.id, connector.id, actionRef, true);
    const input = await this.normalizeActionInput(app.id, connector.id, body, existing);
    await this.assertActionRouteAvailable(connector.id, input.slug, input.method, input.pathTemplate, existing.id);
    const rows = await (this.prisma.$queryRawUnsafe(
      `
        UPDATE app_connector_actions
           SET credential_id = $4::uuid,
               slug = $5,
               name = $6,
               method = $7,
               path_template = $8,
               input_schema_json = $9::jsonb,
               request_mapping_json = $10::jsonb,
               response_mapping_json = $11::jsonb,
               error_mapping_json = $12::jsonb,
               execution_mode = $13,
               poller_json = $14::jsonb,
               cache_json = $15::jsonb,
               status = $16,
               updated_by_user_id = $17::uuid,
               updated_at = now()
         WHERE app_id = $1::uuid
           AND connector_id = $2::uuid
           AND id = $3::uuid
         RETURNING *
      `,
      app.id,
      connector.id,
      existing.id,
      this.nullableUuid(input.credentialId),
      input.slug,
      input.name,
      input.method,
      input.pathTemplate,
      JSON.stringify(input.inputSchema),
      JSON.stringify(input.requestMapping),
      JSON.stringify(input.responseMapping),
      JSON.stringify(input.errorMapping),
      input.executionMode,
      JSON.stringify(input.poller),
      JSON.stringify(input.cache),
      input.status,
      this.actorUserId(actor),
    )) as AppConnectorActionRow[];
    return { ok: true, app, connector: this.serializeConnector(connector), action: this.serializeAction(rows[0]) };
  }

  async deleteAction(appRef: string, connectorRef: string, actionRef: string, actor: any) {
    const app = await this.resolveApp(appRef);
    const connector = await this.resolveConnector(app.id, connectorRef, true);
    const action = await this.resolveAction(app.id, connector.id, actionRef, true);
    await this.prisma.$executeRawUnsafe(
      `UPDATE app_connector_actions SET status = 'DELETED', updated_by_user_id = $4::uuid, updated_at = now()
        WHERE app_id = $1::uuid AND connector_id = $2::uuid AND id = $3::uuid`,
      app.id,
      connector.id,
      action.id,
      this.actorUserId(actor),
    );
    return { ok: true, deleted: true, app, connector: this.serializeConnector(connector), action: this.serializeAction({ ...action, status: 'DELETED' }) };
  }

  async invokeAction(appRef: string, connectorRef: string, actionRef: string, actor: any, body: InvocationInput | Record<string, unknown>) {
    const app = await this.resolveApp(appRef);
    const connector = await this.resolveConnector(app.id, connectorRef, false);
    const action = await this.resolveAction(app.id, connector.id, actionRef, false);
    const payload = asPlainObject(body);
    const input = payload.input !== undefined ? payload.input : body;
    const triggerType = String(payload.trigger_type || payload.triggerType || 'manual').slice(0, 40);
    this.validateInputSchema(action, input);
    const credential = await this.resolveRuntimeCredential(app.id, connector.id, action, payload);
    const run = await this.createRun(app, connector, action, credential, actor, triggerType, input);
    const startedAt = Date.now();
    let runFinished = false;

    try {
      const request = await this.buildRequest(app, connector, action, credential, input);
      await this.updateRunRequest(run.id, request.summary);
      const response = await this.outboundHttp.fetch(request.url, request.init, {
        proxyId: connector.outbound_proxy_id,
        timeoutMs: Number(connector.timeout_ms || DEFAULT_TIMEOUT_MS),
      });
      const responsePayload = await this.readResponsePayload(response);
      const output = this.mapResponse(action, response, responsePayload);
      const statusCode = response.status;
      const latencyMs = Date.now() - startedAt;
      if (!response.ok) {
        const errorJson = this.mapError(action, response, responsePayload);
        await this.finishRun(run.id, 'FAILED', statusCode, latencyMs, null, errorJson, responsePayload.summary);
        runFinished = true;
        await this.publishRun(app, run.id, 'connector.failed', { connector: connector.slug, action: action.slug, status_code: statusCode });
        throw new BadGatewayException(errorJson.message || `Connector upstream failed with ${statusCode}`);
      }
      const completed = await this.finishRun(run.id, 'SUCCEEDED', statusCode, latencyMs, output, null, responsePayload.summary);
      runFinished = true;
      await this.publishRun(app, run.id, 'connector.succeeded', { connector: connector.slug, action: action.slug, status_code: statusCode });
      return {
        ok: true,
        app,
        connector: this.serializeConnector(connector),
        action: this.serializeAction(action),
        run: this.serializeRun(completed),
        output,
      };
    } catch (error: any) {
      const latencyMs = Date.now() - startedAt;
      const errorJson = { message: String(error?.message || error).slice(0, 2000) };
      if (!runFinished) {
        await this.finishRun(run.id, 'FAILED', null, latencyMs, null, errorJson, {});
        await this.publishRun(app, run.id, 'connector.failed', { connector: connector.slug, action: action.slug, error: errorJson.message });
        this.logger.warn(`connector invoke failed app=${app.slug} connector=${connector.slug} action=${action.slug}: ${errorJson.message}`);
      }
      if (error instanceof BadGatewayException || error instanceof BadRequestException || error instanceof PayloadTooLargeException) {
        throw error;
      }
      throw new BadGatewayException(errorJson.message);
    }
  }

  async listRuns(appRef: string, connectorRef: string, actionRef?: string) {
    const app = await this.resolveApp(appRef);
    const connector = await this.resolveConnector(app.id, connectorRef, true);
    const params: unknown[] = [app.id, connector.id];
    const where = [`app_id = $1::uuid`, `connector_id = $2::uuid`];
    if (actionRef) {
      const action = await this.resolveAction(app.id, connector.id, actionRef, true);
      params.push(action.id);
      where.push(`action_id = $${params.length}::uuid`);
    }
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
         FROM app_connector_runs
        WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC
        LIMIT 100`,
      ...params,
    )) as AppConnectorRunRow[];
    return { app, connector: this.serializeConnector(connector), items: rows.map((row) => this.serializeRun(row)) };
  }

  private async buildRequest(
    app: AppRef,
    connector: AppConnectorRow,
    action: AppConnectorActionRow,
    credential: AppConnectorCredentialRow | null,
    input: unknown,
  ) {
    const mapping = asPlainObject(action.request_mapping_json);
    const secrets = credential ? decryptAppConnectorSecretJson(credential.secret_json_encrypted, this.secretKey) : {};
    const credentialConfig = credential ? asPlainObject(credential.public_config_json) : {};
    const baseUrl = this.normalizeBaseUrl(connector.base_url, asPlainObject(connector.security_json));
    const bodyValue = this.resolveRequestBody(action.method, mapping, input, { app, connector, action, secret: secrets });
    const bodyText = bodyValue === undefined ? undefined : JSON.stringify(bodyValue);
    if (bodyText && Buffer.byteLength(bodyText, 'utf8') > MAX_REQUEST_BYTES) {
      throw new PayloadTooLargeException(`connector request body exceeds ${MAX_REQUEST_BYTES} bytes`);
    }
    const bodySha256 = bodyText ? createHash('sha256').update(bodyText).digest('hex') : '';
    const scope = { input, context: { app_id: app.id, app_slug: app.slug }, connector, action, secret: secrets, body_sha256: bodySha256 };
    const url = this.buildUrl(baseUrl, action.path_template, mapping, scope);
    const headers = new Headers();
    headers.set('accept', 'application/json, text/plain;q=0.9, */*;q=0.5');
    if (bodyText !== undefined) {
      headers.set('content-type', String(mapping.content_type || mapping.contentType || 'application/json'));
    }
    this.applyTemplateHeaders(headers, asPlainObject(mapping.headers), scope);
    this.applyCredentialAuth(headers, url, credential, credentialConfig, secrets, bodyText || '', bodySha256, scope);
    const init: RequestInit = {
      method: action.method,
      headers,
    };
    if (bodyText !== undefined && action.method !== 'GET' && action.method !== 'HEAD') {
      init.body = bodyText;
    }
    return {
      url: url.toString(),
      init,
      summary: {
        method: action.method,
        url: this.redactUrl(url),
        header_keys: Array.from(headers.keys()).filter((key) => !this.isSecretHeader(key)),
        auth_mode: credential?.auth_mode || 'none',
        credential_id: credential?.id || null,
        body_bytes: bodyText ? Buffer.byteLength(bodyText, 'utf8') : 0,
      },
    };
  }

  private applyCredentialAuth(
    headers: Headers,
    url: URL,
    credential: AppConnectorCredentialRow | null,
    config: Record<string, any>,
    secrets: Record<string, unknown>,
    bodyText: string,
    bodySha256: string,
    scope: Record<string, unknown>,
  ) {
    const mode = credential?.auth_mode || 'none';
    if (mode === 'none') return;
    if (mode === 'bearer') {
      const token = this.stringValue(secrets.token || secrets.api_key || secrets.apiKey);
      if (token) headers.set('authorization', `Bearer ${token}`);
      return;
    }
    if (mode === 'basic') {
      const username = this.stringValue(secrets.username || config.username);
      const password = this.stringValue(secrets.password);
      headers.set('authorization', `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`);
      return;
    }
    if (mode === 'api_key_header') {
      const headerName = this.stringValue(config.header_name || config.headerName || 'x-api-key');
      const apiKey = this.stringValue(secrets.api_key || secrets.apiKey || secrets.token);
      if (headerName && apiKey) headers.set(headerName, apiKey);
      return;
    }
    if (mode === 'api_key_query') {
      const queryName = this.stringValue(config.query_name || config.queryName || 'api_key');
      const apiKey = this.stringValue(secrets.api_key || secrets.apiKey || secrets.token);
      if (queryName && apiKey) url.searchParams.set(queryName, apiKey);
      return;
    }
    if (mode === 'hmac_sha256') {
      const secret = this.stringValue(secrets.signing_key || secrets.secret || secrets.api_secret || secrets.apiSecret);
      const headerName = this.stringValue(config.header_name || config.headerName || 'x-signature');
      const payload = this.renderString(this.stringValue(config.payload_template || config.payloadTemplate || '{{body_sha256}}'), scope);
      if (secret && headerName) {
        headers.set(headerName, createHmac('sha256', secret).update(payload || bodyText).digest('hex'));
      }
      return;
    }
    if (mode === 'custom_template') {
      this.applyTemplateHeaders(headers, asPlainObject(config.headers), scope);
      const query = asPlainObject(config.query);
      Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, this.stringValue(this.renderAny(value, scope))));
    }
  }

  private buildUrl(baseUrl: URL, pathTemplate: string, mapping: Record<string, any>, scope: Record<string, unknown>) {
    const rawPath = this.renderString(pathTemplate, scope).trim();
    if (/^https?:\/\//i.test(rawPath)) {
      throw new BadRequestException('connector action path_template must be relative to connector base_url');
    }
    const base = baseUrl.toString().endsWith('/') ? baseUrl.toString() : `${baseUrl.toString()}/`;
    const url = new URL(rawPath || '.', base);
    const query = asPlainObject(mapping.query);
    Object.entries(query).forEach(([key, value]) => {
      const rendered = this.renderAny(value, scope);
      if (rendered === undefined || rendered === null || rendered === '') return;
      if (Array.isArray(rendered)) {
        rendered.forEach((item) => url.searchParams.append(key, this.stringValue(item)));
        return;
      }
      url.searchParams.set(key, this.stringValue(rendered));
    });
    return url;
  }

  private resolveRequestBody(method: string, mapping: Record<string, any>, input: unknown, scope: Record<string, unknown>) {
    if (mapping.body !== undefined) {
      return this.renderAny(mapping.body, scope);
    }
    if (mapping.body_path || mapping.bodyPath) {
      return this.lookupPath(scope, String(mapping.body_path || mapping.bodyPath));
    }
    if (method === 'GET' || method === 'HEAD') {
      return undefined;
    }
    return input;
  }

  private async readResponsePayload(response: Response) {
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      throw new PayloadTooLargeException(`connector response body exceeds ${MAX_RESPONSE_BYTES} bytes`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_RESPONSE_BYTES) {
      throw new PayloadTooLargeException(`connector response body exceeds ${MAX_RESPONSE_BYTES} bytes`);
    }
    const text = buffer.toString('utf8');
    const contentType = response.headers.get('content-type') || '';
    let body: unknown = text;
    if (contentType.includes('json') && text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return {
      body,
      text,
      summary: {
        status_code: response.status,
        content_type: contentType || null,
        body_bytes: buffer.byteLength,
        upstream_request_id: response.headers.get('x-request-id') || response.headers.get('request-id') || null,
      },
    };
  }

  private mapResponse(action: AppConnectorActionRow, response: Response, responsePayload: { body: unknown; text: string; summary: Record<string, unknown> }) {
    const mapping = asPlainObject(action.response_mapping_json);
    const base = {
      status_code: response.status,
      headers: this.safeResponseHeaders(response.headers),
      body: responsePayload.body,
      text: responsePayload.text,
    };
    const scope = { response: base, body: responsePayload.body, text: responsePayload.text };
    if (mapping.output_path || mapping.outputPath) {
      return this.lookupPath(scope, String(mapping.output_path || mapping.outputPath));
    }
    const pick = asPlainObject(mapping.pick);
    if (Object.keys(pick).length > 0) {
      const output: Record<string, unknown> = { status_code: response.status };
      Object.entries(pick).forEach(([key, path]) => {
        output[key] = this.lookupPath(scope, String(path));
      });
      return output;
    }
    return base;
  }

  private mapError(action: AppConnectorActionRow, response: Response, responsePayload: { body: unknown; text: string }) {
    const mapping = asPlainObject(action.error_mapping_json);
    const scope = { response: { status_code: response.status, body: responsePayload.body, text: responsePayload.text }, body: responsePayload.body, text: responsePayload.text };
    const messagePath = this.stringValue(mapping.message_path || mapping.messagePath);
    const mappedMessage = messagePath ? this.lookupPath(scope, messagePath) : undefined;
    const fallback = typeof responsePayload.body === 'string'
      ? responsePayload.body.slice(0, 1200)
      : JSON.stringify(responsePayload.body || {}).slice(0, 1200);
    return {
      message: this.stringValue(mappedMessage) || fallback || `Connector upstream failed with ${response.status}`,
      status_code: response.status,
      body: responsePayload.body,
    };
  }

  private validateInputSchema(action: AppConnectorActionRow, input: unknown) {
    const schema = asPlainObject(action.input_schema_json);
    if (Object.keys(schema).length === 0) return;
    const validate = this.ajv.compile(schema);
    if (!validate(input)) {
      const message = this.ajv.errorsText(validate.errors, { separator: '; ' });
      throw new BadRequestException(`connector input failed schema validation: ${message}`);
    }
  }

  private async createRun(app: AppRef, connector: AppConnectorRow, action: AppConnectorActionRow, credential: AppConnectorCredentialRow | null, actor: any, triggerType: string, input: unknown) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `
        INSERT INTO app_connector_runs (
          app_id, connector_id, action_id, credential_id, actor_user_id, trigger_type,
          input_json, status, started_at
        ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7::jsonb, 'RUNNING', now())
        RETURNING *
      `,
      app.id,
      connector.id,
      action.id,
      this.nullableUuid(credential?.id),
      this.actorUserId(actor),
      triggerType,
      JSON.stringify(input ?? {}),
    )) as AppConnectorRunRow[];
    await this.publishRun(app, rows[0].id, 'connector.running', { connector: connector.slug, action: action.slug });
    return rows[0];
  }

  private async updateRunRequest(runId: string, requestSummary: Record<string, unknown>) {
    await this.prisma.$executeRawUnsafe(
      `UPDATE app_connector_runs SET request_summary_json = $2::jsonb, updated_at = now() WHERE id = $1::uuid`,
      runId,
      JSON.stringify(requestSummary),
    );
  }

  private async finishRun(
    runId: string,
    status: string,
    statusCode: number | null,
    latencyMs: number,
    output: unknown,
    error: unknown,
    responseSummary: Record<string, unknown>,
  ) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `
        UPDATE app_connector_runs
           SET status = $2,
               status_code = $3,
               latency_ms = $4,
               output_json = $5::jsonb,
               error_json = $6::jsonb,
               response_summary_json = $7::jsonb,
               finished_at = now(),
               updated_at = now()
         WHERE id = $1::uuid
         RETURNING *
      `,
      runId,
      status,
      statusCode,
      latencyMs,
      output === null || output === undefined ? null : JSON.stringify(output),
      error === null || error === undefined ? null : JSON.stringify(error),
      JSON.stringify(responseSummary || {}),
    )) as AppConnectorRunRow[];
    return rows[0];
  }

  private async publishRun(app: AppRef, runId: string, event: string, payload: Record<string, unknown>) {
    await this.realtimeEventsService.publish(
      `apps.${app.slug}.connectors.${runId}`,
      event,
      payload,
      { app_id: app.id, app_slug: app.slug, resource_id: runId },
    ).catch(() => undefined);
  }

  private normalizeConnectorInput(body: Record<string, unknown>, existing: AppConnectorRow | null) {
    const slug = body.slug === undefined && existing ? existing.slug : this.normalizeIdentifier(body.slug || body.name, 'connector slug');
    const name = this.stringValue(body.name ?? existing?.name ?? slug).slice(0, 160) || slug;
    const baseUrl = this.normalizeBaseUrlString(body.base_url ?? body.baseUrl ?? existing?.base_url);
    const status = this.normalizeStatus(body.status ?? existing?.status ?? 'ACTIVE');
    const timeoutMs = this.intValue(body.timeout_ms ?? body.timeoutMs ?? existing?.timeout_ms, DEFAULT_TIMEOUT_MS, 1000, 600_000);
    return {
      slug,
      name,
      baseUrl,
      outboundProxyId: this.stringValue(body.outbound_proxy_id ?? body.outboundProxyId ?? existing?.outbound_proxy_id),
      timeoutMs,
      retry: asPlainObject(body.retry_json ?? body.retry ?? existing?.retry_json),
      rateLimit: asPlainObject(body.rate_limit_json ?? body.rateLimit ?? existing?.rate_limit_json),
      security: asPlainObject(body.security_json ?? body.security ?? existing?.security_json),
      status,
      notes: this.optionalString(body.notes ?? existing?.notes, 4000),
    };
  }

  private normalizeCredentialInput(body: Record<string, unknown>, existing: AppConnectorCredentialRow | null) {
    const slug = body.slug === undefined && existing ? existing.slug : this.normalizeIdentifier(body.slug || body.name, 'credential slug');
    const authMode = String(body.auth_mode ?? body.authMode ?? existing?.auth_mode ?? 'none').trim();
    if (!AUTH_MODES.has(authMode)) throw new BadRequestException(`auth_mode must be one of: ${Array.from(AUTH_MODES).join(', ')}`);
    return {
      slug,
      authMode,
      publicConfig: asPlainObject(body.public_config_json ?? body.publicConfig ?? body.config ?? existing?.public_config_json),
      secrets: asPlainObject(body.secrets ?? body.secret_json),
      status: this.normalizeStatus(body.status ?? existing?.status ?? 'ACTIVE'),
      notes: this.optionalString(body.notes ?? existing?.notes, 4000),
    };
  }

  private async normalizeActionInput(appId: string, connectorId: string, body: Record<string, unknown>, existing: AppConnectorActionRow | null) {
    const slug = body.slug === undefined && existing ? existing.slug : this.normalizeIdentifier(body.slug || body.name, 'action slug');
    const method = String(body.method ?? existing?.method ?? 'POST').trim().toUpperCase();
    if (!HTTP_METHODS.has(method)) throw new BadRequestException(`method must be one of: ${Array.from(HTTP_METHODS).join(', ')}`);
    const pathTemplate = this.normalizePathTemplate(body.path_template ?? body.pathTemplate ?? existing?.path_template);
    const credentialRef = this.stringValue(body.credential_id ?? body.credentialId ?? body.credential_slug ?? body.credentialSlug ?? existing?.credential_id);
    const credentialId = credentialRef ? (await this.resolveCredentialRow(appId, connectorId, credentialRef, true)).id : null;
    const executionMode = String(body.execution_mode ?? body.executionMode ?? existing?.execution_mode ?? 'sync').trim();
    if (!['sync', 'async_poll'].includes(executionMode)) throw new BadRequestException('execution_mode must be sync or async_poll');
    return {
      slug,
      name: this.optionalString(body.name ?? existing?.name, 160),
      method,
      pathTemplate,
      credentialId,
      inputSchema: asPlainObject(body.input_schema_json ?? body.inputSchema ?? existing?.input_schema_json),
      requestMapping: asPlainObject(body.request_mapping_json ?? body.requestMapping ?? existing?.request_mapping_json),
      responseMapping: asPlainObject(body.response_mapping_json ?? body.responseMapping ?? existing?.response_mapping_json),
      errorMapping: asPlainObject(body.error_mapping_json ?? body.errorMapping ?? existing?.error_mapping_json),
      executionMode,
      poller: asPlainObject(body.poller_json ?? body.poller ?? existing?.poller_json),
      cache: asPlainObject(body.cache_json ?? body.cache ?? existing?.cache_json),
      status: this.normalizeStatus(body.status ?? existing?.status ?? 'ACTIVE'),
    };
  }

  private async resolveRuntimeCredential(appId: string, connectorId: string, action: AppConnectorActionRow, payload: Record<string, any>) {
    const explicitRef = this.stringValue(payload.credential || payload.credential_id || payload.credential_slug || payload.credentialId || payload.credentialSlug);
    if (explicitRef) return this.resolveCredentialRow(appId, connectorId, explicitRef, false);
    if (action.credential_id) return this.resolveCredentialRow(appId, connectorId, action.credential_id, false);
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
         FROM app_connector_credentials
        WHERE app_id = $1::uuid
          AND connector_id = $2::uuid
          AND status = 'ACTIVE'
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1`,
      appId,
      connectorId,
    )) as AppConnectorCredentialRow[];
    return rows[0] || null;
  }

  private async resolveConnector(appId: string, connectorRef: string, includeInactive: boolean) {
    const ref = String(connectorRef || '').trim();
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
         FROM app_connectors
        WHERE app_id = $1::uuid
          AND (id::text = $2 OR slug = $2)
          AND status <> 'DELETED'
        LIMIT 1`,
      appId,
      ref,
    )) as AppConnectorRow[];
    const connector = rows[0];
    if (!connector) throw new NotFoundException('connector not found');
    if (!includeInactive && connector.status !== 'ACTIVE') throw new BadRequestException('connector is not active');
    return connector;
  }

  private async resolveCredentialRow(appId: string, connectorId: string, credentialRef: string, includeInactive: boolean) {
    const ref = String(credentialRef || '').trim();
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
         FROM app_connector_credentials
        WHERE app_id = $1::uuid
          AND connector_id = $2::uuid
          AND (id::text = $3 OR slug = $3)
          AND status <> 'DELETED'
        LIMIT 1`,
      appId,
      connectorId,
      ref,
    )) as AppConnectorCredentialRow[];
    const credential = rows[0];
    if (!credential) throw new NotFoundException('connector credential not found');
    if (!includeInactive && credential.status !== 'ACTIVE') throw new BadRequestException('connector credential is not active');
    return credential;
  }

  private async resolveAction(appId: string, connectorId: string, actionRef: string, includeInactive: boolean) {
    const ref = String(actionRef || '').trim();
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
         FROM app_connector_actions
        WHERE app_id = $1::uuid
          AND connector_id = $2::uuid
          AND (id::text = $3 OR slug = $3)
          AND status <> 'DELETED'
        LIMIT 1`,
      appId,
      connectorId,
      ref,
    )) as AppConnectorActionRow[];
    const action = rows[0];
    if (!action) throw new NotFoundException('connector action not found');
    if (!includeInactive && action.status !== 'ACTIVE') throw new BadRequestException('connector action is not active');
    return action;
  }

  private async assertConnectorSlugAvailable(appId: string, slug: string, excludeId?: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id
         FROM app_connectors
        WHERE app_id = $1::uuid
          AND slug = $2
          AND status <> 'DELETED'
          AND ($3::uuid IS NULL OR id <> $3::uuid)
        LIMIT 1`,
      appId,
      slug,
      this.nullableUuid(excludeId),
    )) as Array<{ id: string }>;
    if (rows[0]) throw new ConflictException(`connector slug already exists: ${slug}`);
  }

  private async assertCredentialSlugAvailable(connectorId: string, slug: string, excludeId?: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id
         FROM app_connector_credentials
        WHERE connector_id = $1::uuid
          AND slug = $2
          AND status <> 'DELETED'
          AND ($3::uuid IS NULL OR id <> $3::uuid)
        LIMIT 1`,
      connectorId,
      slug,
      this.nullableUuid(excludeId),
    )) as Array<{ id: string }>;
    if (rows[0]) throw new ConflictException(`connector credential slug already exists: ${slug}`);
  }

  private async assertActionRouteAvailable(connectorId: string, slug: string, method: string, pathTemplate: string, excludeId?: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id, slug, method, path_template
         FROM app_connector_actions
        WHERE connector_id = $1::uuid
          AND status <> 'DELETED'
          AND ($5::uuid IS NULL OR id <> $5::uuid)
          AND (slug = $2 OR (method = $3 AND path_template = $4))
        LIMIT 1`,
      connectorId,
      slug,
      method,
      pathTemplate,
      this.nullableUuid(excludeId),
    )) as Array<{ id: string; slug: string; method: string; path_template: string }>;
    const existing = rows[0];
    if (!existing) return;
    if (existing.slug === slug) throw new ConflictException(`connector action slug already exists: ${slug}`);
    throw new ConflictException(`connector action route already exists: ${method} ${pathTemplate}`);
  }

  private normalizeBaseUrlString(value: unknown) {
    const raw = this.stringValue(value);
    if (!raw) throw new BadRequestException('base_url is required');
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new BadRequestException('base_url must be a valid absolute URL');
    }
    if (!['http:', 'https:'].includes(url.protocol)) throw new BadRequestException('base_url must use http or https');
    if (url.username || url.password) throw new BadRequestException('base_url must not include credentials');
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  }

  private normalizeBaseUrl(value: string, security: Record<string, unknown>) {
    const url = new URL(this.normalizeBaseUrlString(value));
    const allowPrivate = security.allow_private_network === true || String(security.allow_private_network || '').toLowerCase() === 'true';
    if (!allowPrivate && this.isPrivateHost(url.hostname)) {
      throw new BadRequestException('connector base_url points to a private or local host; set security.allow_private_network only for trusted internal connectors');
    }
    return url;
  }

  private isPrivateHost(hostname: string) {
    const host = hostname.toLowerCase();
    if (['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(host)) return true;
    if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
    const match = host.match(/^172\.(\d+)\./);
    if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
    if (host.endsWith('.local')) return true;
    return false;
  }

  private normalizePathTemplate(value: unknown) {
    const path = this.stringValue(value);
    if (!path) throw new BadRequestException('path_template is required');
    if (/^https?:\/\//i.test(path)) throw new BadRequestException('path_template must be relative to connector base_url');
    if (path.length > 2000) throw new BadRequestException('path_template is too long');
    return path;
  }

  private applyTemplateHeaders(headers: Headers, values: Record<string, unknown>, scope: Record<string, unknown>) {
    Object.entries(values).forEach(([key, value]) => {
      const headerName = String(key || '').trim();
      if (!headerName) return;
      const rendered = this.renderAny(value, scope);
      if (rendered === undefined || rendered === null) return;
      headers.set(headerName, this.stringValue(rendered));
    });
  }

  private renderAny(value: unknown, scope: Record<string, unknown>): unknown {
    if (typeof value === 'string') {
      const exact = value.match(/^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/);
      if (exact) return this.lookupPath(scope, exact[1]);
      return this.renderString(value, scope);
    }
    if (Array.isArray(value)) return value.map((item) => this.renderAny(item, scope));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, this.renderAny(item, scope)]));
    }
    return value;
  }

  private renderString(template: string, scope: Record<string, unknown>) {
    return String(template || '').replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, path) => {
      const value = this.lookupPath(scope, String(path || '').trim());
      if (value === undefined || value === null) return '';
      if (typeof value === 'object') return JSON.stringify(value);
      return String(value);
    });
  }

  private lookupPath(scope: Record<string, unknown>, path: string) {
    const normalized = String(path || '').trim().replace(/^\$\.?/, '');
    if (!normalized) return undefined;
    if (normalized in scope) return scope[normalized];
    const parts = normalized.split('.').filter(Boolean);
    let current: any = scope;
    for (const part of parts) {
      if (current === undefined || current === null) return undefined;
      if (Array.isArray(current) && /^\d+$/.test(part)) {
        current = current[Number(part)];
        continue;
      }
      if (typeof current !== 'object') return undefined;
      current = current[part];
    }
    return current;
  }

  private safeResponseHeaders(headers: Headers) {
    const output: Record<string, string> = {};
    const allow = ['content-type', 'cache-control', 'x-request-id', 'request-id'];
    for (const key of allow) {
      const value = headers.get(key);
      if (value) output[key] = value;
    }
    return output;
  }

  private isSecretHeader(key: string) {
    return ['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key'].includes(key.toLowerCase());
  }

  private redactUrl(url: URL) {
    const redacted = new URL(url.toString());
    redacted.username = '';
    redacted.password = '';
    if (redacted.search) redacted.search = '?...';
    return redacted.toString();
  }

  private serializeConnector(row: AppConnectorRow & Record<string, unknown>) {
    return this.serialize({
      id: row.id,
      app_id: row.app_id,
      slug: row.slug,
      name: row.name,
      base_url: row.base_url,
      outbound_proxy_id: row.outbound_proxy_id,
      timeout_ms: row.timeout_ms,
      retry: asPlainObject(row.retry_json),
      rate_limit: asPlainObject(row.rate_limit_json),
      security: asPlainObject(row.security_json),
      status: row.status,
      notes: row.notes,
      action_count: row.action_count,
      credential_count: row.credential_count,
      run_count_24h: row.run_count_24h,
      failure_count_24h: row.failure_count_24h,
      last_run_at: row.last_run_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    });
  }

  private serializeCredential(row: AppConnectorCredentialRow) {
    const secrets = decryptAppConnectorSecretJson(row.secret_json_encrypted, this.secretKey);
    return this.serialize({
      id: row.id,
      app_id: row.app_id,
      connector_id: row.connector_id,
      slug: row.slug,
      auth_mode: row.auth_mode,
      public_config: asPlainObject(row.public_config_json),
      secret_status: Object.fromEntries(Object.entries(secrets).map(([key, value]) => {
        const raw = String(value || '');
        return [key, { configured: raw.length > 0, last_four: raw.slice(-4) }];
      })),
      status: row.status,
      notes: row.notes,
      created_at: row.created_at,
      updated_at: row.updated_at,
    });
  }

  private serializeAction(row: AppConnectorActionRow) {
    return this.serialize({
      id: row.id,
      app_id: row.app_id,
      connector_id: row.connector_id,
      credential_id: row.credential_id,
      slug: row.slug,
      name: row.name,
      method: row.method,
      path_template: row.path_template,
      input_schema: asPlainObject(row.input_schema_json),
      request_mapping: asPlainObject(row.request_mapping_json),
      response_mapping: asPlainObject(row.response_mapping_json),
      error_mapping: asPlainObject(row.error_mapping_json),
      execution_mode: row.execution_mode,
      poller: asPlainObject(row.poller_json),
      cache: asPlainObject(row.cache_json),
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
    });
  }

  private serializeRun(row: AppConnectorRunRow) {
    return this.serialize({
      id: row.id,
      connector_id: row.connector_id,
      action_id: row.action_id,
      credential_id: row.credential_id,
      trigger_type: row.trigger_type,
      input: row.input_json,
      request_summary: row.request_summary_json,
      response_summary: row.response_summary_json,
      output: row.output_json,
      status: row.status,
      status_code: row.status_code,
      latency_ms: row.latency_ms,
      error: row.error_json,
      started_at: row.started_at,
      finished_at: row.finished_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    });
  }

  private async resolveApp(appRef: string): Promise<AppRef> {
    const app = await this.appSchemaService.resolveApp(appRef);
    return { id: app.id, slug: app.slug, name: app.name, status: (app as any).status };
  }

  private normalizeIdentifier(value: unknown, label: string) {
    const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').replace(/_+/g, '_');
    if (!IDENTIFIER_RE.test(normalized)) throw new BadRequestException(`invalid ${label}`);
    return normalized;
  }

  private normalizeStatus(value: unknown) {
    const status = String(value || 'ACTIVE').trim().toUpperCase();
    if (!STATUS_VALUES.has(status)) throw new BadRequestException(`status must be one of: ${Array.from(STATUS_VALUES).join(', ')}`);
    return status;
  }

  private actorUserId(actor: any) {
    return this.nullableUuid(actor?.userId || actor?.id || actor?.sub);
  }

  private nullableUuid(value: unknown) {
    const normalized = String(value || '').trim();
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i.test(normalized) ? normalized : null;
  }

  private intValue(value: unknown, fallback: number, min: number, max: number) {
    const parsed = Number.parseInt(String(value ?? '').trim(), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  }

  private stringValue(value: unknown) {
    return String(value ?? '').trim();
  }

  private optionalString(value: unknown, maxLength: number) {
    const normalized = this.stringValue(value);
    return normalized ? normalized.slice(0, maxLength) : null;
  }

  private serialize(value: unknown): any {
    if (typeof value === 'bigint') return Number(value);
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map((item) => this.serialize(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, this.serialize(item)]));
    }
    return value;
  }
}
