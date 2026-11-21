import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Discount, DiscountType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type DiscountInput = {
  code?: string;
  type?: DiscountType;
  value?: number | string;
  minSubtotal?: number | string | null;
  usageLimit?: number | null;
  startsAt?: string | null;
  endsAt?: string | null;
  active?: boolean;
};

type Db = PrismaService | Prisma.TransactionClient;

@Injectable()
export class DiscountService {
  constructor(private readonly prisma: PrismaService) {}

  findAll(storeId: string) {
    return this.prisma.discount.findMany({ where: { storeId }, orderBy: { createdAt: 'desc' } });
  }

  async create(storeId: string, input: DiscountInput) {
    const data = this.parse(input, true);
    try {
      return await this.prisma.discount.create({ data: { storeId, ...data } as Prisma.DiscountUncheckedCreateInput });
    } catch (e) {
      throw this.duplicate(e);
    }
  }

  async update(storeId: string, id: string, input: DiscountInput) {
    const existing = await this.get(storeId, id);
    const data = this.parse(input, false, existing.type);
    try {
      return await this.prisma.discount.update({ where: { id }, data });
    } catch (e) {
      throw this.duplicate(e);
    }
  }

  async remove(storeId: string, id: string) {
    await this.get(storeId, id);
    await this.prisma.discount.delete({ where: { id } });
    return { deleted: true };
  }

  // Public check used by the storefront cart.
  async validate(storeId: string, code: string | undefined, subtotal: number | string | undefined) {
    const sub = new Prisma.Decimal(String(subtotal ?? '0'));
    const { discount, amount } = await this.quote(this.prisma, storeId, code, sub);
    return { code: discount.code, type: discount.type, value: discount.value, amount };
  }

  // Checks the code and returns how much it takes off. Throws 400 with a reason if unusable.
  // Usage is only counted by `consume`, inside the order transaction.
  async quote(db: Db, storeId: string, code: string | undefined, subtotal: Prisma.Decimal) {
    const normalized = code?.trim().toUpperCase();
    const discount = normalized
      ? await db.discount.findUnique({ where: { storeId_code: { storeId, code: normalized } } })
      : null;
    const now = new Date();
    if (!discount || !discount.active) throw new BadRequestException('Invalid discount code');
    if (discount.startsAt && discount.startsAt > now) throw new BadRequestException('Discount is not active yet');
    if (discount.endsAt && discount.endsAt < now) throw new BadRequestException('Discount has expired');
    if (discount.usageLimit !== null && discount.usedCount >= discount.usageLimit) {
      throw new BadRequestException('Discount usage limit reached');
    }
    if (discount.minSubtotal && subtotal.lt(discount.minSubtotal)) {
      throw new BadRequestException(`Minimum order amount is ${discount.minSubtotal}`);
    }
    const amount =
      discount.type === DiscountType.PERCENTAGE
        ? subtotal.times(discount.value).div(100).toDecimalPlaces(2)
        : Prisma.Decimal.min(discount.value, subtotal);
    return { discount, amount };
  }

  // Atomic against concurrent orders: the update only matches while under the limit.
  async consume(tx: Prisma.TransactionClient, discount: Discount) {
    const { count } = await tx.discount.updateMany({
      where: {
        id: discount.id,
        active: true,
        ...(discount.usageLimit !== null ? { usedCount: { lt: discount.usageLimit } } : {}),
      },
      data: { usedCount: { increment: 1 } },
    });
    if (count === 0) throw new BadRequestException('Discount usage limit reached');
  }

  private async get(storeId: string, id: string) {
    const discount = await this.prisma.discount.findFirst({ where: { id, storeId } });
    if (!discount) throw new NotFoundException('Discount not found');
    return discount;
  }

  private parse(input: DiscountInput, creating: boolean, existingType?: DiscountType) {
    const data: Prisma.DiscountUpdateInput = {};
    if (creating || input.code !== undefined) {
      const code = input.code?.trim().toUpperCase();
      if (!code || !/^[A-Z0-9_-]{3,32}$/.test(code)) {
        throw new BadRequestException('code must be 3-32 letters, digits, - or _');
      }
      data.code = code;
    }
    const type = input.type ?? (creating ? undefined : null);
    if (type !== null) {
      if (!type || !Object.values(DiscountType).includes(type)) {
        throw new BadRequestException('type must be PERCENTAGE or FIXED');
      }
      data.type = type;
    }
    if (creating || input.value !== undefined) {
      const value = this.money(input.value, 'value');
      if (value.lte(0)) throw new BadRequestException('value must be greater than 0');
      if ((type ?? existingType) === DiscountType.PERCENTAGE && value.gt(100)) {
        throw new BadRequestException('percentage must be at most 100');
      }
      data.value = value;
    }
    if (input.minSubtotal !== undefined) {
      data.minSubtotal = input.minSubtotal === null ? null : this.money(input.minSubtotal, 'minSubtotal');
    }
    if (input.usageLimit !== undefined) {
      if (input.usageLimit !== null && (!Number.isInteger(input.usageLimit) || input.usageLimit < 1)) {
        throw new BadRequestException('usageLimit must be a positive integer');
      }
      data.usageLimit = input.usageLimit;
    }
    for (const field of ['startsAt', 'endsAt'] as const) {
      const raw = input[field];
      if (raw !== undefined) {
        const date = raw === null ? null : new Date(raw);
        if (date && Number.isNaN(date.getTime())) throw new BadRequestException(`${field} is not a valid date`);
        data[field] = date;
      }
    }
    if (input.active !== undefined) data.active = Boolean(input.active);
    return data;
  }

  private money(value: number | string | undefined | null, field: string) {
    const text = typeof value === 'number' ? String(value) : value?.trim();
    if (!text || !/^\d{1,10}(\.\d{1,2})?$/.test(text)) {
      throw new BadRequestException(`${field} must be a non-negative amount with at most 2 decimals`);
    }
    return new Prisma.Decimal(text);
  }

  private duplicate(e: unknown) {
    return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002'
      ? new BadRequestException('Discount code already exists')
      : e;
  }
}
