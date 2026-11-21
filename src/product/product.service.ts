import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ProductStatus } from '@prisma/client';
import { findProductCategory } from '../catalog/product-categories';
import { PrismaService } from '../prisma/prisma.service';

export type VariantInput = {
  id?: string;
  sku?: string | null;
  price?: number | string;
  compareAtPrice?: number | string | null;
  stock?: number;
  optionValues?: Record<string, string>;
};

export type ProductInput = {
  name?: string;
  description?: string | null;
  vendor?: string | null;
  tags?: string[];
  seoTitle?: string | null;
  seoDescription?: string | null;
  status?: ProductStatus;
  categorySlug?: string | null;
  collectionIds?: string[];
  images?: Array<{ url?: string; alt?: string | null }>;
  // Shopify-style: up to 3 options, variants = one row per combination
  options?: Array<{ name?: string; values?: string[] }>;
  variants?: VariantInput[];
  // shortcut for single-variant products when `variants` is omitted
  price?: number | string;
  stock?: number;
};

const MAX_OPTIONS = 3;
const MAX_VARIANTS = 100;

const include = {
  category: true,
  collections: { include: { collection: true } },
  images: { orderBy: { position: 'asc' } },
  options: { orderBy: { position: 'asc' }, include: { values: true } },
  variants: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
} satisfies Prisma.ProductInclude;

@Injectable()
export class ProductService {
  constructor(private readonly prisma: PrismaService) {}

  findAllForStore(storeId: string) {
    return this.prisma.product.findMany({ where: { storeId }, include });
  }

  async findOne(storeId: string, productId: string) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, storeId },
      include,
    });
    if (!product) {
      throw new NotFoundException('Product not found');
    }
    return product;
  }

  async create(storeId: string, data: ProductInput) {
    const name = this.requiredText(data.name, 'name');
    const options = this.parseOptions(data.options);
    const variants = data.variants
      ? this.parseVariants(data.variants, options)
      : this.singleVariant(data, options);
    const status = this.optionalStatus(data.status);
    const categoryId = data.categorySlug
      ? await this.ensureCategory(storeId, data.categorySlug)
      : undefined;
    const collectionIds = data.collectionIds ?? [];
    await this.assertCollectionsBelongToStore(storeId, collectionIds);

    const product = await this.prisma.product.create({
      data: {
        storeId,
        categoryId,
        name,
        description: data.description?.trim() || null,
        vendor: data.vendor?.trim() || null,
        tags: this.parseTags(data.tags),
        seoTitle: data.seoTitle?.trim() || null,
        seoDescription: data.seoDescription?.trim() || null,
        status,
        images: { create: this.parseImages(data.images) },
        options: { create: this.optionRows(options) },
        collections: { create: collectionIds.map((collectionId) => ({ collectionId })) },
      },
    });
    // variants one by one so createdAt keeps the merchant's order
    for (const variant of variants) {
      await this.prisma.productVariant.create({ data: { productId: product.id, ...variant } });
    }
    return this.findOne(storeId, product.id);
  }

  async update(storeId: string, productId: string, data: ProductInput) {
    const product = await this.findOne(storeId, productId);

    const productData: Prisma.ProductUpdateInput = {};
    if (data.name !== undefined) productData.name = this.requiredText(data.name, 'name');
    if (data.description !== undefined) productData.description = data.description?.trim() || null;
    if (data.vendor !== undefined) productData.vendor = data.vendor?.trim() || null;
    if (data.tags !== undefined) productData.tags = this.parseTags(data.tags);
    if (data.seoTitle !== undefined) productData.seoTitle = data.seoTitle?.trim() || null;
    if (data.seoDescription !== undefined) {
      productData.seoDescription = data.seoDescription?.trim() || null;
    }
    if (data.status !== undefined) productData.status = this.optionalStatus(data.status);
    if (data.categorySlug !== undefined) {
      productData.category = data.categorySlug
        ? { connect: { id: await this.ensureCategory(storeId, data.categorySlug) } }
        : { disconnect: true };
    }

    if (data.options && !data.variants) {
      throw new BadRequestException('variants are required when options change');
    }
    const options = data.options ? this.parseOptions(data.options) : undefined;
    const variants = data.variants
      ? this.parseVariants(
          data.variants,
          options ?? product.options.map((o) => ({ name: o.name, values: o.values.map((v) => v.value) })),
        )
      : undefined;
    const images = data.images ? this.parseImages(data.images) : undefined;
    const collectionIds = data.collectionIds;
    if (collectionIds) {
      await this.assertCollectionsBelongToStore(storeId, collectionIds);
    }

    // legacy single-variant edit: price/stock apply to the first variant
    const quick: Prisma.ProductVariantUpdateInput = {};
    if (!variants && data.price !== undefined) quick.price = this.requiredMoney(data.price, 'price');
    if (!variants && data.stock !== undefined) quick.stock = this.optionalCount(data.stock, 'stock');

    // ids sent by the client must belong to this product
    const ownIds = new Set(product.variants.map((v) => v.id));
    if (variants?.some((v) => v.id && !ownIds.has(v.id))) {
      throw new BadRequestException('Unknown variant id');
    }

    await this.prisma.$transaction(async (tx) => {
      if (Object.keys(productData).length > 0) {
        await tx.product.update({ where: { id: productId }, data: productData });
      }
      if (collectionIds) {
        await tx.productCollection.deleteMany({ where: { productId } });
        await tx.productCollection.createMany({
          data: collectionIds.map((collectionId) => ({ productId, collectionId })),
        });
      }
      if (images) {
        await tx.productImage.deleteMany({ where: { productId } });
        await tx.productImage.createMany({ data: images.map((i) => ({ ...i, productId })) });
      }
      if (options) {
        await tx.productOptionValue.deleteMany({ where: { option: { productId } } });
        await tx.productOption.deleteMany({ where: { productId } });
        for (const option of this.optionRows(options)) {
          await tx.productOption.create({ data: { ...option, productId } });
        }
      }
      if (variants) {
        const keep = new Set(variants.flatMap((v) => (v.id ? [v.id] : [])));
        const removed = [...ownIds].filter((id) => !keep.has(id));
        // order items keep their snapshot, so past orders survive a deleted variant
        await tx.orderItem.updateMany({
          where: { variantId: { in: removed } },
          data: { variantId: null },
        });
        await tx.productVariant.deleteMany({ where: { id: { in: removed } } });
        for (const { id, ...row } of variants) {
          if (id) {
            await tx.productVariant.update({ where: { id }, data: row });
          } else {
            await tx.productVariant.create({ data: { productId, ...row } });
          }
        }
      } else if (Object.keys(quick).length > 0) {
        const first = product.variants[0];
        if (!first) throw new BadRequestException('Product has no variant');
        await tx.productVariant.update({ where: { id: first.id }, data: quick });
      }
    });

    return this.findOne(storeId, productId);
  }

  async remove(storeId: string, productId: string) {
    await this.findOne(storeId, productId);
    await this.prisma.$transaction([
      this.prisma.orderItem.updateMany({
        where: { variant: { productId } },
        data: { variantId: null },
      }),
      this.prisma.productImage.deleteMany({ where: { productId } }),
      this.prisma.productOptionValue.deleteMany({ where: { option: { productId } } }),
      this.prisma.productCollection.deleteMany({ where: { productId } }),
      this.prisma.productOption.deleteMany({ where: { productId } }),
      this.prisma.productVariant.deleteMany({ where: { productId } }),
      this.prisma.product.delete({ where: { id: productId } }),
    ]);
    return { deleted: true };
  }

  // ---- parsing -----------------------------------------------------------

  private parseOptions(raw: ProductInput['options']) {
    const options = (raw ?? []).map((o) => ({
      name: this.requiredText(o.name, 'option name'),
      values: [...new Set((o.values ?? []).map((v) => String(v).trim()).filter(Boolean))],
    }));
    if (options.length > MAX_OPTIONS) {
      throw new BadRequestException(`At most ${MAX_OPTIONS} options`);
    }
    if (new Set(options.map((o) => o.name.toLowerCase())).size !== options.length) {
      throw new BadRequestException('Option names must be unique');
    }
    if (options.some((o) => o.values.length === 0)) {
      throw new BadRequestException('Every option needs at least one value');
    }
    return options;
  }

  private optionRows(options: Array<{ name: string; values: string[] }>) {
    return options.map((o, position) => ({
      name: o.name,
      position,
      values: { create: o.values.map((value) => ({ value })) },
    }));
  }

  // variants must be exactly one per distinct combination of the declared options
  private parseVariants(raw: VariantInput[], options: Array<{ name: string; values: string[] }>) {
    if (raw.length === 0 || raw.length > MAX_VARIANTS) {
      throw new BadRequestException(`Between 1 and ${MAX_VARIANTS} variants required`);
    }
    const seen = new Set<string>();
    return raw.map((v) => {
      const optionValues: Record<string, string> = {};
      for (const option of options) {
        const value = v.optionValues?.[option.name];
        if (!value || !option.values.includes(value)) {
          throw new BadRequestException(`Variant needs a valid "${option.name}" value`);
        }
        optionValues[option.name] = value;
      }
      const key = JSON.stringify(options.map((o) => optionValues[o.name]));
      if (seen.has(key)) {
        throw new BadRequestException('Duplicate variant combination');
      }
      seen.add(key);
      const compareAtPrice =
        v.compareAtPrice === null || v.compareAtPrice === undefined || v.compareAtPrice === ''
          ? null
          : this.requiredMoney(v.compareAtPrice, 'compareAtPrice');
      return {
        id: v.id,
        sku: v.sku?.trim() || null,
        price: this.requiredMoney(v.price, 'price'),
        compareAtPrice,
        stock: this.optionalCount(v.stock, 'stock') ?? 0,
        optionValues,
      };
    });
  }

  private singleVariant(data: ProductInput, options: Array<{ name: string; values: string[] }>) {
    if (options.length > 0) {
      throw new BadRequestException('variants are required when options are set');
    }
    return this.parseVariants([{ price: data.price, stock: data.stock }], []);
  }

  private parseImages(raw: ProductInput['images']) {
    return (raw ?? []).map((image, position) => {
      const url = this.requiredText(image.url, 'image url');
      if (!/^https?:\/\//i.test(url)) {
        throw new BadRequestException('image url must start with http(s)://');
      }
      return { url, alt: image.alt?.trim() || null, position };
    });
  }

  private parseTags(raw: string[] | undefined) {
    return [...new Set((raw ?? []).map((t) => t.trim()).filter(Boolean))];
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

  private optionalCount(value: number | undefined, field: string): number | undefined {
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

  private async assertCollectionsBelongToStore(storeId: string, collectionIds: string[]) {
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
