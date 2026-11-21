import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { MerchantAuthGuard } from './merchant-auth.guard';
import { StoreMemberGuard } from './store-member.guard';
import { StoreOwnerGuard } from './store-owner.guard';
import { TokenService } from './token.service';

@Module({
  controllers: [AuthController],
  providers: [AuthService, TokenService, MerchantAuthGuard, StoreMemberGuard, StoreOwnerGuard],
  exports: [TokenService, MerchantAuthGuard, StoreMemberGuard, StoreOwnerGuard],
})
export class AuthModule {}
