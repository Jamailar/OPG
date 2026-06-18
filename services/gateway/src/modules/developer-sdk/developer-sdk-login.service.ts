import {
  BadRequestException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient, User } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { PRISMA_CLIENT } from '../../config/database.module';
import { AuthService } from '../auth/auth.service';
import { DEFAULT_DEVELOPER_LOGIN_SCOPES, DeveloperAuthorizationService } from './developer-authorization.service';

type AppRow = {
  id: string;
  slug: string;
  name: string;
  status: string;
};

type LoginActor = {
  id?: string | null;
  userId?: string | null;
  email?: string | null;
  role?: string | null;
  appSlug?: string | null;
};

type LoginSessionRow = {
  id: string;
  app_id: string | null;
  app_slug: string | null;
  app_name: string | null;
  selected_app_id: string | null;
  selected_app_slug: string | null;
  selected_app_name: string | null;
  callback_url: string;
  client_name: string;
  profile_name: string;
  session_mode: string;
  status: string;
  expires_at: Date;
  authorized_user_id: string | null;
  exchange_code_hash: string | null;
  requested_scopes_json: unknown;
};

type RequestOptions = {
  baseUrl: string;
};

const LOGIN_SESSION_TTL_MS = 10 * 60 * 1000;
const EXCHANGE_CODE_TTL_MS = 2 * 60 * 1000;

@Injectable()
export class DeveloperSdkLoginService implements OnModuleInit {
  private readonly logger = new Logger(DeveloperSdkLoginService.name);
  private schemaReady = false;
  private schemaPromise: Promise<void> | null = null;

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    private readonly developerAuthorizationService: DeveloperAuthorizationService,
    private readonly authService: AuthService,
  ) {}

  async onModuleInit() {
    try {
      await this.ensureSchema();
    } catch (error: any) {
      this.logger.warn(`developer sdk login schema warmup failed: ${error?.message || error}`);
    }
  }

  async createSession(
    appSlug: string | undefined,
    body: {
      callback_url?: string;
      callbackUrl?: string;
      client?: string;
      profile?: string;
      web_url?: string;
      webUrl?: string;
      scopes?: unknown;
    },
    options: RequestOptions,
  ) {
    await this.ensureSchema();
    const app = appSlug ? await this.resolveApp(appSlug) : null;
    const isPlatformSession = !app;
    const callbackUrl = this.normalizeCallbackUrl(body?.callback_url || body?.callbackUrl);
    const clientName = this.normalizeLabel(body?.client, '@jamba/opg-cli', 64);
    const profileName = this.normalizeLabel(body?.profile, 'default', 64);
    const requestedScopes = isPlatformSession
      ? []
      : this.developerAuthorizationService.normalizeScopes(body?.scopes, DEFAULT_DEVELOPER_LOGIN_SCOPES);
    const webBaseUrl = this.normalizeWebBaseUrl(body?.web_url || body?.webUrl || options.baseUrl);
    const state = this.randomToken(32);
    const expiresAt = new Date(Date.now() + LOGIN_SESSION_TTL_MS);

    await this.prisma.$executeRawUnsafe(
      `
        INSERT INTO developer_sdk_login_sessions (
          app_id, session_mode, state_hash, callback_url, client_name, profile_name, requested_scopes_json, status, expires_at
        ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb, 'PENDING', $8)
      `,
      app?.id || null,
      isPlatformSession ? 'PLATFORM' : 'APP',
      this.hashToken(state),
      callbackUrl,
      clientName,
      profileName,
      JSON.stringify(requestedScopes),
      expiresAt,
    );

    const loginUrl = this.buildLoginUrl(webBaseUrl, app?.slug || null, state, options.baseUrl);
    return {
      state,
      login_url: loginUrl,
      mode: isPlatformSession ? 'platform' : 'app',
      app: app ? this.serializeApp(app) : null,
      client: clientName,
      profile: profileName,
      scopes: requestedScopes,
      scope_catalog: isPlatformSession ? [] : (await this.developerAuthorizationService.scopeCatalog()).items,
      expires_at: expiresAt,
      expires_in_seconds: Math.floor(LOGIN_SESSION_TTL_MS / 1000),
    };
  }

  async getSession(appSlug: string | undefined, state: string) {
    await this.ensureSchema();
    const app = appSlug ? await this.resolveApp(appSlug) : null;
    const session = await this.findSession(app?.id || null, state);
    const isPlatformSession = session.session_mode === 'PLATFORM' || !session.app_id;
    return {
      state,
      mode: isPlatformSession ? 'platform' : 'app',
      app: session.app_id && session.app_slug && session.app_name
        ? this.serializeApp({ id: session.app_id, slug: session.app_slug, name: session.app_name, status: '' })
        : null,
      client: session.client_name,
      profile: session.profile_name,
      scopes: this.deserializeStringArray(session.requested_scopes_json),
      scope_catalog: isPlatformSession ? [] : (await this.developerAuthorizationService.scopeCatalog()).items,
      status: this.publicStatus(session),
      expires_at: session.expires_at,
    };
  }

  async authorizeSession(appSlug: string | undefined, state: string, actor: LoginActor | undefined, body?: { scopes?: unknown; target?: string; app_slug?: string; appSlug?: string; app?: string }) {
    await this.ensureSchema();
    const app = appSlug ? await this.resolveApp(appSlug) : null;
    const session = await this.findSession(app?.id || null, state);
    const sessionApp = session.app_id && session.app_slug && session.app_name
      ? { id: session.app_id, slug: session.app_slug, name: session.app_name, status: '' }
      : null;
    const requestedTarget = String(body?.target || '').trim().toLowerCase();
    const requestedAppSlug = String(body?.app_slug || body?.appSlug || body?.app || '').trim();
    const selectedApp = !sessionApp && (requestedTarget === 'app' || requestedAppSlug)
      ? await this.resolveApp(requestedAppSlug)
      : null;
    const actorUserId = sessionApp || selectedApp
      ? await this.assertPlatformOrAppAdmin(sessionApp || selectedApp!, actor)
      : await this.assertPlatformAdmin(actor);
    this.assertSessionPending(session);
    const requestedScopes = this.deserializeStringArray(session.requested_scopes_json);
    const grantedScopes = sessionApp || selectedApp
      ? this.developerAuthorizationService.normalizeScopes(body?.scopes, requestedScopes.length ? requestedScopes as any : DEFAULT_DEVELOPER_LOGIN_SCOPES)
      : [];

    const exchangeCode = this.randomToken(32);
    const exchangeCodeHash = this.hashToken(exchangeCode);
    const exchangeExpiresAt = new Date(Date.now() + EXCHANGE_CODE_TTL_MS);
    const updated = await this.prisma.$executeRawUnsafe(
      `
        UPDATE developer_sdk_login_sessions
        SET status = 'AUTHORIZED',
            authorized_user_id = $1::uuid,
            exchange_code_hash = $2,
            exchange_code_expires_at = $3,
            granted_scopes_json = $4::jsonb,
            selected_app_id = $5::uuid,
            authorized_at = now(),
            updated_at = now()
        WHERE id = $6::uuid
          AND status = 'PENDING'
          AND expires_at > now()
      `,
      actorUserId,
      exchangeCodeHash,
      exchangeExpiresAt,
      JSON.stringify(grantedScopes),
      selectedApp?.id || null,
      session.id,
    );

    if (!updated) {
      throw new GoneException('SDK login session is no longer pending');
    }

    return {
      ok: true,
      state,
      redirect_url: this.appendCallbackParams(session.callback_url, {
        state,
        code: exchangeCode,
      }),
      scopes: grantedScopes,
      expires_at: exchangeExpiresAt,
    };
  }

  async exchangeToken(appSlug: string | undefined, body: { state?: string; code?: string }) {
    await this.ensureSchema();
    const state = String(body?.state || '').trim();
    const code = String(body?.code || '').trim();
    if (!state || !code) {
      throw new BadRequestException('state and code are required');
    }
    const app = appSlug ? await this.resolveApp(appSlug) : null;
    const session = await this.findSession(app?.id || null, state);
    if (session.status !== 'AUTHORIZED') {
      throw new BadRequestException('SDK login session is not authorized');
    }

    const rows = await (this.prisma.$queryRawUnsafe(
      `
        SELECT authorized_user_id, exchange_code_hash, exchange_code_expires_at, granted_scopes_json
        FROM developer_sdk_login_sessions
        WHERE id = $1::uuid
        LIMIT 1
      `,
      session.id,
    ) as Promise<Array<{ authorized_user_id: string | null; exchange_code_hash: string | null; exchange_code_expires_at: Date | null; granted_scopes_json: unknown }>>);

    const secret = rows[0];
    if (!secret?.authorized_user_id || !secret.exchange_code_hash || secret.exchange_code_hash !== this.hashToken(code)) {
      throw new ForbiddenException('Invalid SDK login code');
    }
    if (!secret.exchange_code_expires_at || secret.exchange_code_expires_at.getTime() <= Date.now()) {
      throw new GoneException('SDK login code expired');
    }

    const sessionApp = this.resolveSessionApp(session);

    if (!sessionApp) {
      return this.exchangePlatformToken(session, secret.authorized_user_id);
    }

    const scopes = this.deserializeStringArray(secret.granted_scopes_json);
    const created = await this.developerAuthorizationService.createGrant({
      name: this.apiKeyName(session),
      userId: secret.authorized_user_id,
      createdByUserId: secret.authorized_user_id,
      scopes: scopes.length ? scopes : session.requested_scopes_json,
      allowedAppIds: [sessionApp.id],
    });
    await this.prisma.$executeRawUnsafe(
      `
        UPDATE developer_sdk_login_sessions
        SET status = 'CONSUMED',
            developer_grant_id = $1::uuid,
            consumed_at = now(),
            updated_at = now()
        WHERE id = $2::uuid
          AND status = 'AUTHORIZED'
      `,
      created.id,
      session.id,
    );

    return {
      ok: true,
      mode: 'app',
      app: this.serializeApp(sessionApp),
      profile: session.profile_name,
      auth: {
        type: 'developer_grant',
        api_key: created.key,
        grant_id: created.id,
        key_prefix: created.key_prefix,
        key_last4: created.key_last4,
        scopes: created.scopes,
      },
      config: {
        base_url: null,
        app: sessionApp.slug,
      },
    };
  }

  private async exchangePlatformToken(session: LoginSessionRow, userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { app: true },
    });
    if (!user || !user.app) {
      throw new ForbiddenException('Platform login user is not available');
    }
    const auth = await this.authService.buildAuthResponse(user as User, user.app.slug, this.randomToken(32), {
      provider: 'opg-cli',
    });
    await this.prisma.$executeRawUnsafe(
      `
        UPDATE developer_sdk_login_sessions
        SET status = 'CONSUMED',
            consumed_at = now(),
            updated_at = now()
        WHERE id = $1::uuid
          AND status = 'AUTHORIZED'
      `,
      session.id,
    );

    return {
      ok: true,
      mode: 'platform',
      profile: session.profile_name,
      auth: {
        type: 'platform_jwt',
        platform_token: auth.access_token,
        platform_refresh_token: auth.refresh_token,
        token_type: auth.token_type,
      },
      user: auth.user,
      config: {
        base_url: null,
        app: null,
      },
    };
  }

  private async resolveApp(appSlug?: string) {
    const slug = String(appSlug || '').trim().toLowerCase();
    if (!slug) {
      throw new BadRequestException('app is required');
    }
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id, slug, name, status::text AS status FROM apps WHERE slug = $1 LIMIT 1`,
      slug,
    ) as Promise<AppRow[]>);
    const app = rows[0];
    if (!app) {
      throw new NotFoundException('App not found');
    }
    return app;
  }

  private resolveSessionApp(session: LoginSessionRow): AppRow | null {
    if (session.app_id && session.app_slug && session.app_name) {
      return { id: session.app_id, slug: session.app_slug, name: session.app_name, status: '' };
    }
    if (session.selected_app_id && session.selected_app_slug && session.selected_app_name) {
      return { id: session.selected_app_id, slug: session.selected_app_slug, name: session.selected_app_name, status: '' };
    }
    return null;
  }

  private async findSession(appId: string | null, state: string) {
    const normalizedState = String(state || '').trim();
    if (!normalizedState) {
      throw new BadRequestException('state is required');
    }
    const rows = await (this.prisma.$queryRawUnsafe(
      `
        SELECT s.id, s.app_id, a.slug AS app_slug, a.name AS app_name,
               s.selected_app_id, selected_app.slug AS selected_app_slug, selected_app.name AS selected_app_name,
               s.callback_url, s.client_name, s.profile_name,
               COALESCE(s.session_mode, CASE WHEN s.app_id IS NULL THEN 'PLATFORM' ELSE 'APP' END) AS session_mode,
               s.status,
               s.expires_at, s.authorized_user_id, s.exchange_code_hash, s.requested_scopes_json
        FROM developer_sdk_login_sessions s
        LEFT JOIN apps a ON a.id = s.app_id
        LEFT JOIN apps selected_app ON selected_app.id = s.selected_app_id
        WHERE (($1::uuid IS NULL AND s.app_id IS NULL) OR s.app_id = $1::uuid)
          AND s.state_hash = $2
        LIMIT 1
      `,
      appId,
      this.hashToken(normalizedState),
    ) as Promise<LoginSessionRow[]>);
    const session = rows[0];
    if (!session) {
      throw new NotFoundException('SDK login session not found');
    }
    return session;
  }

  private assertSessionPending(session: LoginSessionRow) {
    if (session.status !== 'PENDING') {
      throw new BadRequestException('SDK login session is not pending');
    }
    if (session.expires_at.getTime() <= Date.now()) {
      throw new GoneException('SDK login session expired');
    }
  }

  private async assertPlatformOrAppAdmin(app: AppRow, actor: LoginActor | undefined) {
    const actorUserId = String(actor?.userId || actor?.id || '').trim();
    if (!actorUserId) {
      throw new ForbiddenException('SDK login authorization requires an authenticated admin');
    }
    const rows = await (this.prisma.$queryRawUnsafe(
      `
        SELECT id, app_id, role::text AS role, admin_type::text AS admin_type, is_superuser
        FROM users
        WHERE id = $1::uuid
          AND deleted_at IS NULL
          AND is_active = true
        LIMIT 1
      `,
      actorUserId,
    ) as Promise<Array<{ id: string; app_id: string | null; role: string; admin_type: string | null; is_superuser: boolean }>>);

    const user = rows[0];
    if (!user) {
      throw new ForbiddenException('SDK login authorization requires an active admin');
    }
    const isPlatformAdmin = user.is_superuser || user.admin_type === 'SUPER_ADMIN';
    const isTargetAppAdmin = user.app_id === app.id && user.role === 'ADMIN';
    if (!isPlatformAdmin && !isTargetAppAdmin) {
      throw new ForbiddenException('SDK login authorization requires an app admin');
    }
    return actorUserId;
  }

  private async assertPlatformAdmin(actor: LoginActor | undefined) {
    const actorUserId = String(actor?.userId || actor?.id || '').trim();
    if (!actorUserId) {
      throw new ForbiddenException('Platform login authorization requires an authenticated platform admin');
    }
    const rows = await (this.prisma.$queryRawUnsafe(
      `
        SELECT u.id, u.role::text AS role, u.admin_type::text AS admin_type, u.is_superuser, a.slug AS app_slug
        FROM users u
        JOIN apps a ON a.id = u.app_id
        WHERE u.id = $1::uuid
          AND u.deleted_at IS NULL
          AND u.is_active = true
        LIMIT 1
      `,
      actorUserId,
    ) as Promise<Array<{ id: string; role: string; admin_type: string | null; is_superuser: boolean; app_slug: string }>>);

    const user = rows[0];
    const isPlatformSuperAdmin = user
      && user.role === 'ADMIN'
      && (user.is_superuser || user.admin_type === 'SUPER_ADMIN')
      && user.app_slug === 'platform';
    if (!isPlatformSuperAdmin) {
      throw new ForbiddenException('Platform login authorization requires a platform super admin');
    }
    return actorUserId;
  }

  private normalizeCallbackUrl(value: unknown) {
    const raw = String(value || '').trim();
    if (!raw) {
      throw new BadRequestException('callback_url is required');
    }
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new BadRequestException('callback_url must be a valid URL');
    }
    const hostname = parsed.hostname.toLowerCase();
    if (!['127.0.0.1', 'localhost', '::1'].includes(hostname)) {
      throw new BadRequestException('callback_url must point to localhost');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new BadRequestException('callback_url must use http or https');
    }
    return parsed.toString();
  }

  private normalizeWebBaseUrl(value: unknown) {
    const raw = String(value || '').trim().replace(/\/+$/, '');
    if (!raw) {
      throw new BadRequestException('web_url is required');
    }
    try {
      const parsed = new URL(raw);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('invalid protocol');
      }
      return parsed.toString().replace(/\/+$/, '');
    } catch {
      throw new BadRequestException('web_url must be a valid HTTP URL');
    }
  }

  private normalizeLabel(value: unknown, fallback: string, maxLength: number) {
    const normalized = String(value || '').trim() || fallback;
    return normalized.slice(0, maxLength);
  }

  private buildLoginUrl(webBaseUrl: string, appSlug: string | null, state: string, apiBaseUrl: string) {
    const url = new URL('/sdk-login', webBaseUrl);
    if (appSlug) {
      url.searchParams.set('app', appSlug);
    } else {
      url.searchParams.set('mode', 'platform');
    }
    url.searchParams.set('state', state);
    url.searchParams.set('baseUrl', apiBaseUrl.replace(/\/+$/, ''));
    return url.toString();
  }

  private appendCallbackParams(callbackUrl: string, params: Record<string, string>) {
    const url = new URL(callbackUrl);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  private publicStatus(session: LoginSessionRow) {
    if (session.status === 'PENDING' && session.expires_at.getTime() <= Date.now()) {
      return 'EXPIRED';
    }
    return session.status;
  }

  private apiKeyName(session: LoginSessionRow) {
    const profile = session.profile_name && session.profile_name !== 'default' ? ` (${session.profile_name})` : '';
    return `${session.client_name}${profile} SDK Login`;
  }

  private deserializeStringArray(value: unknown): string[] {
    if (Array.isArray(value)) {
      return value.map((item) => String(item || '').trim()).filter(Boolean);
    }
    if (typeof value === 'string') {
      try {
        return this.deserializeStringArray(JSON.parse(value));
      } catch {
        return [];
      }
    }
    return [];
  }

  private serializeApp(app: AppRow) {
    return {
      id: app.id,
      slug: app.slug,
      name: app.name,
      status: app.status,
    };
  }

  private randomToken(bytes: number) {
    return randomBytes(bytes).toString('base64url');
  }

  private hashToken(value: string) {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }

  private async ensureSchema() {
    if (this.schemaReady) {
      return;
    }
    if (this.schemaPromise) {
      await this.schemaPromise;
      return;
    }

    this.schemaPromise = this.initSchema();
    try {
      await this.schemaPromise;
      this.schemaReady = true;
    } finally {
      this.schemaPromise = null;
    }
  }

  private async initSchema() {
    await this.developerAuthorizationService.ensureReady();
    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS developer_sdk_login_sessions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        app_id uuid NULL REFERENCES apps(id) ON DELETE CASCADE,
        selected_app_id uuid NULL REFERENCES apps(id) ON DELETE SET NULL,
        session_mode varchar(24) NOT NULL DEFAULT 'APP',
        state_hash varchar(128) NOT NULL UNIQUE,
        callback_url text NOT NULL,
        client_name varchar(64) NOT NULL,
        profile_name varchar(64) NOT NULL DEFAULT 'default',
        requested_scopes_json jsonb NOT NULL DEFAULT '[]'::jsonb,
        granted_scopes_json jsonb NULL,
        status varchar(24) NOT NULL DEFAULT 'PENDING',
        authorized_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
        exchange_code_hash varchar(128) NULL,
        exchange_code_expires_at timestamptz NULL,
        developer_grant_id uuid NULL REFERENCES developer_authorization_grants(id) ON DELETE SET NULL,
        expires_at timestamptz NOT NULL,
        authorized_at timestamptz NULL,
        consumed_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.prisma.$executeRawUnsafe(`
      ALTER TABLE developer_sdk_login_sessions
        ALTER COLUMN app_id DROP NOT NULL,
        ADD COLUMN IF NOT EXISTS session_mode varchar(24) NOT NULL DEFAULT 'APP',
        ADD COLUMN IF NOT EXISTS selected_app_id uuid NULL REFERENCES apps(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS requested_scopes_json jsonb NOT NULL DEFAULT '[]'::jsonb,
        ADD COLUMN IF NOT EXISTS granted_scopes_json jsonb NULL,
        ADD COLUMN IF NOT EXISTS developer_grant_id uuid NULL REFERENCES developer_authorization_grants(id) ON DELETE SET NULL
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_developer_sdk_login_sessions_app_status
      ON developer_sdk_login_sessions(app_id, status, expires_at DESC)
    `);
  }
}
