import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient, User } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PRISMA_CLIENT } from '../../config/database.module';
import { AppleIdentityService } from './apple-identity.service';
import { AuthService } from './auth.service';
import { IosAppAttestService } from './ios-app-attest.service';

type IdentityRow = {
  id: string;
  app_id: string;
  user_id: string;
  provider: string;
  provider_subject: string;
  email: string | null;
  is_verified: boolean;
};

type DeviceRow = {
  id: string;
  key_id: string;
  status: string;
  last_seen_at: Date | null;
  created_at: Date;
};

function safeString(value: unknown): string {
  return String(value || '').trim();
}

function nowEmail(prefix: string, subject: string) {
  return `${prefix}_${subject.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 48)}_${Date.now()}@oauth.local`;
}

@Injectable()
export class AccountBindingService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    private readonly authService: AuthService,
    private readonly appleIdentityService: AppleIdentityService,
    private readonly iosAppAttestService: IosAppAttestService,
  ) {}

  async loginWithApple(body: {
    identity_token?: string;
    nonce?: string;
    full_name?: string;
    app_attest_key_id?: string;
    app_attest_assertion?: string;
    app_attest_challenge_id?: string;
  }, appSlug?: string, req?: any) {
    await this.iosAppAttestService.verifySensitiveIfRequired(appSlug, body as Record<string, unknown>, req);
    const { app, identity } = await this.appleIdentityService.verifyIdentityToken({
      appSlug,
      identityToken: body.identity_token,
      nonce: body.nonce,
    });
    const user = await this.findOrCreateAppleUser(app.id, identity.sub, {
      email: identity.email,
      emailVerified: identity.emailVerified,
      fullName: safeString(body.full_name) || null,
    });
    if (body.app_attest_key_id) {
      await this.iosAppAttestService.attachDeviceToUser(app.id, body.app_attest_key_id, user.id);
    }
    const sessionToken = this.authService.generateSessionToken();
    await this.prisma.user.update({
      where: { id: user.id },
      data: { sessionToken, lastLoginAt: new Date() },
    });
    const fresh = await this.prisma.user.findUnique({ where: { id: user.id } });
    return this.authService.buildAuthResponse(fresh || user, app.slug, sessionToken, {
      provider: 'apple',
      userAgent: safeString(req?.headers?.['user-agent']) || null,
      ipAddress: safeString(req?.ip) || null,
    });
  }

  async loginWithDevice(body: { key_id?: string; assertion?: string; challenge_id?: string }, appSlug?: string, req?: any) {
    const assertion = await this.iosAppAttestService.verifyAssertion(appSlug, body, req);
    const app = await this.appleIdentityService.resolveAppWithSettings(appSlug);
    let user: User | null = assertion.user_id
      ? await this.prisma.user.findFirst({ where: { id: assertion.user_id, appId: app.id, deletedAt: null } })
      : null;
    if (!user) {
      user = await this.createGuestUser(app.id, body.key_id || assertion.key_id);
      await this.iosAppAttestService.attachDeviceToUser(app.id, body.key_id || assertion.key_id, user.id);
    }
    const sessionToken = this.authService.generateSessionToken();
    await this.prisma.user.update({
      where: { id: user.id },
      data: { sessionToken, lastLoginAt: new Date() },
    });
    const fresh = await this.prisma.user.findUnique({ where: { id: user.id } });
    return this.authService.buildAuthResponse(fresh || user, app.slug, sessionToken, {
      provider: 'ios_device',
      userAgent: safeString(req?.headers?.['user-agent']) || null,
      ipAddress: safeString(req?.ip) || null,
    });
  }

  async listIdentities(userId: string) {
    const user = await this.requireUser(userId);
    const identities = await (this.prisma.$queryRawUnsafe(
      `SELECT id, app_id, user_id, provider, provider_subject, email, is_verified
         FROM user_identities
        WHERE app_id = $1::uuid AND user_id = $2::uuid
        ORDER BY created_at ASC`,
      user.appId,
      user.id,
    ) as Promise<IdentityRow[]>);
    const entitlements = await (this.prisma.$queryRawUnsafe(
      `SELECT id, source, product_code, external_product_id, status, expires_at
         FROM user_entitlements
        WHERE app_id = $1::uuid AND user_id = $2::uuid
        ORDER BY expires_at DESC NULLS LAST, created_at DESC`,
      user.appId,
      user.id,
    ) as Promise<Array<Record<string, unknown>>>);
    return {
      account_type: (user as any).accountType || 'REGISTERED',
      is_anonymous: Boolean((user as any).isAnonymous),
      identities: identities.map((item) => ({
        id: item.id,
        provider: item.provider,
        provider_subject: item.provider === 'APPLE' ? this.maskSubject(item.provider_subject) : item.provider_subject,
        email: item.email,
        is_verified: item.is_verified,
      })),
      entitlements,
    };
  }

  async bindApple(userId: string, body: {
    identity_token?: string;
    nonce?: string;
    full_name?: string;
    app_attest_key_id?: string;
    app_attest_assertion?: string;
    app_attest_challenge_id?: string;
  }, appSlug?: string, req?: any) {
    const user = await this.requireUser(userId);
    await this.iosAppAttestService.verifySensitiveIfRequired(appSlug, body as Record<string, unknown>, req);
    const { app, identity } = await this.appleIdentityService.verifyIdentityToken({
      appSlug: appSlug || user.appId,
      identityToken: body.identity_token,
      nonce: body.nonce,
    });
    if (app.id !== user.appId) {
      throw new BadRequestException('Apple identity app mismatch');
    }
    const existing = await this.findIdentity(app.id, 'APPLE', identity.sub);
    if (existing && existing.user_id !== user.id) {
      return {
        merge_required: true,
        provider: 'APPLE',
        target_user_id: existing.user_id,
        source_user_id: user.id,
      };
    }
    await this.upsertIdentity(app.id, user.id, 'APPLE', identity.sub, identity.email, identity.emailVerified, identity.raw);
    await this.prisma.$executeRawUnsafe(
      `UPDATE users
          SET apple_sub = $3,
              apple_email = COALESCE($4, apple_email),
              account_type = 'REGISTERED',
              is_anonymous = false,
              primary_auth_provider = COALESCE(primary_auth_provider, 'APPLE'),
              updated_at = now()
        WHERE app_id = $1::uuid AND id = $2::uuid`,
      app.id,
      user.id,
      identity.sub,
      identity.email,
    );
    return { success: true, provider: 'APPLE' };
  }

  async unbindApple(userId: string, body?: Record<string, unknown>, appSlug?: string, req?: any) {
    const user = await this.requireUser(userId);
    await this.iosAppAttestService.verifySensitiveIfRequired(appSlug, body || {}, req);
    const countRows = await (this.prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::text AS count
         FROM user_identities
        WHERE app_id = $1::uuid AND user_id = $2::uuid`,
      user.appId,
      user.id,
    ) as Promise<Array<{ count: string }>>);
    if (Number(countRows[0]?.count || 0) <= 1 && !user.email && !user.phone) {
      throw new ConflictException('至少保留一种登录方式');
    }
    await this.prisma.$executeRawUnsafe(
      `DELETE FROM user_identities
        WHERE app_id = $1::uuid AND user_id = $2::uuid AND provider = 'APPLE'`,
      user.appId,
      user.id,
    );
    await this.prisma.$executeRawUnsafe(
      `UPDATE users
          SET apple_sub = NULL,
              apple_email = NULL,
              primary_auth_provider = NULLIF(primary_auth_provider, 'APPLE'),
              updated_at = now()
        WHERE id = $1::uuid`,
      user.id,
    );
    return { success: true };
  }

  async mergeGuestIntoAccount(sourceUserId: string, body: { target_user_id?: string } & Record<string, unknown>, appSlug?: string, req?: any) {
    const source = await this.requireUser(sourceUserId);
    await this.iosAppAttestService.verifySensitiveIfRequired(appSlug, body || {}, req);
    const targetUserId = safeString(body.target_user_id);
    if (!targetUserId) {
      throw new BadRequestException('target_user_id is required');
    }
    const target = await this.prisma.user.findFirst({ where: { id: targetUserId, appId: source.appId, deletedAt: null } });
    if (!target) {
      throw new NotFoundException('Target user not found');
    }
    await this.prisma.$transaction(async (tx) => {
      const tables = [
        'user_notifications',
        'user_feedbacks',
        'ai_usage_logs',
        'user_ai_points_ledger',
        'apple_iap_transactions',
        'user_entitlements',
      ];
      for (const table of tables) {
        await tx.$executeRawUnsafe(
          `UPDATE ${table} SET user_id = $3::uuid WHERE app_id = $1::uuid AND user_id = $2::uuid`,
          source.appId,
          source.id,
          target.id,
        ).catch(() => undefined);
      }
      await tx.$executeRawUnsafe(
        `UPDATE ios_app_attest_devices SET user_id = $3::uuid, updated_at = now() WHERE app_id = $1::uuid AND user_id = $2::uuid`,
        source.appId,
        source.id,
        target.id,
      );
      await tx.$executeRawUnsafe(
        `UPDATE user_identities SET user_id = $3::uuid, updated_at = now() WHERE app_id = $1::uuid AND user_id = $2::uuid`,
        source.appId,
        source.id,
        target.id,
      );
      await tx.$executeRawUnsafe(
        `UPDATE users
            SET deleted_at = now(),
                deactivated_at = now(),
                deactivation_reason = 'merged_into_registered_account',
                updated_at = now()
          WHERE id = $1::uuid`,
        source.id,
      );
    });
    await this.authService.revokeAllAuthUserSessions(source.id);
    return { success: true, source_user_id: source.id, target_user_id: target.id };
  }

  async listDevices(userId: string) {
    const user = await this.requireUser(userId);
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id, key_id, status, last_seen_at, created_at
         FROM ios_app_attest_devices
        WHERE app_id = $1::uuid AND user_id = $2::uuid
        ORDER BY last_seen_at DESC NULLS LAST, created_at DESC`,
      user.appId,
      user.id,
    ) as Promise<DeviceRow[]>);
    return { items: rows.map((row) => ({ ...row, key_id: this.maskSubject(row.key_id) })) };
  }

  async revokeDevice(userId: string, deviceId: string) {
    const user = await this.requireUser(userId);
    await this.prisma.$executeRawUnsafe(
      `UPDATE ios_app_attest_devices
          SET status = 'REVOKED', revoked_at = now(), updated_at = now()
        WHERE app_id = $1::uuid AND user_id = $2::uuid AND id = $3::uuid`,
      user.appId,
      user.id,
      deviceId,
    );
    return { success: true };
  }

  async deleteAccount(userId: string, body?: { reason?: string } & Record<string, unknown>, appSlug?: string, req?: any) {
    const user = await this.requireUser(userId);
    await this.iosAppAttestService.verifySensitiveIfRequired(appSlug, body || {}, req);
    const replacement = `deleted_${user.id}@deleted.local`;
    await this.prisma.$executeRawUnsafe(
      `UPDATE users
          SET email = $2,
              full_name = NULL,
              display_name = NULL,
              avatar_url = NULL,
              phone = NULL,
              apple_sub = NULL,
              apple_email = NULL,
              wechat_openid = NULL,
              wechat_unionid = NULL,
              is_active = false,
              deleted_at = now(),
              deactivated_at = now(),
              deactivation_reason = $3,
              updated_at = now()
        WHERE id = $1::uuid`,
      user.id,
      replacement,
      safeString(body?.reason) || 'user_requested_ios_account_deletion',
    );
    await this.prisma.$executeRawUnsafe(
      `UPDATE ios_app_attest_devices
          SET status = 'REVOKED', revoked_at = now(), updated_at = now()
        WHERE app_id = $1::uuid AND user_id = $2::uuid`,
      user.appId,
      user.id,
    );
    await this.authService.revokeAllAuthUserSessions(user.id);
    return { success: true };
  }

  private async findOrCreateAppleUser(appId: string, appleSub: string, profile: { email: string | null; emailVerified: boolean; fullName?: string | null }) {
    const existingIdentity = await this.findIdentity(appId, 'APPLE', appleSub);
    if (existingIdentity) {
      const user = await this.prisma.user.findFirst({ where: { id: existingIdentity.user_id, appId, deletedAt: null } });
      if (user) return user;
    }
    const existingByApple = await this.prisma.user.findFirst({ where: { appId, appleSub, deletedAt: null } });
    if (existingByApple) {
      await this.upsertIdentity(appId, existingByApple.id, 'APPLE', appleSub, profile.email, profile.emailVerified, {});
      return existingByApple;
    }
    const email = profile.email && profile.emailVerified ? this.authService.normalizeEmail(profile.email) : nowEmail('apple', appleSub);
    const userId = randomUUID();
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO users (
         id, app_id, email, hashed_password, full_name, display_name, role, membership_type,
         is_active, account_type, primary_auth_provider, is_anonymous, apple_sub, apple_email,
         created_at, updated_at
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, $5, $5, 'USER', 'FREE',
         true, 'REGISTERED', 'APPLE', false, $6, $7,
         now(), now()
       )`,
      userId,
      appId,
      email,
      await this.authService.hashPassword(this.authService.generateSessionToken()),
      profile.fullName || 'Apple 用户',
      appleSub,
      profile.email,
    );
    await this.upsertIdentity(appId, userId, 'APPLE', appleSub, profile.email, profile.emailVerified, {});
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('Failed to create Apple user');
    return user;
  }

  private async createGuestUser(appId: string, keyId?: string) {
    const userId = randomUUID();
    const email = nowEmail('guest', keyId || userId);
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO users (
         id, app_id, email, hashed_password, full_name, display_name, role, membership_type,
         is_active, account_type, primary_auth_provider, is_anonymous, created_at, updated_at
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, '访客用户', '访客用户', 'USER', 'FREE',
         true, 'GUEST', 'IOS_DEVICE', true, now(), now()
       )`,
      userId,
      appId,
      email,
      await this.authService.hashPassword(this.authService.generateSessionToken()),
    );
    if (keyId) {
      await this.upsertIdentity(appId, userId, 'IOS_DEVICE', keyId, null, true, {});
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('Failed to create guest user');
    return user;
  }

  private async requireUser(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.deletedAt) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  private async findIdentity(appId: string, provider: string, subject: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id, app_id, user_id, provider, provider_subject, email, is_verified
         FROM user_identities
        WHERE app_id = $1::uuid AND provider = $2 AND provider_subject = $3
        LIMIT 1`,
      appId,
      provider,
      subject,
    ) as Promise<IdentityRow[]>);
    return rows[0] || null;
  }

  private async upsertIdentity(
    appId: string,
    userId: string,
    provider: string,
    subject: string,
    email: string | null,
    isVerified: boolean,
    metadata: Record<string, unknown>,
  ) {
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO user_identities (
         app_id, user_id, provider, provider_subject, email, is_verified, metadata_json
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb
       )
       ON CONFLICT (app_id, provider, provider_subject) DO UPDATE
       SET user_id = EXCLUDED.user_id,
           email = COALESCE(EXCLUDED.email, user_identities.email),
           is_verified = EXCLUDED.is_verified,
           metadata_json = EXCLUDED.metadata_json,
           updated_at = now()`,
      appId,
      userId,
      provider,
      subject,
      email,
      isVerified,
      JSON.stringify(metadata || {}),
    );
  }

  private maskSubject(value: string) {
    if (!value) return '';
    if (value.length <= 10) return `${value.slice(0, 2)}***`;
    return `${value.slice(0, 6)}...${value.slice(-4)}`;
  }
}
