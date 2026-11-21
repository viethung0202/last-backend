import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TenantGuard } from '../store/tenant.guard';
import { DashboardController } from './dashboard.controller';

@Module({
  imports: [AuthModule],
  controllers: [DashboardController],
  providers: [TenantGuard],
})
export class DashboardModule {}
