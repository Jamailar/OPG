import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigType } from '@nestjs/config';
import configuration from '../../config/configuration';
import { AuthService } from './auth.service';

export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
  sid?: string;
  sessionToken: string;
  appSlug?: string;
}

const pickCookieValue = (cookieHeader: string | undefined, key: string): string | null => {
  if (!cookieHeader || !key) {
    return null;
  }
  const entries = cookieHeader.split(';');
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex <= 0) {
      continue;
    }
    const cookieKey = trimmed.slice(0, eqIndex).trim();
    if (cookieKey !== key) {
      continue;
    }
    const rawValue = trimmed.slice(eqIndex + 1).trim();
    if (!rawValue) {
      return null;
    }
    try {
      return decodeURIComponent(rawValue);
    } catch {
      return rawValue;
    }
  }
  return null;
};

const normalizeJwtToken = (value: string | null | undefined): string | null => {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.toLowerCase().startsWith('bearer ')) {
    return trimmed.slice(7).trim() || null;
  }
  return trimmed;
};

const extractJwtFromCookie = (req: any): string | null => {
  const cookieHeader = (req?.headers?.cookie as string | undefined) || '';
  return (
    normalizeJwtToken(pickCookieValue(cookieHeader, 'access_token')) ||
    normalizeJwtToken(pickCookieValue(cookieHeader, 'token')) ||
    null
  );
};

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    @Inject(configuration.KEY) config: ConfigType<typeof configuration>,
    private readonly authService: AuthService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        extractJwtFromCookie,
        ExtractJwt.fromUrlQueryParameter('access_token'),
      ]),
      ignoreExpiration: false,
      passReqToCallback: true,
      secretOrKey: config.jwt.secret,
    });
  }

  async validate(req: any, payload: JwtPayload) {
    if (!payload.sub) {
      throw new UnauthorizedException('Invalid token');
    }
    return this.authService.validateAccessTokenPayload(payload, req?.params?.app);
  }
}
