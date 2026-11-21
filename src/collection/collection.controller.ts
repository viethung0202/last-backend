import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { MerchantAuthGuard } from '../auth/merchant-auth.guard';
import { StoreMemberGuard } from '../auth/store-member.guard';
import { CurrentStore } from '../store/current-store.decorator';
import { TenantGuard } from '../store/tenant.guard';
import { CollectionService } from './collection.service';

@Controller('stores/:storeSlug/collections')
@UseGuards(TenantGuard)
export class CollectionController {
  constructor(private readonly collections: CollectionService) {}

  @Get()
  findAll(@CurrentStore() store: { id: string }) {
    return this.collections.findAllForStore(store.id);
  }

  @Post()
  @UseGuards(MerchantAuthGuard, StoreMemberGuard)
  create(
    @CurrentStore() store: { id: string },
    @Body() body: { name?: string; slug?: string },
  ) {
    return this.collections.create(store.id, body);
  }

  @Patch(':collectionId')
  @UseGuards(MerchantAuthGuard, StoreMemberGuard)
  update(
    @CurrentStore() store: { id: string },
    @Param('collectionId') collectionId: string,
    @Body() body: { name?: string; slug?: string },
  ) {
    return this.collections.update(store.id, collectionId, body);
  }

  @Delete(':collectionId')
  @UseGuards(MerchantAuthGuard, StoreMemberGuard)
  remove(@CurrentStore() store: { id: string }, @Param('collectionId') collectionId: string) {
    return this.collections.remove(store.id, collectionId);
  }
}
