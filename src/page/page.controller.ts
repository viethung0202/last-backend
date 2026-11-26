import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { MerchantAuthGuard } from '../auth/merchant-auth.guard';
import { StoreMemberGuard } from '../auth/store-member.guard';
import { CurrentStore } from '../store/current-store.decorator';
import { TenantGuard } from '../store/tenant.guard';
import { PageService } from './page.service';

type Store = { id: string };

@Controller('stores/:storeSlug/pages')
@UseGuards(TenantGuard, MerchantAuthGuard, StoreMemberGuard)
export class PageController {
  constructor(private readonly pages: PageService) {}

  @Get()
  list(@CurrentStore() store: Store) {
    return this.pages.list(store.id);
  }

  @Post()
  create(@CurrentStore() store: Store, @Body() body: { title?: string; slug?: string; data?: unknown }) {
    return this.pages.create(store.id, body);
  }

  @Get(':id')
  get(@CurrentStore() store: Store, @Param('id') id: string) {
    return this.pages.get(store.id, id);
  }

  @Put(':id/draft')
  saveDraft(@CurrentStore() store: Store, @Param('id') id: string, @Body() body: { title?: string; data?: unknown }) {
    return this.pages.saveDraft(store.id, id, body);
  }

  @Post(':id/publish')
  publish(@CurrentStore() store: Store, @Param('id') id: string) {
    return this.pages.publish(store.id, id);
  }

  @Post(':id/versions/:versionId/restore')
  restore(@CurrentStore() store: Store, @Param('id') id: string, @Param('versionId') versionId: string) {
    return this.pages.restore(store.id, id, versionId);
  }

  @Delete(':id')
  remove(@CurrentStore() store: Store, @Param('id') id: string) {
    return this.pages.remove(store.id, id);
  }
}

// Public read of the published version, used by the storefront.
@Controller('stores/:storeSlug/site')
@UseGuards(TenantGuard)
export class SiteController {
  constructor(private readonly pages: PageService) {}

  @Get(':pageSlug')
  page(@CurrentStore() store: Store, @Param('pageSlug') slug: string) {
    return this.pages.published(store.id, slug);
  }
}
