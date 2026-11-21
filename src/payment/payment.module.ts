import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TenantGuard } from '../store/tenant.guard';
import { PaymentMethodController, VnpayController } from './payment.controller';
import { PaymentService } from './payment.service';

@Module({
  imports: [AuthModule],
  controllers: [PaymentMethodController, VnpayController],
  providers: [PaymentService, TenantGuard],
  exports: [PaymentService],
})
export class PaymentModule {}
