import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

@Injectable()
export class StoreOwnerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    if (!request.user || !request.store || request.store.ownerId !== request.user.id) {
      throw new ForbiddenException('You do not own this store');
    }
    return true;
  }
}
