import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { MerchantAuthGuard } from '../auth/merchant-auth.guard';
import type { AuthUser } from '../auth/token.service';
import { StoreService } from './store.service';

@Controller('stores')
export class StoreController {
  constructor(private readonly storeService: StoreService) {}

  @Post()
  @UseGuards(MerchantAuthGuard)
  create(
    @CurrentUser() user: AuthUser,
    @Body() body: { slug?: string; name?: string },
  ) {
    return this.storeService.create(user.id, body);
  }

  @Get(':storeSlug')
  findOne(@Param('storeSlug') storeSlug: string) {
    return this.storeService.findBySlug(storeSlug);
  }
}
