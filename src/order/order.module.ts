import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PaymentModule } from '../payment/payment.module';
import { TenantGuard } from '../store/tenant.guard';
import { OrderController } from './order.controller';
import { OrderService } from './order.service';

@Module({
  imports: [AuthModule, PaymentModule],
  controllers: [OrderController],
  providers: [OrderService, TenantGuard],
})
export class OrderModule {}
