import { afterEach, describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from '@e965/xlsx';
import {
  MAX_EXTRACTED_ATTACHMENT_CHARS,
  extractAttachmentText,
} from '../services/OutreachAttachmentService.js';

const originalVisionFlag = process.env.ATTACHMENT_VISION_EXTRACTION_ENABLED;

afterEach(() => {
  if (originalVisionFlag === undefined) delete process.env.ATTACHMENT_VISION_EXTRACTION_ENABLED;
  else process.env.ATTACHMENT_VISION_EXTRACTION_ENABLED = originalVisionFlag;
});

describe('outreach attachment extraction', () => {
  it('extracts and bounds plain text and CSV content', async () => {
    const plain = await extractAttachmentText(
      Buffer.from(`account,amount\nAcme,42\n${'x'.repeat(MAX_EXTRACTED_ATTACHMENT_CHARS + 100)}`),
      'text/csv',
      'accounts.csv',
    );
    expect(plain.status).toBe('success');
    expect(plain.text).toContain('Acme,42');
    expect(plain.text?.length).toBe(MAX_EXTRACTED_ATTACHMENT_CHARS);
  });

  it('extracts spreadsheet cells with sheet names', async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([['Account', 'Revenue'], ['Acme', 42]]),
      'Pipeline',
    );
    const result = await extractAttachmentText(
      XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'pipeline.xlsx',
    );
    expect(result).toMatchObject({ status: 'success' });
    expect(result.text).toContain('Sheet: Pipeline');
    expect(result.text).toContain('Acme,42');
  });

  it('extracts readable text from a PDF fixture', async () => {
    const fixture = fs.readFileSync(path.resolve(
      process.cwd(),
      'tests/fixtures/outreach_attachment.pdf',
    ));
    const original = Buffer.from(fixture);
    const result = await extractAttachmentText(fixture, 'application/pdf', 'example.pdf');
    expect(result).toMatchObject({ status: 'success' });
    expect(result.text).toContain('This PDF fixture verifies outreach attachment text extraction.');
    expect(fixture).toEqual(original);
    expect(await extractAttachmentText(fixture, 'application/pdf', 'example.pdf')).toEqual(result);
  });

  it('does not infer image details when approved vision extraction is disabled', async () => {
    delete process.env.ATTACHMENT_VISION_EXTRACTION_ENABLED;
    const result = await extractAttachmentText(Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg', 'photo.jpg');
    expect(result).toEqual({
      status: 'unsupported',
      error: 'Image content extraction is disabled; no file details were inferred.',
    });
  });
});
