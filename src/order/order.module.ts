import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DiscountModule } from '../discount/discount.module';
import { PaymentModule } from '../payment/payment.module';
import { TenantGuard } from '../store/tenant.guard';
import { DraftOrderController, OrderController } from './order.controller';
import { OrderExpiryService } from './order-expiry.service';
import { OrderService } from './order.service';

@Module({
  imports: [AuthModule, PaymentModule, DiscountModule],
  controllers: [OrderController, DraftOrderController],
  providers: [OrderService, OrderExpiryService, TenantGuard],
})
export class OrderModule {}
