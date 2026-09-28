import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiConflictResponse, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthContext } from '../../auth/auth.types';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CreateProductDto, ListProductsQueryDto, ProductDetailDto, ProductPageDto, UpdateProductDto } from './dto/products.dto';
import { ProductsService } from './products.service';

@ApiTags('Products')
@ApiBearerAuth()
@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  @ApiOperation({
    summary: 'Search, scan or browse products (POS-01)',
    description: 'Alphabetical, paginated. Pass locationId to include stock on hand at that branch. Cost prices are hidden from cashiers and drivers.',
  })
  @ApiOkResponse({ type: ProductPageDto })
  list(@CurrentUser() auth: AuthContext, @Query() query: ListProductsQueryDto): Promise<ProductPageDto> {
    return this.products.list(auth, query);
  }

  @Get('categories')
  @ApiOperation({ summary: 'Categories in use, for the POS browse tabs' })
  @ApiOkResponse({ type: [String] })
  categories(): Promise<string[]> {
    return this.products.categories();
  }

  @Get(':id')
  @ApiOperation({ summary: 'One product with stock at every branch' })
  @ApiOkResponse({ type: ProductDetailDto })
  get(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<ProductDetailDto> {
    return this.products.get(auth, id);
  }

  @Post()
  @Roles('owner', 'manager')
  @ApiOperation({ summary: 'Add a product', description: 'Optionally with opening stock per branch. Retry-safe with id.' })
  @ApiCreatedResponse({ type: ProductDetailDto })
  @ApiConflictResponse({ description: 'Name, SKU or barcode already used' })
  create(@CurrentUser() auth: AuthContext, @Body() dto: CreateProductDto): Promise<ProductDetailDto> {
    return this.products.create(auth, dto);
  }

  @Patch(':id')
  @Roles('owner', 'manager')
  @ApiOperation({
    summary: 'Edit a product or change its price',
    description: 'Send only changed fields. Every change, prices especially, is recorded in the audit log with before and after values. Use isActive: false to retire a product.',
  })
  @ApiOkResponse({ type: ProductDetailDto })
  update(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProductDto): Promise<ProductDetailDto> {
    return this.products.update(auth, id, dto);
  }
}
