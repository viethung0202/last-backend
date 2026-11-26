import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

// Must match the section registry in admin/src/builder/sections.tsx and storefront/src/builder/sections.tsx.
export const SECTION_TYPES = [
  'Hero',
  'ImageWithText',
  'RichText',
  'ProductGrid',
  'CollectionList',
  'Banner',
  'Spacer',
] as const;

const MAX_SECTIONS = 50;
const MAX_BYTES = 200_000;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type PageData = {
  root: { props: Record<string, unknown> };
  content: Array<{ type: string; props: Record<string, unknown> }>;
};

const summary = {
  id: true,
  slug: true,
  title: true,
  updatedAt: true,
  publishedVersion: { select: { id: true, version: true, createdAt: true } },
} satisfies Prisma.PageSelect;

@Injectable()
export class PageService {
  constructor(private readonly prisma: PrismaService) {}

  list(storeId: string) {
    return this.prisma.page.findMany({ where: { storeId }, select: summary, orderBy: { createdAt: 'asc' } });
  }

  async get(storeId: string, id: string) {
    const page = await this.prisma.page.findFirst({
      where: { id, storeId },
      include: {
        publishedVersion: { select: { id: true, version: true, createdAt: true } },
        versions: { select: { id: true, version: true, createdAt: true }, orderBy: { version: 'desc' } },
      },
    });
    if (!page) throw new NotFoundException('Page not found');
    return page;
  }

  async create(storeId: string, input: { title?: string; slug?: string; data?: unknown }) {
    const title = input.title?.trim();
    if (!title) throw new BadRequestException('title is required');
    const slug = (input.slug?.trim() || title).toLowerCase().normalize('NFD')
      .replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!SLUG.test(slug)) throw new BadRequestException('slug must be lowercase letters, digits and -');
    const draft = input.data === undefined ? { root: { props: {} }, content: [] } : this.parseData(input.data);
    try {
      return await this.prisma.page.create({ data: { storeId, slug, title, draft }, select: summary });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new BadRequestException(`A page with slug "${slug}" already exists`);
      }
      throw e;
    }
  }

  async saveDraft(storeId: string, id: string, input: { title?: string; data?: unknown }) {
    await this.get(storeId, id);
    const title = input.title === undefined ? undefined : input.title.trim();
    if (title === '') throw new BadRequestException('title is required');
    await this.prisma.page.update({ where: { id }, data: { title, draft: this.parseData(input.data) } });
    return this.get(storeId, id);
  }

  // Snapshot the draft into a new immutable version and point the page at it.
  async publish(storeId: string, id: string) {
    const page = await this.get(storeId, id);
    const data = this.parseData(page.draft);
    await this.prisma.$transaction(async (tx) => {
      const version = await tx.pageVersion.create({
        data: { pageId: id, version: (page.versions[0]?.version ?? 0) + 1, data },
      });
      await tx.page.update({ where: { id }, data: { publishedVersionId: version.id } });
    });
    return this.get(storeId, id);
  }

  // Rollback: copy an old version back into the draft (publish again to make it live).
  async restore(storeId: string, id: string, versionId: string) {
    await this.get(storeId, id);
    const version = await this.prisma.pageVersion.findFirst({ where: { id: versionId, pageId: id } });
    if (!version) throw new NotFoundException('Version not found');
    await this.prisma.page.update({ where: { id }, data: { draft: version.data as Prisma.InputJsonValue } });
    return this.get(storeId, id);
  }

  async remove(storeId: string, id: string) {
    await this.get(storeId, id);
    await this.prisma.$transaction([
      this.prisma.page.update({ where: { id }, data: { publishedVersionId: null } }),
      this.prisma.pageVersion.deleteMany({ where: { pageId: id } }),
      this.prisma.page.delete({ where: { id } }),
    ]);
    return { deleted: true };
  }

  // Public: what the storefront renders.
  async published(storeId: string, slug: string) {
    const page = await this.prisma.page.findUnique({
      where: { storeId_slug: { storeId, slug } },
      select: { slug: true, title: true, publishedVersion: { select: { version: true, data: true } } },
    });
    if (!page?.publishedVersion) throw new NotFoundException('Page not published');
    return { slug: page.slug, title: page.title, version: page.publishedVersion.version, data: page.publishedVersion.data };
  }

  // Shape check only; section props are rendered as text/escaped by React and URLs are
  // filtered at render time, so no HTML ever goes from here to the page.
  parseData(raw: unknown): Prisma.InputJsonObject {
    const data = raw as PageData;
    if (!data || typeof data !== 'object' || !Array.isArray(data.content)) {
      throw new BadRequestException('data.content must be an array');
    }
    if (JSON.stringify(data).length > MAX_BYTES) throw new BadRequestException('Page is too large');
    if (data.content.length > MAX_SECTIONS) throw new BadRequestException(`At most ${MAX_SECTIONS} sections`);
    const content = data.content.map((section, i) => {
      if (!section || !(SECTION_TYPES as readonly string[]).includes(section.type)) {
        throw new BadRequestException(`Section ${i + 1}: unknown type "${section?.type}"`);
      }
      if (!section.props || typeof section.props !== 'object' || Array.isArray(section.props)) {
        throw new BadRequestException(`Section ${i + 1}: props must be an object`);
      }
      return { type: section.type, props: section.props };
    });
    const rootProps = data.root?.props;
    return { root: { props: rootProps && typeof rootProps === "object" ? rootProps : {} }, content } as unknown as Prisma.InputJsonObject;
  }
}
