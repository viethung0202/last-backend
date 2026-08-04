import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ProductStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type ProductInput = {
  name?: string;
  description?: string | null;
  priceCents?: number;
  stock?: number;
  status?: ProductStatus;
};

@Injectable()
export class ProductService {
  constructor(private readonly prisma: PrismaService) {}

  findAllForStore(storeId: string) {
    return this.prisma.product.findMany({
      where: { storeId },
      include: { variants: true },
    });
  }

  // ponytail: every product gets one default variant (no options) unless the
  // caller creates additional ProductOption/ProductVariant rows later.
  create(storeId: string, data: ProductInput) {
    const name = this.requiredText(data.name, 'name');
    const priceCents = this.requiredMoney(data.priceCents, 'priceCents');
    const stock = this.optionalCount(data.stock, 'stock') ?? 0;
    const status = this.optionalStatus(data.status);

    return this.prisma.product.create({
      data: {
        storeId,
        name,
        description: data.description?.trim() || null,
        status,
        variants: {
          create: {
            priceCents,
            stock,
            optionValues: {},
          },
        },
      },
      include: { variants: true },
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

    const variantData: { priceCents?: number; stock?: number } = {};
    if (data.priceCents !== undefined) {
      variantData.priceCents = this.requiredMoney(data.priceCents, 'priceCents');
    }
    if (data.stock !== undefined) {
      variantData.stock = this.optionalCount(data.stock, 'stock');
    }

    await this.prisma.$transaction(async (tx) => {
      if (Object.keys(productData).length > 0) {
        await tx.product.update({
          where: { id: productId },
          data: productData,
        });
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
      include: { variants: true },
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

  private requiredMoney(value: number | undefined, field: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new BadRequestException(`${field} must be a non-negative integer`);
    }
    return value;
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
}
