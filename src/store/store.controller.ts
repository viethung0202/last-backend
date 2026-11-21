import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { StoreRole } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { MerchantAuthGuard } from '../auth/merchant-auth.guard';
import { StoreMemberGuard } from '../auth/store-member.guard';
import { StoreOwnerGuard } from '../auth/store-owner.guard';
import type { AuthUser } from '../auth/token.service';
import { CurrentStore } from './current-store.decorator';
import { StoreService } from './store.service';
import { TenantGuard } from './tenant.guard';

type StoreRef = { id: string };

@Controller('stores')
export class StoreController {
  constructor(private readonly storeService: StoreService) {}

  @Post()
  @UseGuards(MerchantAuthGuard)
  create(
    @CurrentUser() user: AuthUser,
    @Body() body: { slug?: string; name?: string; currency?: string },
  ) {
    return this.storeService.create(user.id, body);
  }

  // Stores the signed-in merchant belongs to, with their role.
  @Get()
  @UseGuards(MerchantAuthGuard)
  findMine(@CurrentUser() user: AuthUser) {
    return this.storeService.findMine(user.id);
  }

  // Storefront calls this with window.location.hostname, then uses the slug routes.
  @Get('by-host/:hostname')
  async findByHost(@Param('hostname') hostname: string) {
    const store = await this.storeService.findByHostname(hostname);
    if (!store) {
      throw new NotFoundException(`No store for host "${hostname}"`);
    }
    return store;
  }

  @Get(':storeSlug')
  findOne(@Param('storeSlug') storeSlug: string) {
    return this.storeService.findBySlug(storeSlug);
  }
}

// Merchant admin: settings, domains, staff.
@Controller('stores/:storeSlug')
@UseGuards(TenantGuard, MerchantAuthGuard)
export class StoreSettingsController {
  constructor(private readonly storeService: StoreService) {}

  @Patch()
  @UseGuards(StoreOwnerGuard)
  update(@CurrentStore() store: StoreRef, @Body() body: { name?: string; currency?: string }) {
    return this.storeService.update(store.id, body);
  }

  @Get('domains')
  @UseGuards(StoreMemberGuard)
  listDomains(@CurrentStore() store: StoreRef) {
    return this.storeService.listDomains(store.id);
  }

  @Post('domains')
  @UseGuards(StoreOwnerGuard)
  addDomain(@CurrentStore() store: StoreRef, @Body() body: { hostname?: string }) {
    return this.storeService.addDomain(store.id, body.hostname);
  }

  @Post('domains/:domainId/primary')
  @UseGuards(StoreOwnerGuard)
  setPrimaryDomain(@CurrentStore() store: StoreRef, @Param('domainId') domainId: string) {
    return this.storeService.setPrimaryDomain(store.id, domainId);
  }

  @Delete('domains/:domainId')
  @UseGuards(StoreOwnerGuard)
  removeDomain(@CurrentStore() store: StoreRef, @Param('domainId') domainId: string) {
    return this.storeService.removeDomain(store.id, domainId);
  }

  @Get('members')
  @UseGuards(StoreMemberGuard)
  listMembers(@CurrentStore() store: StoreRef) {
    return this.storeService.listMembers(store.id);
  }

  @Post('members')
  @UseGuards(StoreOwnerGuard)
  addMember(@CurrentStore() store: StoreRef, @Body() body: { email?: string; role?: StoreRole }) {
    return this.storeService.addMember(store.id, body);
  }

  @Patch('members/:userId')
  @UseGuards(StoreOwnerGuard)
  updateMember(
    @CurrentStore() store: StoreRef,
    @Param('userId') userId: string,
    @Body() body: { role?: StoreRole },
  ) {
    return this.storeService.updateMemberRole(store.id, userId, body.role);
  }

  @Delete('members/:userId')
  @UseGuards(StoreOwnerGuard)
  removeMember(@CurrentStore() store: StoreRef, @Param('userId') userId: string) {
    return this.storeService.removeMember(store.id, userId);
  }
}
