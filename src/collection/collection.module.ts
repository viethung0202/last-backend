import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TenantGuard } from '../store/tenant.guard';
import { CollectionController } from './collection.controller';
import { CollectionService } from './collection.service';

@Module({
  imports: [AuthModule],
  controllers: [CollectionController],
  providers: [CollectionService, TenantGuard],
})
export class CollectionModule {}
