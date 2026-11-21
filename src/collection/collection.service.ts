import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CollectionService {
  constructor(private readonly prisma: PrismaService) {}

  findAllForStore(storeId: string) {
    return this.prisma.collection.findMany({
      where: { storeId },
      orderBy: { name: 'asc' },
      include: { _count: { select: { products: true } } },
    });
  }

  async update(storeId: string, collectionId: string, data: { name?: string; slug?: string }) {
    await this.requireCollection(storeId, collectionId);
    return this.prisma.collection.update({
      where: { id: collectionId },
      data: {
        ...(data.name !== undefined ? { name: this.requiredText(data.name, 'name') } : {}),
        ...(data.slug !== undefined ? { slug: this.slugify(data.slug) } : {}),
      },
    });
  }

  // Products stay; only their membership in this collection is removed.
  async remove(storeId: string, collectionId: string) {
    await this.requireCollection(storeId, collectionId);
    await this.prisma.$transaction([
      this.prisma.productCollection.deleteMany({ where: { collectionId } }),
      this.prisma.collection.delete({ where: { id: collectionId } }),
    ]);
    return { deleted: true };
  }

  private async requireCollection(storeId: string, collectionId: string) {
    const collection = await this.prisma.collection.findFirst({
      where: { id: collectionId, storeId },
      select: { id: true },
    });
    if (!collection) {
      throw new NotFoundException('Collection not found');
    }
  }

  create(storeId: string, data: { name?: string; slug?: string }) {
    const name = this.requiredText(data.name, 'name');
    const slug = this.slugify(data.slug || name);
    return this.prisma.collection.create({
      data: { storeId, name, slug },
    });
  }

  private requiredText(value: string | undefined, field: string) {
    const text = value?.trim();
    if (!text) {
      throw new BadRequestException(`${field} is required`);
    }
    return text;
  }

  private slugify(value: string) {
    const slug = value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    if (!slug) {
      throw new BadRequestException('slug is required');
    }
    return slug;
  }
}
