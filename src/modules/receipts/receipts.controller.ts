import { Controller, Get, Header, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProduces, ApiProperty, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { AuthContext } from '../../auth/auth.types';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Public } from '../../auth/decorators/public.decorator';
import { ReceiptsService } from './receipts.service';

class ReceiptLinkDto {
  /** Opens without login. Send it by WhatsApp or SMS. */
  @ApiProperty()
  url!: string;
}

@ApiTags('Receipts')
@ApiBearerAuth()
@Controller('sales/:id/receipt')
export class SaleReceiptsController {
  constructor(private readonly receipts: ReceiptsService) {}

  @Get()
  @ApiOperation({
    summary: 'Receipt for printing or display (POS-04)',
    description: 'format=text gives fixed-width text for 58mm (width=32) or 80mm (width=48) thermal printers. format=html gives a styled page.',
  })
  @ApiQuery({ name: 'format', enum: ['html', 'text'], required: false })
  @ApiQuery({ name: 'width', enum: ['32', '48'], required: false })
  @ApiProduces('text/html', 'text/plain')
  async get(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('format') format: string | undefined,
    @Query('width') width: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const asText = format === 'text';
    const body = await this.receipts.render(auth, id, asText ? 'text' : 'html', width === '48' ? 48 : 32);
    res.type(asText ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8').send(body);
  }

  @Post('link')
  @ApiOperation({ summary: 'Shareable receipt link', description: 'A signed URL the customer can open on their phone without logging in.' })
  @ApiOkResponse({ type: ReceiptLinkDto })
  link(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<ReceiptLinkDto> {
    return this.receipts.shareLink(auth, id);
  }
}

@ApiTags('Receipts')
@Controller('receipts')
export class PublicReceiptsController {
  constructor(private readonly receipts: ReceiptsService) {}

  @Public()
  @Get(':organizationId/:saleId/:signature')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'private, max-age=300')
  @Header('X-Robots-Tag', 'noindex')
  @ApiOperation({ summary: 'Open a shared receipt (no login)' })
  @ApiProduces('text/html')
  shared(
    @Param('organizationId') organizationId: string,
    @Param('saleId') saleId: string,
    @Param('signature') signature: string,
  ): Promise<string> {
    return this.receipts.renderShared(organizationId, saleId, signature);
  }
}
