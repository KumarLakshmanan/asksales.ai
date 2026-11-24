import { describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('../models/db.js', () => ({ db: { execute: jest.fn() } }));
const { isAutoReplyLoop } = await import('../services/outreach/AutoReplyLoopGuard.js');

const now = new Date('2026-11-19T03:51:30.000Z');
const at = (secondsAgo: number) => new Date(now.getTime() - secondsAgo * 1000).toISOString();
const ai = (secondsAgo: number) => ({ direction: 'outbound', isAiGenerated: true, at: at(secondsAgo) });
const staff = (secondsAgo: number) => ({ direction: 'outbound', isAiGenerated: false, at: at(secondsAgo) });
const them = (secondsAgo: number) => ({ direction: 'inbound', isAiGenerated: false, at: at(secondsAgo) });

describe('automatic reply loop guard', () => {
  it('stops when an autoresponder has answered two automatic replies within seconds (the micro1 bot loop)', () => {
    expect(isAutoReplyLoop([them(0), ai(20), them(75), ai(80), them(140)], now)).toBe(true);
  });

  it('allows the first exchange with an autoresponder', () => {
    expect(isAutoReplyLoop([them(0), ai(20), them(140)], now)).toBe(false);
    expect(isAutoReplyLoop([], now)).toBe(false);
  });

  it('never holds an ordinary conversation where the customer takes minutes to answer', () => {
    // Three AI replies in 15 minutes, each answered by a person a few minutes later.
    expect(isAutoReplyLoop([them(0), ai(360), them(400), ai(660), them(700), ai(960), them(1000)], now)).toBe(false);
  });

  it('never holds a customer who sends several messages in a row', () => {
    expect(isAutoReplyLoop([them(0), them(10), them(20), ai(400), them(600)], now)).toBe(false);
  });

  it('resets when a person on our side wrote more recently', () => {
    expect(isAutoReplyLoop([them(0), ai(10), staff(20), them(75), ai(80), them(140)], now)).toBe(false);
  });

  it('ignores exchanges older than the window', () => {
    expect(isAutoReplyLoop([them(0), ai(20), them(45 * 60), ai(45 * 60 + 10)], now)).toBe(false);
  });
});
