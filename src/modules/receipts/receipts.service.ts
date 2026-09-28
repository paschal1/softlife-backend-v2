import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AuthContext } from '../../auth/auth.types';
import { isUuid } from '../../common/ids/uuidv7';
import type { Env } from '../../config/env';
import { TenantDatabase } from '../../database/tenant-database.service';
import { SalesService } from '../sales/sales.service';
import { ReceiptData, renderHtml, renderText } from './receipt-format';

/**
 * Receipts as text (thermal printers) or HTML (screens, WhatsApp links).
 *
 * Share links are signed, not guessable: /receipts/{org}/{sale}/{signature}. Anyone holding
 * the link can view that one receipt and nothing else. Links stop working if
 * JWT_ACCESS_SECRET is rotated.
 */
@Injectable()
export class ReceiptsService {
  constructor(
    private readonly tenantDb: TenantDatabase,
    private readonly sales: SalesService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async render(viewer: AuthContext, saleId: string, format: 'html' | 'text', width: 32 | 48): Promise<string> {
    const data = await this.load(viewer.organizationId, viewer, saleId);
    return format === 'text' ? renderText(data, width) : renderHtml(data);
  }

  async shareLink(viewer: AuthContext, saleId: string): Promise<{ url: string }> {
    await this.load(viewer.organizationId, viewer, saleId); // checks the viewer may see it
    const base = this.config.get('PUBLIC_API_URL', { infer: true }).replace(/\/$/, '');
    return { url: `${base}/api/v1/receipts/${viewer.organizationId}/${saleId}/${this.sign(viewer.organizationId, saleId)}` };
  }

  /** Public: verifies the signature, then renders without a login. */
  async renderShared(organizationId: string, saleId: string, signature: string): Promise<string> {
    if (!isUuid(organizationId) || !isUuid(saleId) || !this.verify(organizationId, saleId, signature)) {
      throw new NotFoundException('Receipt not found');
    }
    return renderHtml(await this.load(organizationId, null, saleId));
  }

  private async load(organizationId: string, viewer: AuthContext | null, saleId: string): Promise<ReceiptData> {
    return this.tenantDb.forOrganization(organizationId, async (trx) => {
      const sale = await this.sales.detail(trx, viewer, saleId);
      const org = await trx.selectFrom('organizations').select(['name', 'timezone']).executeTakeFirstOrThrow();
      const branch = await trx
        .selectFrom('locations')
        .select(['name', 'address', 'phone'])
        .where('id', '=', sale.locationId)
        .executeTakeFirstOrThrow();
      return {
        businessName: org.name,
        branchName: branch.name,
        branchAddress: branch.address,
        branchPhone: branch.phone,
        saleNumber: sale.number,
        occurredAt: sale.occurredAt,
        timezone: org.timezone,
        cashierName: sale.cashierName,
        registerName: sale.registerName,
        customerName: sale.customer?.name ?? null,
        orderType: sale.orderType,
        items: sale.items.map((i) => ({
          name: i.productName,
          quantity: i.quantity,
          unit: i.unit,
          unitPriceKobo: i.unitPriceKobo,
          discountKobo: i.discountKobo,
          lineTotalKobo: i.lineTotalKobo,
        })),
        subtotalKobo: sale.subtotalKobo,
        discountKobo: sale.discountKobo,
        totalKobo: sale.totalKobo,
        payments: sale.payments,
        changeKobo: sale.changeKobo,
        creditKobo: sale.creditKobo,
        delivery: sale.delivery
          ? {
              fulfilment: sale.delivery.fulfilment,
              address: sale.delivery.address,
              date: sale.delivery.date,
              // Only while it's still useful: once delivered or cancelled the code proves nothing.
              code: ['delivered', 'cancelled'].includes(sale.delivery.status) ? null : sale.delivery.confirmationCode,
              codKobo: sale.delivery.codKobo,
            }
          : null,
        status: sale.status,
        voidReason: sale.voidReason,
      };
    });
  }

  private sign(organizationId: string, saleId: string): string {
    return createHmac('sha256', this.config.get('JWT_ACCESS_SECRET', { infer: true }))
      .update(`receipt:${organizationId}:${saleId}`)
      .digest('base64url')
      .slice(0, 22); // 128+ bits is plenty for an unguessable link, and keeps it short
  }

  private verify(organizationId: string, saleId: string, signature: string): boolean {
    const expected = Buffer.from(this.sign(organizationId, saleId));
    const given = Buffer.from(signature);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }
}
