import { Body, Controller, Get, Ip, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { OrderStatus, PaymentMethod } from '@prisma/client';
import { MerchantAuthGuard } from '../auth/merchant-auth.guard';
import { StoreMemberGuard } from '../auth/store-member.guard';
import { CurrentStore } from '../store/current-store.decorator';
import { TenantGuard } from '../store/tenant.guard';
import { OrderService } from './order.service';

@Controller('stores/:storeSlug/orders')
@UseGuards(TenantGuard)
export class OrderController {
  constructor(private readonly orders: OrderService) {}

  @Get()
  @UseGuards(MerchantAuthGuard, StoreMemberGuard)
  findAll(@CurrentStore() store: { id: string }) {
    return this.orders.findAllForStore(store.id);
  }

  @Post()
  createGuestOrder(
    @CurrentStore() store: { id: string; currency: string },
    @Ip() ip: string,
    @Body()
    body: {
      guestEmail?: string;
      guestName?: string;
      paymentMethod?: PaymentMethod;
      returnUrl?: string;
      items?: Array<{ variantId?: string; quantity?: number }>;
    },
  ) {
    return this.orders.createGuestOrder(store, body, ip);
  }

  @Get(':orderId')
  findForGuest(
    @CurrentStore() store: { id: string },
    @Param('orderId') orderId: string,
    @Query('email') email?: string,
  ) {
    return this.orders.findForGuest(store.id, orderId, email);
  }

  @Patch(':orderId/status')
  @UseGuards(MerchantAuthGuard, StoreMemberGuard)
  updateStatus(
    @CurrentStore() store: { id: string },
    @Param('orderId') orderId: string,
    @Body() body: { status?: OrderStatus },
  ) {
    return this.orders.updateStatus(store.id, orderId, body.status as OrderStatus);
  }
}
