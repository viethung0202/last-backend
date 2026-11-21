export const PRODUCT_CATEGORIES = [
  { slug: 'apparel-accessories', name: 'Apparel & accessories' },
  { slug: 'baby-kids', name: 'Baby & kids' },
  { slug: 'beauty-personal-care', name: 'Beauty & personal care' },
  { slug: 'electronics', name: 'Electronics' },
  { slug: 'food-beverage', name: 'Food & beverage' },
  { slug: 'home-garden', name: 'Home & garden' },
  { slug: 'sports-outdoors', name: 'Sports & outdoors' },
  { slug: 'toys-games', name: 'Toys & games' },
] as const;

export function findProductCategory(slug: string) {
  return PRODUCT_CATEGORIES.find((category) => category.slug === slug);
}
