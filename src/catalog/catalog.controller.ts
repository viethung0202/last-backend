import { Controller, Get } from '@nestjs/common';
import { PRODUCT_CATEGORIES } from './product-categories';

@Controller('catalog')
export class CatalogController {
  @Get('categories')
  findCategories() {
    return PRODUCT_CATEGORIES;
  }
}
