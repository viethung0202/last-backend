import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ProductService } from './product.service';
import { TenantGuard } from '../store/tenant.guard';
import { CurrentStore } from '../store/current-store.decorator';
import { MerchantAuthGuard } from '../auth/merchant-auth.guard';
import { StoreOwnerGuard } from '../auth/store-owner.guard';

@Controller('stores/:storeSlug/products')
@UseGuards(TenantGuard)
export class ProductController {
  constructor(private readonly productService: ProductService) {}

  @Get()
  findAll(@CurrentStore() store: { id: string }) {
    return this.productService.findAllForStore(store.id);
  }

  @Post()
  @UseGuards(MerchantAuthGuard, StoreOwnerGuard)
  create(
    @CurrentStore() store: { id: string },
    @Body()
    body: {
      name?: string;
      description?: string;
      priceCents?: number;
      stock?: number;
      status?: 'DRAFT' | 'ACTIVE';
    },
  ) {
    return this.productService.create(store.id, body);
  }

  @Patch(':productId')
  @UseGuards(MerchantAuthGuard, StoreOwnerGuard)
  update(
    @CurrentStore() store: { id: string },
    @Param('productId') productId: string,
    @Body()
    body: {
      name?: string;
      description?: string | null;
      priceCents?: number;
      stock?: number;
      status?: 'DRAFT' | 'ACTIVE';
    },
  ) {
    return this.productService.update(store.id, productId, body);
  }

  @Delete(':productId')
  @UseGuards(MerchantAuthGuard, StoreOwnerGuard)
  remove(
    @CurrentStore() store: { id: string },
    @Param('productId') productId: string,
  ) {
    return this.productService.remove(store.id, productId);
  }
}
