import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

import { AuthService } from './auth.service';
import type { AuthenticationMethod } from '@bookorbit/types';
import { AUDIOBOOKSHELF_BASE_PATH } from '../../common/constants/audiobookshelf.constants';

const fromTokenQuery = ExtractJwt.fromUrlQueryParameter('token');

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly authService: AuthService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        (req: any) => req?.cookies?.access_token ?? null,
        // ABS clients (Prologue) pass the token as a query parameter on downloads and streams.
        // Scoped to the ABS mount so tokens never become valid in URLs on BookOrbit's own API.
        (req: any) => (typeof req?.url === 'string' && req.url.startsWith(`${AUDIOBOOKSHELF_BASE_PATH}/`) ? fromTokenQuery(req) : null),
      ]),
      secretOrKey: config.get<string>('auth.jwtSecret')!,
      algorithms: ['HS256'],
    });
  }

  async validate(payload: { sub: number; ver: number; sid?: number; amr?: AuthenticationMethod }) {
    const user = await this.authService.validateSessionUser(payload.sub, payload.ver, payload.amr ?? 'legacy', payload.sid);
    if (!user) throw new UnauthorizedException();
    return user;
  }
}
