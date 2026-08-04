import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';

export type AuthUser = {
  id: string;
  email: string;
  name: string;
};

type TokenPayload = {
  sub: string;
  email: string;
  name: string;
  exp: number;
};

function base64url(input: string | Buffer) {
  return Buffer.from(input)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

@Injectable()
export class TokenService {
  private readonly secret = process.env.JWT_SECRET ?? 'dev-secret-change-me';

  sign(user: AuthUser) {
    const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = base64url(
      JSON.stringify({
        sub: user.id,
        email: user.email,
        name: user.name,
        exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
      }),
    );
    const signature = this.signature(`${header}.${payload}`);
    return `${header}.${payload}.${signature}`;
  }

  verify(token: string): AuthUser {
    const [header, payload, signature] = token.split('.');
    if (!header || !payload || !signature) {
      throw new UnauthorizedException('Invalid token');
    }

    const expected = this.signature(`${header}.${payload}`);
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (
      actualBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(actualBuffer, expectedBuffer)
    ) {
      throw new UnauthorizedException('Invalid token');
    }

    let data: TokenPayload;
    try {
      data = JSON.parse(
        Buffer.from(payload.replaceAll('-', '+').replaceAll('_', '/'), 'base64')
          .toString('utf8'),
      ) as TokenPayload;
    } catch {
      throw new UnauthorizedException('Invalid token');
    }
    if (data.exp < Math.floor(Date.now() / 1000)) {
      throw new UnauthorizedException('Token expired');
    }
    return { id: data.sub, email: data.email, name: data.name };
  }

  private signature(value: string) {
    return base64url(createHmac('sha256', this.secret).update(value).digest());
  }
}
