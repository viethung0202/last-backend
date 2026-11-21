import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ProductService } from './product.service';
import type { ProductInput } from './product.service';
import { TenantGuard } from '../store/tenant.guard';
import { CurrentStore } from '../store/current-store.decorator';
import { MerchantAuthGuard } from '../auth/merchant-auth.guard';
import { StoreMemberGuard } from '../auth/store-member.guard';

@Controller('stores/:storeSlug/products')
@UseGuards(TenantGuard)
export class ProductController {
  constructor(private readonly productService: ProductService) {}

  @Get()
  findAll(@CurrentStore() store: { id: string }) {
    return this.productService.findAllForStore(store.id);
  }

  @Get(':productId')
  findOne(@CurrentStore() store: { id: string }, @Param('productId') productId: string) {
    return this.productService.findOne(store.id, productId);
  }

  @Post()
  @UseGuards(MerchantAuthGuard, StoreMemberGuard)
  create(@CurrentStore() store: { id: string }, @Body() body: ProductInput) {
    return this.productService.create(store.id, body);
  }

  @Patch(':productId')
  @UseGuards(MerchantAuthGuard, StoreMemberGuard)
  update(
    @CurrentStore() store: { id: string },
    @Param('productId') productId: string,
    @Body() body: ProductInput,
  ) {
    return this.productService.update(store.id, productId, body);
  }

  @Delete(':productId')
  @UseGuards(MerchantAuthGuard, StoreMemberGuard)
  remove(@CurrentStore() store: { id: string }, @Param('productId') productId: string) {
    return this.productService.remove(store.id, productId);
  }
}
