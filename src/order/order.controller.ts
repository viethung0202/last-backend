import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { MerchantAuthGuard } from '../auth/merchant-auth.guard';
import { StoreOwnerGuard } from '../auth/store-owner.guard';
import { CurrentStore } from '../store/current-store.decorator';
import { TenantGuard } from '../store/tenant.guard';
import { OrderService } from './order.service';

@Controller('stores/:storeSlug/orders')
@UseGuards(TenantGuard)
export class OrderController {
  constructor(private readonly orders: OrderService) {}

  @Get()
  @UseGuards(MerchantAuthGuard, StoreOwnerGuard)
  findAll(@CurrentStore() store: { id: string }) {
    return this.orders.findAllForStore(store.id);
  }

  @Post()
  createGuestOrder(
    @CurrentStore() store: { id: string },
    @Body()
    body: {
      guestEmail?: string;
      guestName?: string;
      items?: Array<{ variantId?: string; quantity?: number }>;
    },
  ) {
    return this.orders.createGuestOrder(store.id, body);
  }

  @Patch(':orderId/status')
  @UseGuards(MerchantAuthGuard, StoreOwnerGuard)
  updateStatus(
    @CurrentStore() store: { id: string },
    @Param('orderId') orderId: string,
    @Body() body: { status?: OrderStatus },
  ) {
    return this.orders.updateStatus(store.id, orderId, body.status as OrderStatus);
  }
}
