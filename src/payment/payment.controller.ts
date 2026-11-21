import { Body, Controller, Get, Put, Query, UseGuards } from '@nestjs/common';
import { PaymentMethod } from '@prisma/client';
import { MerchantAuthGuard } from '../auth/merchant-auth.guard';
import { StoreMemberGuard } from '../auth/store-member.guard';
import { CurrentStore } from '../store/current-store.decorator';
import { TenantGuard } from '../store/tenant.guard';
import { PaymentService } from './payment.service';

type StoreRef = { id: string; currency: string };

@Controller('stores/:storeSlug/payment-methods')
@UseGuards(TenantGuard)
export class PaymentMethodController {
  constructor(private readonly payments: PaymentService) {}

  @Get()
  find(@CurrentStore() store: StoreRef) {
    return this.payments.getMethods(store);
  }

  @Put()
  @UseGuards(MerchantAuthGuard, StoreMemberGuard)
  update(@CurrentStore() store: StoreRef, @Body() body: Partial<Record<PaymentMethod, boolean>>) {
    return this.payments.setMethods(store, body);
  }
}

@Controller('payments/vnpay')
export class VnpayController {
  constructor(private readonly payments: PaymentService) {}

  // Configure this URL as the IPN URL in the VNPAY merchant portal.
  @Get('ipn')
  ipn(@Query() query: Record<string, string>) {
    return this.payments.handleVnpayIpn(query);
  }
}
