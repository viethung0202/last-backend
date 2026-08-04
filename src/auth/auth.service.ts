import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { hashPassword, verifyPassword } from './password';
import { TokenService } from './token.service';

type RegisterInput = {
  email?: string;
  password?: string;
  name?: string;
};

type LoginInput = {
  email?: string;
  password?: string;
};

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
  ) {}

  async register(input: RegisterInput) {
    const email = this.requiredEmail(input.email);
    const password = this.requiredPassword(input.password);
    const name = this.requiredText(input.name, 'name');

    const exists = await this.prisma.user.findUnique({ where: { email } });
    if (exists) {
      throw new ConflictException('Email already registered');
    }

    const user = await this.prisma.user.create({
      data: { email, name, passwordHash: hashPassword(password) },
      select: { id: true, email: true, name: true },
    });
    return { user, token: this.tokens.sign(user) };
  }

  async login(input: LoginInput) {
    const email = this.requiredEmail(input.email);
    const password = this.requiredText(input.password, 'password');
    const user = await this.prisma.user.findUnique({ where: { email } });

    if (!user || !verifyPassword(password, user.passwordHash)) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const publicUser = { id: user.id, email: user.email, name: user.name };
    return { user: publicUser, token: this.tokens.sign(publicUser) };
  }

  private requiredEmail(value: string | undefined) {
    const email = value?.trim().toLowerCase();
    if (!email || !email.includes('@')) {
      throw new BadRequestException('Valid email is required');
    }
    return email;
  }

  private requiredPassword(value: string | undefined) {
    const password = this.requiredText(value, 'password');
    if (password.length < 8) {
      throw new BadRequestException('Password must be at least 8 characters');
    }
    return password;
  }

  private requiredText(value: string | undefined, field: string) {
    const text = value?.trim();
    if (!text) {
      throw new BadRequestException(`${field} is required`);
    }
    return text;
  }
}
