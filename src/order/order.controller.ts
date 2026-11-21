import { Body, Controller, Delete, Get, Put, Ip, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { OrderStatus, PaymentMethod } from '@prisma/client';
import { MerchantAuthGuard } from '../auth/merchant-auth.guard';
import { StoreMemberGuard } from '../auth/store-member.guard';
import { CurrentStore } from '../store/current-store.decorator';
import { TenantGuard } from '../store/tenant.guard';
import { OrderService } from './order.service';
import type { DraftInput } from './order.service';

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
      discountCode?: string;
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

@Controller('stores/:storeSlug/draft-orders')
@UseGuards(TenantGuard, MerchantAuthGuard, StoreMemberGuard)
export class DraftOrderController {
  constructor(private readonly orders: OrderService) {}

  @Get()
  findAll(@CurrentStore() store: { id: string }) {
    return this.orders.findDrafts(store.id);
  }

  @Get(':id')
  findOne(@CurrentStore() store: { id: string }, @Param('id') id: string) {
    return this.orders.findDraft(store.id, id);
  }

  @Post()
  create(@CurrentStore() store: { id: string }, @Body() body: DraftInput) {
    return this.orders.createDraft(store.id, body);
  }

  @Put(':id')
  update(@CurrentStore() store: { id: string }, @Param('id') id: string, @Body() body: DraftInput) {
    return this.orders.updateDraft(store.id, id, body);
  }

  @Delete(':id')
  remove(@CurrentStore() store: { id: string }, @Param('id') id: string) {
    return this.orders.deleteDraft(store.id, id);
  }

  @Post(':id/complete')
  complete(
    @CurrentStore() store: { id: string },
    @Param('id') id: string,
    @Body() body: { markPaid?: boolean },
  ) {
    return this.orders.completeDraft(store.id, id, Boolean(body?.markPaid));
  }
}
