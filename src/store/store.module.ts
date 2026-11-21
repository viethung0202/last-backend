import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { StoreController, StoreSettingsController } from './store.controller';
import { StoreService } from './store.service';
import { TenantGuard } from './tenant.guard';

@Module({
  imports: [AuthModule],
  controllers: [StoreController, StoreSettingsController],
  providers: [StoreService, TenantGuard],
  exports: [StoreService],
})
export class StoreModule {}
