import { BadRequestException, ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { createHash, createPublicKey, randomBytes, verify as verifySignature, X509Certificate } from 'crypto';
import { decode as decodeCbor } from 'cbor-x';
import { X509Certificate as ParsedX509Certificate } from '@peculiar/x509';
import { PRISMA_CLIENT } from '../../config/database.module';
import { AppleIdentityService, AppleLoginConfig } from './apple-identity.service';

type ChallengeRow = {
  id: string;
  challenge: string;
  purpose: string;
  key_id: string | null;
  user_id: string | null;
  consumed_at: Date | null;
  expires_at: Date;
};

type DeviceRow = {
  id: string;
  app_id: string;
  user_id: string | null;
  key_id: string;
  public_key: string;
  sign_count: string | number | bigint;
  team_id: string;
  bundle_id: string;
  environment: string;
  status: string;
};

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const APP_ATTEST_NONCE_EXTENSION_OID = '1.2.840.113635.100.8.2';

function base64UrlToBuffer(value: string): Buffer {
  return Buffer.from(String(value || ''), 'base64url');
}

function safeString(value: unknown): string {
  return String(value || '').trim();
}

@Injectable()
export class IosAppAttestService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    private readonly appleIdentityService: AppleIdentityService,
  ) {}

  async createChallenge(appSlug: string | undefined, input?: { purpose?: string; key_id?: string; user_id?: string | null }, req?: any) {
    const app = await this.appleIdentityService.resolveAppWithSettings(appSlug);
    const challenge = randomBytes(32).toString('base64url');
    const purpose = safeString(input?.purpose) || 'APP_ATTEST';
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
    const rows = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO ios_auth_challenges (
         app_id, challenge, purpose, key_id, user_id, expires_at, ip_address, user_agent
       ) VALUES (
         $1::uuid, $2, $3, $4, $5::uuid, $6, $7, $8
       )
       RETURNING id`,
      app.id,
      challenge,
      purpose,
      safeString(input?.key_id) || null,
      input?.user_id || null,
      expiresAt,
      safeString(req?.ip) || null,
      safeString(req?.headers?.['user-agent']) || null,
    ) as Promise<Array<{ id: string }>>);
    return {
      id: rows[0]?.id,
      challenge,
      expires_at: expiresAt.toISOString(),
    };
  }

  async registerDevice(appSlug: string | undefined, body: { key_id?: string; attestation_object?: string; challenge_id?: string }, req?: any) {
    const app = await this.appleIdentityService.resolveAppWithSettings(appSlug);
    const config = await this.requireAppleConfig(app);
    const keyId = safeString(body.key_id);
    const attestationObject = safeString(body.attestation_object);
    const challengeId = safeString(body.challenge_id);
    if (!keyId || !attestationObject || !challengeId) {
      throw new BadRequestException('key_id, attestation_object and challenge_id are required');
    }
    const challenge = await this.consumeChallenge(app.id, challengeId, 'APP_ATTEST', keyId);
    const parsed = this.parseAttestationObject(attestationObject, keyId, challenge.challenge, config);

    const rows = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO ios_app_attest_devices (
         app_id, key_id, public_key, sign_count, team_id, bundle_id, environment, status, metadata_json, last_seen_at
       ) VALUES (
         $1::uuid, $2, $3, $4::bigint, $5, $6, $7, 'ACTIVE', $8::jsonb, now()
       )
       ON CONFLICT (app_id, key_id) DO UPDATE
       SET public_key = EXCLUDED.public_key,
           sign_count = EXCLUDED.sign_count,
           team_id = EXCLUDED.team_id,
           bundle_id = EXCLUDED.bundle_id,
           environment = EXCLUDED.environment,
           status = 'ACTIVE',
           revoked_at = NULL,
           metadata_json = EXCLUDED.metadata_json,
           last_seen_at = now(),
           updated_at = now()
       RETURNING id, app_id, user_id, key_id, public_key, sign_count, team_id, bundle_id, environment, status`,
      app.id,
      keyId,
      parsed.publicKeyPem,
      parsed.signCount,
      config.teamId,
      config.bundleId,
      config.environment,
      JSON.stringify({
        credential_id: parsed.credentialId,
        app_id_hash_valid: parsed.appIdHashValid,
        attested_at: new Date().toISOString(),
        user_agent: safeString(req?.headers?.['user-agent']) || null,
      }),
    ) as Promise<DeviceRow[]>);
    return this.serializeDevice(rows[0]);
  }

  async verifyAssertionForSensitiveRequest(appSlug: string | undefined, body: Record<string, unknown>, req?: any) {
    const keyId = safeString(body.app_attest_key_id || body.key_id);
    const assertion = safeString(body.app_attest_assertion || body.assertion);
    const challengeId = safeString(body.app_attest_challenge_id || body.challenge_id);
    if (!keyId || !assertion || !challengeId) {
      throw new UnauthorizedException('App Attest assertion is required');
    }
    return this.verifyAssertion(appSlug, {
      key_id: keyId,
      assertion,
      challenge_id: challengeId,
    }, req);
  }

  async verifySensitiveIfRequired(appSlug: string | undefined, body: Record<string, unknown>, req?: any) {
    const app = await this.appleIdentityService.resolveAppWithSettings(appSlug);
    const config = await this.appleIdentityService.resolveAppleLoginConfig(app);
    const mode = config?.appAttestMode || 'ENFORCE_SENSITIVE';
    if (mode === 'OFF') {
      return { ok: true, required: false, mode };
    }
    const keyId = safeString(body.app_attest_key_id || body.key_id);
    const assertion = safeString(body.app_attest_assertion || body.assertion);
    const challengeId = safeString(body.app_attest_challenge_id || body.challenge_id);
    if (!keyId || !assertion || !challengeId) {
      if (mode === 'MONITOR') {
        return { ok: true, required: false, mode, missing: true };
      }
      throw new UnauthorizedException('App Attest assertion is required');
    }
    return this.verifyAssertion(appSlug, { key_id: keyId, assertion, challenge_id: challengeId }, req);
  }

  async verifyAssertion(appSlug: string | undefined, body: { key_id?: string; assertion?: string; challenge_id?: string }, req?: any) {
    const app = await this.appleIdentityService.resolveAppWithSettings(appSlug);
    const keyId = safeString(body.key_id);
    const assertion = safeString(body.assertion);
    const challengeId = safeString(body.challenge_id);
    if (!keyId || !assertion || !challengeId) {
      throw new BadRequestException('key_id, assertion and challenge_id are required');
    }
    const [device] = await (this.prisma.$queryRawUnsafe(
      `SELECT id, app_id, user_id, key_id, public_key, sign_count, team_id, bundle_id, environment, status
         FROM ios_app_attest_devices
        WHERE app_id = $1::uuid AND key_id = $2
        LIMIT 1`,
      app.id,
      keyId,
    ) as Promise<DeviceRow[]>);
    if (!device || device.status !== 'ACTIVE') {
      throw new UnauthorizedException('iOS device is not registered');
    }
    const challenge = await this.consumeChallenge(app.id, challengeId, 'APP_ASSERT', keyId);
    const parsed = this.parseAssertion(assertion);
    const expectedClientHash = createHash('sha256').update(challenge.challenge).digest();
    if (!parsed.clientHash.equals(expectedClientHash)) {
      throw new UnauthorizedException('App Attest assertion challenge mismatch');
    }
    const previousCount = Number(device.sign_count || 0);
    if (parsed.signCount <= previousCount) {
      throw new UnauthorizedException('App Attest assertion sign_count is stale');
    }

    const nonce = createHash('sha256').update(Buffer.concat([parsed.authenticatorData, expectedClientHash])).digest();
    const publicKey = createPublicKey(device.public_key);
    const signatureValid = verifySignature(null, nonce, publicKey, parsed.signature);
    if (!signatureValid) {
      throw new UnauthorizedException('App Attest assertion signature invalid');
    }
    await this.prisma.$executeRawUnsafe(
      `UPDATE ios_app_attest_devices
          SET sign_count = $3::bigint,
              last_seen_at = now(),
              updated_at = now()
        WHERE app_id = $1::uuid AND key_id = $2`,
      app.id,
      keyId,
      parsed.signCount,
    );
    return {
      ok: true,
      app_id: app.id,
      device_id: device.id,
      user_id: device.user_id,
      key_id: keyId,
      ip_address: safeString(req?.ip) || null,
    };
  }

  async attachDeviceToUser(appId: string, keyId: string | undefined, userId: string) {
    const normalizedKeyId = safeString(keyId);
    if (!normalizedKeyId) return;
    await this.prisma.$executeRawUnsafe(
      `UPDATE ios_app_attest_devices
          SET user_id = $3::uuid,
              updated_at = now()
        WHERE app_id = $1::uuid AND key_id = $2 AND status = 'ACTIVE'`,
      appId,
      normalizedKeyId,
      userId,
    );
  }

  private async requireAppleConfig(app: { id: string; extra_json: unknown }) {
    const config = await this.appleIdentityService.resolveAppleLoginConfig(app as any);
    if (!config) {
      throw new BadRequestException('当前租户未配置 iOS 凭证');
    }
    return config;
  }

  private async consumeChallenge(appId: string, challengeIdOrValue: string, purpose: string, keyId?: string): Promise<ChallengeRow> {
    const rows = await (this.prisma.$queryRawUnsafe(
      `UPDATE ios_auth_challenges
          SET consumed_at = now()
        WHERE app_id = $1::uuid
          AND (id::text = $2 OR challenge = $2)
          AND purpose = $3
          AND consumed_at IS NULL
          AND expires_at > now()
          AND ($4::text IS NULL OR key_id IS NULL OR key_id = $4)
        RETURNING id, challenge, purpose, key_id, user_id, consumed_at, expires_at`,
      appId,
      challengeIdOrValue,
      purpose,
      safeString(keyId) || null,
    ) as Promise<ChallengeRow[]>);
    if (!rows[0]) {
      throw new UnauthorizedException('iOS challenge is invalid or expired');
    }
    return rows[0];
  }

  private parseAttestationObject(attestationObject: string, keyId: string, challenge: string, config: AppleLoginConfig) {
    const decoded = decodeCbor(Buffer.from(attestationObject, 'base64')) as Record<string, any>;
    if (safeString(decoded.fmt) !== 'apple-appattest') {
      throw new ForbiddenException('Invalid App Attest attestation format');
    }
    const authData = Buffer.from(decoded.authData || []);
    const certBytes = Buffer.from(decoded.attStmt?.x5c?.[0] || []);
    if (!authData.length || !certBytes.length) {
      throw new ForbiddenException('Invalid App Attest attestation object');
    }
    // Parsed with @peculiar/x509 so malformed certificates fail before Node key extraction.
    const parsedCert = new ParsedX509Certificate(certBytes);
    const cert = new X509Certificate(certBytes);
    const publicKeyPem = cert.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const appIdHash = authData.subarray(0, 32);
    const expectedAppIdHash = createHash('sha256').update(`${config.teamId}.${config.bundleId}`).digest();
    if (!appIdHash.equals(expectedAppIdHash)) {
      throw new ForbiddenException('App Attest app identifier mismatch');
    }
    const signCount = authData.readUInt32BE(33);
    const credentialIdLengthOffset = 53;
    const credentialIdLength = authData.readUInt16BE(credentialIdLengthOffset);
    const credentialId = authData.subarray(credentialIdLengthOffset + 2, credentialIdLengthOffset + 2 + credentialIdLength);
    const keyIdHash = createHash('sha256').update(credentialId).digest('base64url');
    if (keyIdHash !== keyId) {
      throw new ForbiddenException('App Attest key_id mismatch');
    }
    const clientHash = createHash('sha256').update(challenge).digest();
    const nonce = createHash('sha256').update(Buffer.concat([authData, clientHash])).digest();
    const nonceExtension = parsedCert.extensions.find((extension) => extension.type === APP_ATTEST_NONCE_EXTENSION_OID);
    if (!nonceExtension || !Buffer.from(nonceExtension.value).includes(nonce)) {
      throw new ForbiddenException('App Attest attestation nonce mismatch');
    }
    return {
      publicKeyPem,
      signCount,
      credentialId: credentialId.toString('base64url'),
      appIdHashValid: true,
    };
  }

  private parseAssertion(assertion: string) {
    const decoded = decodeCbor(Buffer.from(assertion, 'base64')) as Record<string, any>;
    const signature = Buffer.from(decoded.signature || []);
    const authenticatorData = Buffer.from(decoded.authenticatorData || []);
    const clientHash = Buffer.from(decoded.clientDataHash || []);
    if (!signature.length || !authenticatorData.length || !clientHash.length) {
      throw new ForbiddenException('Invalid App Attest assertion');
    }
    return {
      signature,
      authenticatorData,
      clientHash,
      signCount: authenticatorData.readUInt32BE(33),
    };
  }

  private serializeDevice(row?: DeviceRow) {
    if (!row) return null;
    return {
      id: row.id,
      key_id: row.key_id,
      user_id: row.user_id,
      team_id: row.team_id,
      bundle_id: row.bundle_id,
      environment: row.environment,
      status: row.status,
      sign_count: Number(row.sign_count || 0),
    };
  }
}
