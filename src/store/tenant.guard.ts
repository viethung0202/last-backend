import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// ponytail: resolves tenant from the :storeSlug route param (path-based multi-tenancy).
// Swap for subdomain parsing later if the thesis needs shopa.yourapp.com routing.
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const slug = request.params.storeSlug;
    const store = await this.prisma.store.findUnique({ where: { slug } });
    if (!store) {
      throw new NotFoundException(`Store "${slug}" not found`);
    }
    request.store = store;
    return true;
  }
}
