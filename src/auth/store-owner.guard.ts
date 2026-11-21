import { ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { StoreRole } from '@prisma/client';
import { StoreMemberGuard } from './store-member.guard';

// Settings, domains and staff: OWNER only.
@Injectable()
export class StoreOwnerGuard extends StoreMemberGuard {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    await super.canActivate(context);
    if (context.switchToHttp().getRequest().membership.role !== StoreRole.OWNER) {
      throw new ForbiddenException('Only the store owner can do this');
    }
    return true;
  }
}
