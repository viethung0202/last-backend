import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TokenService } from '../auth/token.service';
import { PrismaService } from '../prisma/prisma.service';

// ponytail: resolves tenant from the :storeSlug route param (path-based multi-tenancy).
// Swap for subdomain parsing later if the thesis needs shopa.yourapp.com routing.
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const slug = request.params.storeSlug;
    const store = await this.prisma.store.findUnique({ where: { slug } });
    if (!store) {
      throw new NotFoundException(`Store "${slug}" not found`);
    }
    // A suspended store is closed to shoppers; only its own members can still reach it (admin).
    if (store.status === 'SUSPENDED' && !(await this.isMember(request.headers.authorization, store.id))) {
      throw new ForbiddenException('This store is temporarily closed');
    }
    request.store = store;
    return true;
  }

  private async isMember(header: unknown, storeId: string) {
    const [type, token] = typeof header === 'string' ? header.split(' ') : [];
    if (type !== 'Bearer' || !token) return false;
    try {
      const user = this.tokens.verify(token);
      return !!(await this.prisma.storeMember.findUnique({ where: { userId_storeId: { userId: user.id, storeId } } }));
    } catch {
      return false;
    }
  }
}
