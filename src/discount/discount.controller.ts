import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { MerchantAuthGuard } from '../auth/merchant-auth.guard';
import { StoreMemberGuard } from '../auth/store-member.guard';
import { CurrentStore } from '../store/current-store.decorator';
import { TenantGuard } from '../store/tenant.guard';
import { DiscountService } from './discount.service';
import type { DiscountInput } from './discount.service';

@Controller('stores/:storeSlug/discounts')
@UseGuards(TenantGuard)
export class DiscountController {
  constructor(private readonly discounts: DiscountService) {}

  // public: storefront checks a code against the cart subtotal before ordering
  @Post('validate')
  validate(
    @CurrentStore() store: { id: string },
    @Body() body: { code?: string; subtotal?: number | string },
  ) {
    return this.discounts.validate(store.id, body.code, body.subtotal);
  }

  @Get()
  @UseGuards(MerchantAuthGuard, StoreMemberGuard)
  findAll(@CurrentStore() store: { id: string }) {
    return this.discounts.findAll(store.id);
  }

  @Post()
  @UseGuards(MerchantAuthGuard, StoreMemberGuard)
  create(@CurrentStore() store: { id: string }, @Body() body: DiscountInput) {
    return this.discounts.create(store.id, body);
  }

  @Patch(':id')
  @UseGuards(MerchantAuthGuard, StoreMemberGuard)
  update(@CurrentStore() store: { id: string }, @Param('id') id: string, @Body() body: DiscountInput) {
    return this.discounts.update(store.id, id, body);
  }

  @Delete(':id')
  @UseGuards(MerchantAuthGuard, StoreMemberGuard)
  remove(@CurrentStore() store: { id: string }, @Param('id') id: string) {
    return this.discounts.remove(store.id, id);
  }
}
