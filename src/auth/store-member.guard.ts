import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// Runs after MerchantAuthGuard + TenantGuard. Any member (OWNER or STAFF) passes;
// request.membership carries the role for owner-only checks later.
@Injectable()
export class StoreMemberGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const membership =
      request.user && request.store
        ? await this.prisma.storeMember.findUnique({
            where: { userId_storeId: { userId: request.user.id, storeId: request.store.id } },
          })
        : null;
    if (!membership) {
      throw new ForbiddenException('You are not a member of this store');
    }
    request.membership = membership;
    return true;
  }
}
