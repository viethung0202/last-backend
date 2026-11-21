import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PaymentMethod, StoreRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

// Subdomains the platform keeps for itself.
const RESERVED_SLUGS = new Set(['www', 'api', 'admin', 'platform', 'app', 'mail', 'static', 'cdn']);

@Injectable()
export class StoreService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, data: { slug?: string; name?: string; currency?: string }) {
    const name = data.name?.trim();
    const slug = data.slug?.trim().toLowerCase();
    const currency = data.currency?.trim().toUpperCase() || 'VND';
    if (!name) {
      throw new BadRequestException('name is required');
    }
    if (!slug || !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)) {
      throw new BadRequestException(
        'slug must be 1-63 lowercase letters, numbers, or inner hyphens',
      );
    }
    if (RESERVED_SLUGS.has(slug)) {
      throw new BadRequestException(`slug "${slug}" is reserved`);
    }
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new BadRequestException('currency must be a 3-letter ISO code');
    }

    const hostname = `${slug}.${process.env.ROOT_DOMAIN ?? 'localhost'}`;
    const taken = await this.prisma.store.findFirst({
      where: { OR: [{ slug }, { domains: { some: { hostname } } }] },
      select: { id: true },
    });
    if (taken) {
      throw new ConflictException('slug is already taken');
    }

    return this.prisma.store.create({
      data: {
        name,
        slug,
        currency,
        members: { create: { userId, role: StoreRole.OWNER } },
        domains: { create: { hostname, isPrimary: true } },
        paymentMethods: { create: { method: PaymentMethod.COD, enabled: true } },
      },
      include: { domains: true },
    });
  }

  async findMine(userId: string) {
    const memberships = await this.prisma.storeMember.findMany({
      where: { userId },
      include: { store: { include: { domains: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return memberships.map(({ store, role }) => ({ ...store, role }));
  }

  update(storeId: string, data: { name?: string; currency?: string }) {
    const patch: { name?: string; currency?: string } = {};
    if (data.name !== undefined) {
      patch.name = data.name.trim();
      if (!patch.name) {
        throw new BadRequestException('name is required');
      }
    }
    if (data.currency !== undefined) {
      patch.currency = data.currency.trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(patch.currency)) {
        throw new BadRequestException('currency must be a 3-letter ISO code');
      }
    }
    return this.prisma.store.update({
      where: { id: storeId },
      data: patch,
      include: { domains: true },
    });
  }

  // --- domains ---

  listDomains(storeId: string) {
    return this.prisma.storeDomain.findMany({
      where: { storeId },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    });
  }

  // Custom domains only: subdomains of ROOT_DOMAIN belong to store slugs.
  // ponytail: no DNS/TLS verification, custom domain serving is out of scope (see doc/README.md).
  async addDomain(storeId: string, rawHostname: string | undefined) {
    const hostname = rawHostname?.trim().toLowerCase().replace(/\.$/, '') ?? '';
    const label = '[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?';
    if (hostname.length > 253 || !new RegExp(`^(${label}\\.)+[a-z]{2,63}$`).test(hostname)) {
      throw new BadRequestException('hostname must look like shop.example.com');
    }
    const root = process.env.ROOT_DOMAIN ?? 'localhost';
    if (hostname === root || hostname.endsWith(`.${root}`)) {
      throw new BadRequestException(`subdomains of ${root} are assigned from the store slug`);
    }
    const taken = await this.prisma.storeDomain.findUnique({ where: { hostname } });
    if (taken) {
      throw new ConflictException('hostname is already used');
    }
    return this.prisma.storeDomain.create({ data: { storeId, hostname } });
  }

  async setPrimaryDomain(storeId: string, domainId: string) {
    await this.requireDomain(storeId, domainId);
    await this.prisma.$transaction([
      this.prisma.storeDomain.updateMany({ where: { storeId }, data: { isPrimary: false } }),
      this.prisma.storeDomain.update({ where: { id: domainId }, data: { isPrimary: true } }),
    ]);
    return this.listDomains(storeId);
  }

  async removeDomain(storeId: string, domainId: string) {
    const domain = await this.requireDomain(storeId, domainId);
    if (domain.isPrimary) {
      throw new BadRequestException('make another domain primary first');
    }
    await this.prisma.storeDomain.delete({ where: { id: domainId } });
    return this.listDomains(storeId);
  }

  private async requireDomain(storeId: string, domainId: string) {
    const domain = await this.prisma.storeDomain.findFirst({ where: { id: domainId, storeId } });
    if (!domain) {
      throw new NotFoundException('Domain not found');
    }
    return domain;
  }

  // --- staff ---

  listMembers(storeId: string) {
    return this.prisma.storeMember.findMany({
      where: { storeId },
      include: { user: { select: { id: true, email: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ponytail: adds an already-registered user by email; no invitation emails.
  async addMember(storeId: string, data: { email?: string; role?: StoreRole }) {
    const email = data.email?.trim().toLowerCase();
    const role = this.parseRole(data.role ?? StoreRole.STAFF);
    const user = email ? await this.prisma.user.findUnique({ where: { email } }) : null;
    if (!user) {
      throw new NotFoundException('No merchant account with that email; ask them to register first');
    }
    const existing = await this.prisma.storeMember.findUnique({
      where: { userId_storeId: { userId: user.id, storeId } },
    });
    if (existing) {
      throw new ConflictException('Already a member');
    }
    await this.prisma.storeMember.create({ data: { userId: user.id, storeId, role } });
    return this.listMembers(storeId);
  }

  async updateMemberRole(storeId: string, userId: string, rawRole: StoreRole | undefined) {
    const role = this.parseRole(rawRole);
    await this.requireMember(storeId, userId);
    if (role !== StoreRole.OWNER) {
      await this.assertNotLastOwner(storeId, userId);
    }
    await this.prisma.storeMember.update({
      where: { userId_storeId: { userId, storeId } },
      data: { role },
    });
    return this.listMembers(storeId);
  }

  async removeMember(storeId: string, userId: string) {
    await this.requireMember(storeId, userId);
    await this.assertNotLastOwner(storeId, userId);
    await this.prisma.storeMember.delete({ where: { userId_storeId: { userId, storeId } } });
    return this.listMembers(storeId);
  }

  private parseRole(role: StoreRole | undefined) {
    if (!role || !Object.values(StoreRole).includes(role)) {
      throw new BadRequestException('role must be OWNER or STAFF');
    }
    return role;
  }

  private async requireMember(storeId: string, userId: string) {
    const member = await this.prisma.storeMember.findUnique({
      where: { userId_storeId: { userId, storeId } },
    });
    if (!member) {
      throw new NotFoundException('Member not found');
    }
    return member;
  }

  private async assertNotLastOwner(storeId: string, userId: string) {
    const owners = await this.prisma.storeMember.findMany({
      where: { storeId, role: StoreRole.OWNER },
      select: { userId: true },
    });
    if (owners.length === 1 && owners[0].userId === userId) {
      throw new BadRequestException('A store needs at least one owner');
    }
  }

  findBySlug(slug: string) {
    return this.prisma.store.findUnique({ where: { slug }, include: { domains: true } });
  }

  async findByHostname(hostname: string) {
    const domain = await this.prisma.storeDomain.findUnique({
      where: { hostname: hostname.trim().toLowerCase() },
      include: { store: { include: { domains: true } } },
    });
    return domain?.store ?? null;
  }
}
