import { expect, it } from 'vitest';
import { savedContentAssetId, requireAttachedMediaReceipt, attachedVideoOutcome } from '@/lib/content-asset-identity';
it.each(['db-123', '123'])('preserves the saved numeric identity from %s', value => {
  expect(savedContentAssetId(value)).toBe(123);
});
it('distinguishes persisted video output from a persisted pending operation', () => {
  const receipt = { success: true, persisted: true, assetId: 123 };
  expect(attachedVideoOutcome({ ...receipt, videoUrl: '/uploads/video.mp4' }, 123)).toBe('saved');
  expect(attachedVideoOutcome({ ...receipt, operationName: 'operations/123' }, 123)).toBe('queued');
  expect(() => attachedVideoOutcome(receipt, 123)).toThrow('No saved video');
  expect(() => attachedVideoOutcome({ ...receipt, persisted: false, operationName: 'operations/123' }, 123)).toThrow();
  expect(() => attachedVideoOutcome({ ...receipt, assetId: 999, videoUrl: '/uploads/video.mp4' }, 123)).toThrow();
});
it.each(['manual-123', 'db-0', '12oops', '1e3', '9007199254740992', ''])('rejects unsaved or malformed identity %s', value => {
  expect(() => savedContentAssetId(value)).toThrow('Save the content');
});
it('requires attachment persistence on the exact parent asset', () => {
  expect(() => requireAttachedMediaReceipt({ persisted: true, assetId: 123 }, 123)).not.toThrow();
  expect(() => requireAttachedMediaReceipt({ persisted: false, assetId: 123 }, 123)).toThrow();
  expect(() => requireAttachedMediaReceipt({ persisted: true, assetId: 999 }, 123)).toThrow();
  expect(() => requireAttachedMediaReceipt({}, 123)).toThrow();
});
