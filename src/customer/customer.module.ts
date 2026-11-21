import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TenantGuard } from '../store/tenant.guard';
import { CustomerController } from './customer.controller';

@Module({
  imports: [AuthModule],
  controllers: [CustomerController],
  providers: [TenantGuard],
})
export class CustomerModule {}
