import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class StoreService {
  constructor(private readonly prisma: PrismaService) {}

  create(ownerId: string, data: { slug?: string; name?: string }) {
    const name = data.name?.trim();
    const slug = data.slug?.trim().toLowerCase();
    if (!name) {
      throw new BadRequestException('name is required');
    }
    if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
      throw new BadRequestException('slug must contain only lowercase letters, numbers, and hyphens');
    }
    return this.prisma.store.create({ data: { ownerId, name, slug } });
  }

  findBySlug(slug: string) {
    return this.prisma.store.findUnique({ where: { slug } });
  }
}
