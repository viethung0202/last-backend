import { createParamDecorator, ExecutionContext } from '@nestjs/common';

// Use in any controller behind TenantGuard: @CurrentStore() store
export const CurrentStore = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    return ctx.switchToHttp().getRequest().store;
  },
);
