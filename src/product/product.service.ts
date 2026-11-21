import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ProductStatus } from '@prisma/client';
import { findProductCategory } from '../catalog/product-categories';
import { PrismaService } from '../prisma/prisma.service';

type ProductInput = {
  name?: string;
  description?: string | null;
  price?: number | string;
  stock?: number;
  status?: ProductStatus;
  categorySlug?: string | null;
  collectionIds?: string[];
};

@Injectable()
export class ProductService {
  constructor(private readonly prisma: PrismaService) {}

  findAllForStore(storeId: string) {
    return this.prisma.product.findMany({
      where: { storeId },
      include: {
        category: true,
        collections: { include: { collection: true } },
        variants: true,
      },
    });
  }

  // ponytail: every product gets one default variant (no options) unless the
  // caller creates additional ProductOption/ProductVariant rows later.
  async create(storeId: string, data: ProductInput) {
    const name = this.requiredText(data.name, 'name');
    const price = this.requiredMoney(data.price, 'price');
    const stock = this.optionalCount(data.stock, 'stock') ?? 0;
    const status = this.optionalStatus(data.status);
    const categoryId = data.categorySlug
      ? await this.ensureCategory(storeId, data.categorySlug)
      : undefined;
    await this.assertCollectionsBelongToStore(storeId, data.collectionIds ?? []);

    return this.prisma.product.create({
      data: {
        storeId,
        categoryId,
        name,
        description: data.description?.trim() || null,
        status,
        variants: {
          create: {
            price,
            stock,
            optionValues: {},
          },
        },
        collections: {
          create: (data.collectionIds ?? []).map((collectionId) => ({
            collectionId,
          })),
        },
      },
      include: {
        category: true,
        collections: { include: { collection: true } },
        variants: true,
      },
    });
  }

  async update(storeId: string, productId: string, data: ProductInput) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, storeId },
      include: { variants: { orderBy: { createdAt: 'asc' }, take: 1 } },
    });
    if (!product) {
      throw new NotFoundException('Product not found');
    }

    const productData: {
      name?: string;
      description?: string | null;
      status?: ProductStatus;
      categoryId?: string | null;
    } = {};
    if (data.name !== undefined) {
      productData.name = this.requiredText(data.name, 'name');
    }
    if (data.description !== undefined) {
      productData.description = data.description?.trim() || null;
    }
    if (data.status !== undefined) {
      productData.status = this.optionalStatus(data.status);
    }
    if (data.categorySlug !== undefined) {
      productData.categoryId = data.categorySlug
        ? await this.ensureCategory(storeId, data.categorySlug)
        : null;
    }

    const variantData: { price?: Prisma.Decimal; stock?: number } = {};
    if (data.price !== undefined) {
      variantData.price = this.requiredMoney(data.price, 'price');
    }
    if (data.stock !== undefined) {
      variantData.stock = this.optionalCount(data.stock, 'stock');
    }

    const collectionIds = data.collectionIds;
    if (collectionIds) {
      await this.assertCollectionsBelongToStore(storeId, collectionIds);
    }

    await this.prisma.$transaction(async (tx) => {
      if (Object.keys(productData).length > 0) {
        await tx.product.update({
          where: { id: productId },
          data: productData,
        });
      }
      if (collectionIds) {
        await tx.productCollection.deleteMany({ where: { productId } });
        if (collectionIds.length > 0) {
          await tx.productCollection.createMany({
            data: collectionIds.map((collectionId) => ({
              productId,
              collectionId,
            })),
          });
        }
      }
      if (Object.keys(variantData).length > 0) {
        const variant = product.variants[0];
        if (!variant) {
          throw new BadRequestException('Product has no default variant');
        }
        await tx.productVariant.update({
          where: { id: variant.id },
          data: variantData,
        });
      }
    });

    return this.prisma.product.findFirst({
      where: { id: productId, storeId },
      include: {
        category: true,
        collections: { include: { collection: true } },
        variants: true,
      },
    });
  }

  async remove(storeId: string, productId: string) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, storeId },
      select: { id: true },
    });
    if (!product) {
      throw new NotFoundException('Product not found');
    }

    await this.prisma.$transaction([
      this.prisma.productOptionValue.deleteMany({
        where: { option: { productId } },
      }),
      this.prisma.productCollection.deleteMany({ where: { productId } }),
      this.prisma.productOption.deleteMany({ where: { productId } }),
      this.prisma.productVariant.deleteMany({ where: { productId } }),
      this.prisma.product.delete({ where: { id: productId } }),
    ]);

    return { deleted: true };
  }

  private requiredText(value: string | undefined, field: string): string {
    const text = value?.trim();
    if (!text) {
      throw new BadRequestException(`${field} is required`);
    }
    return text;
  }

  // Accepts 150000, 19.99 or "19.99"; fits Decimal(12,2).
  private requiredMoney(value: number | string | undefined, field: string): Prisma.Decimal {
    const text = typeof value === 'number' ? String(value) : value?.trim();
    if (!text || !/^\d{1,10}(\.\d{1,2})?$/.test(text)) {
      throw new BadRequestException(
        `${field} must be a non-negative amount with at most 2 decimals`,
      );
    }
    return new Prisma.Decimal(text);
  }

  private optionalCount(
    value: number | undefined,
    field: string,
  ): number | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (!Number.isInteger(value) || value < 0) {
      throw new BadRequestException(`${field} must be a non-negative integer`);
    }
    return value;
  }

  private optionalStatus(value: ProductStatus | undefined): ProductStatus {
    if (value === undefined) {
      return ProductStatus.DRAFT;
    }
    if (!Object.values(ProductStatus).includes(value as ProductStatus)) {
      throw new BadRequestException('status must be DRAFT or ACTIVE');
    }
    return value;
  }

  private async ensureCategory(storeId: string, categorySlug: string) {
    const category = findProductCategory(categorySlug);
    if (!category) {
      throw new BadRequestException('Invalid categorySlug');
    }
    const row = await this.prisma.category.upsert({
      where: { storeId_slug: { storeId, slug: category.slug } },
      update: { name: category.name },
      create: { storeId, slug: category.slug, name: category.name },
    });
    return row.id;
  }

  private async assertCollectionsBelongToStore(
    storeId: string,
    collectionIds: string[],
  ) {
    if (collectionIds.length === 0) {
      return;
    }
    const count = await this.prisma.collection.count({
      where: { storeId, id: { in: collectionIds } },
    });
    if (count !== new Set(collectionIds).size) {
      throw new BadRequestException('Invalid collectionIds');
    }
  }
}
