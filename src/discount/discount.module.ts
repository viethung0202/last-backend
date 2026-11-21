import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TenantGuard } from '../store/tenant.guard';
import { DiscountController } from './discount.controller';
import { DiscountService } from './discount.service';

@Module({
  imports: [AuthModule],
  controllers: [DiscountController],
  providers: [DiscountService, TenantGuard],
  exports: [DiscountService],
})
export class DiscountModule {}
