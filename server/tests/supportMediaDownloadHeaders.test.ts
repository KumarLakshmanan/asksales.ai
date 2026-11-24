import { describe, expect, it, jest } from '@jest/globals';
import { validateHeaderValue } from 'node:http';
import { contentDisposition } from '../utils/contentDisposition.js';

const download = jest.fn<any>(async () => ({ buffer: Buffer.from('fixture') }));
const asset = { derivative_storage_file_id: 934, mime_type: 'image/jpeg', name: 'Color chart — தமிழ் 🟦' };
jest.unstable_mockModule('../services/StorageService.js', () => ({ storageService: { downloadFile: download } }));
jest.unstable_mockModule('../services/supportMedia/SupportMediaGalleryService.js', () => ({ supportMediaGalleryService: {} }));
jest.unstable_mockModule('../services/supportMedia/SupportMediaTenantTransaction.js', () => ({
  withTenantSupportMediaTransaction: async (_user: number, work: any) => work({ execute: async () => ({ rows: [asset] }) }),
}));
const { downloadSupportMediaAsset } = await import('../controllers/supportMediaGalleryController.js');

describe('international support download names', () => {
  it.each(['Color chart — தமிழ் 🟦.jpg', 'résumé.pdf', 'x"\r\nInjected: yes\\a/b.jpg', '\uD800.jpg', '', "café (owner's copy).jpg"])(
    'emits a valid HTTP header for %p', (name) => {
      const header = contentDisposition(name);
      expect(() => validateHeaderValue('Content-Disposition', header)).not.toThrow();
      expect(header).not.toMatch(/[\r\n]/);
      expect(header).toContain("filename*=UTF-8''");
    },
  );
  it('preserves Unicode in the RFC 5987 filename', () => {
    expect(decodeURIComponent(contentDisposition('தமிழ் 🟦.jpg').split("UTF-8''")[1])).toBe('தமிழ் 🟦.jpg');
    expect(contentDisposition('résumé.pdf', 'attachment')).toMatch(/^attachment;/);
  });
  it('serves the owner preview with a Unicode name through the actual controller', async () => {
    const headers: Record<string, string> = {};
    const res: any = { setHeader: (name: string, value: string) => {
      validateHeaderValue(name, value); headers[name] = value;
    }, send: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() };
    await downloadSupportMediaAsset({ user: { id: 1 }, params: { assetId: '1' } } as any, res);
    expect(res.send).toHaveBeenCalledWith(Buffer.from('fixture'));
    expect(res.status).not.toHaveBeenCalled();
    expect(headers['Content-Disposition']).toContain("filename*=UTF-8''");
    expect(download).toHaveBeenCalledWith(934, 1);
  });
});
