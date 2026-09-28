import PDFDocument from 'pdfkit';
import { localParts } from '../../jobs/local-time';
import { CSV_BOM, csvRow } from './csv';
import type { AuditEntryDto } from './dto/audit.dto';

export const CSV_ROW_LIMIT = 200_000;
export const PDF_ROW_LIMIT = 5_000;

const CSV_HEADER = ['When (UTC)', 'When (local)', 'Staff', 'Branch', 'Action', 'Record type', 'Record', 'Summary', 'Before', 'After', 'Entry ID'];

function localStamp(at: Date, timezone: string): string {
  const { date } = localParts(at, timezone);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
  return `${date} ${time}`;
}

export function csvHeader(): string {
  return CSV_BOM + csvRow(CSV_HEADER);
}

export function csvLines(entries: AuditEntryDto[], timezone: string): string {
  return entries
    .map((e) =>
      csvRow([
        e.occurredAt,
        localStamp(e.occurredAt, timezone),
        e.actorName ?? '',
        e.locationName ?? '',
        e.actionType,
        e.entityType,
        e.entityName ?? e.entityId,
        e.summary,
        e.before === null ? '' : JSON.stringify(e.before),
        e.after === null ? '' : JSON.stringify(e.after),
        e.id,
      ]),
    )
    .join('');
}

/** The standard PDF fonts can't draw ₦ or arrows; spell them out. */
function pdfText(s: string): string {
  return s.replace(/₦/g, 'NGN ').replace(/→/g, '->').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[−–—]/g, '-');
}

/** A printable, landscape A4 audit report. */
export function renderPdf(
  entries: AuditEntryDto[],
  meta: { businessName: string; timezone: string; filtersText: string; generatedAt: Date; generatedBy: string },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, bufferPages: true, info: { Title: `Audit log - ${meta.businessName}` } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const cols = [
      { title: 'When', width: 95 },
      { title: 'Staff', width: 95 },
      { title: 'Branch', width: 85 },
      { title: 'Action', width: 110 },
      { title: 'What happened', width: 385 },
    ];
    const left = doc.page.margins.left;
    const bottom = () => doc.page.height - doc.page.margins.bottom - 20;

    const header = () => {
      doc.font('Helvetica-Bold').fontSize(14).fillColor('#14171A').text(pdfText(`${meta.businessName} - Audit log`), left, 36);
      doc
        .font('Helvetica')
        .fontSize(8.5)
        .fillColor('#5f6b76')
        .text(pdfText(`${meta.filtersText} · Generated ${localStamp(meta.generatedAt, meta.timezone)} by ${meta.generatedBy} · ${entries.length} entries`));
      doc.moveDown(0.6);
      let x = left;
      const y = doc.y;
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#14171A');
      for (const c of cols) {
        doc.text(c.title, x, y, { width: c.width - 6 });
        x += c.width;
      }
      doc.moveTo(left, doc.y + 3).lineTo(left + cols.reduce((s, c) => s + c.width, 0), doc.y + 3).strokeColor('#14171A').stroke();
      doc.y += 6;
    };

    header();
    doc.font('Helvetica').fontSize(8);
    for (const e of entries) {
      const cells = [
        localStamp(e.occurredAt, meta.timezone),
        e.actorName ?? '',
        e.locationName ?? '',
        e.actionType,
        e.summary,
      ].map(pdfText);
      const height = Math.max(...cells.map((t, i) => doc.heightOfString(t, { width: cols[i]!.width - 6 }))) + 5;
      if (doc.y + height > bottom()) {
        doc.addPage();
        header();
        doc.font('Helvetica').fontSize(8);
      }
      const y = doc.y;
      let x = left;
      doc.fillColor('#14171A');
      cells.forEach((t, i) => {
        doc.text(t, x, y, { width: cols[i]!.width - 6 });
        x += cols[i]!.width;
      });
      doc.y = y + height;
      doc.moveTo(left, doc.y - 2).lineTo(left + 770, doc.y - 2).strokeColor('#e3e6e8').stroke();
    }

    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.page.margins.bottom = 0; // writing in the margin must not trigger a new page
      doc.font('Helvetica').fontSize(7.5).fillColor('#5f6b76').text(`Page ${i + 1} of ${range.count} · SoftLife`, left, doc.page.height - 30, { lineBreak: false });
    }
    doc.end();
  });
}
