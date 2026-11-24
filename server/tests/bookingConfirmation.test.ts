import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// ── Mocks ──────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockDbExecute = jest.fn<any>();
jest.unstable_mockModule('../models/db.js', () => ({
  db: {
    execute: mockDbExecute,
  },
}));

jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockConfirmBookingById = jest.fn<any>();
const mockCancelBookingById = jest.fn<any>();
const mockClaimConfirmationNotification = jest.fn<any>();
const mockCompleteConfirmationNotification = jest.fn<any>();
jest.unstable_mockModule('../services/booking/BookingService.js', () => ({
  BookingLifecycleError: class BookingLifecycleError extends Error {
    statusCode = 409;
  },
  bookingService: {
    getConfirmationRecovery: jest.fn<() => Promise<{ state: 'complete'; canRetry: boolean }>>().mockResolvedValue({ state: 'complete', canRetry: false }),
    confirmBookingById: mockConfirmBookingById,
    cancelBookingById: mockCancelBookingById,
    claimConfirmationNotification: mockClaimConfirmationNotification,
    completeConfirmationNotification: mockCompleteConfirmationNotification,
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockWhatsappSendText = jest.fn<any>();
jest.unstable_mockModule('../services/whatsappApiService.js', () => ({
  whatsappApiService: {
    sendText: mockWhatsappSendText,
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockSendInstagramDM = jest.fn<any>();
jest.unstable_mockModule('../services/instagramService.js', () => ({
  sendInstagramDM: mockSendInstagramDM,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockSendFacebookDM = jest.fn<any>();
jest.unstable_mockModule('../services/FacebookMessengerService.js', () => ({
  sendFacebookDM: mockSendFacebookDM,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockSendSMS = jest.fn<any>();
jest.unstable_mockModule('../services/smsService.js', () => ({
  sendSMS: mockSendSMS,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockSendEmailWithUserCredentials = jest.fn<any>();
jest.unstable_mockModule('../services/emailService.js', () => ({
  emailService: {
    sendEmailWithUserCredentials: mockSendEmailWithUserCredentials,
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockSendTwitterDM = jest.fn<any>();
jest.unstable_mockModule('../services/TwitterApiService.js', () => ({
  sendTwitterDM: mockSendTwitterDM,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockSendLinkedInDM = jest.fn<any>();
jest.unstable_mockModule('../services/LinkedInApiService.js', () => ({
  sendLinkedInDM: mockSendLinkedInDM,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCreateOutreachMessage = jest.fn<any>();
jest.unstable_mockModule('../models/outreachConversations/functions.js', () => ({
  createOutreachMessage: mockCreateOutreachMessage,
}));

// Import target controller after mocking
const { cancelBooking, manuallyConfirmBooking } = await import('../controllers/bookingPaymentController.js');

describe('Booking Confirmation Notifications', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockClaimConfirmationNotification.mockResolvedValue(true);
    mockCompleteConfirmationNotification.mockResolvedValue(undefined);
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const runConfirmation = async (channel: string, conversationData: any = {}) => {
    const mockBooking = {
      id: 123,
      status: 'confirmed',
      paymentStatus: 'paid',
      totalPrice: 5000,
      currency: 'INR',
      checkIn: '2026-06-25',
      checkOut: '2026-06-28',
      nights: 3,
      rooms: 1,
      roomTypeId: 1,
    };
    mockConfirmBookingById.mockResolvedValue(mockBooking);

    mockDbExecute.mockResolvedValue({
      rows: [
        {
          user_id: 1,
          total_price: 5000,
          currency: 'INR',
          check_in_date: '2026-06-25T00:00:00.000Z',
          check_out_date: '2026-06-28T00:00:00.000Z',
          number_of_rooms: 1,
          conversation_id: 456,
          channel,
          phone: '919999999999',
          lead_email: 'guest@example.com',
          lead_instagram: 'guest_ig',
          phone_number_id: 'waba_id_123',
          hotel_name: 'Grand Palace',
          locale: 'en-IN',
          ...conversationData,
        },
      ],
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req: any = { params: { id: '123' }, user: { id: 1 } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      status: jest.fn<any>().mockReturnThis(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      json: jest.fn<any>().mockReturnThis(),
    };

    await manuallyConfirmBooking(req, res);
    return res;
  };

  it('should confirm booking and send WhatsApp confirmation', async () => {
    mockWhatsappSendText.mockResolvedValue({ messages: [{ id: 'wa_msg_123' }] });
    const res = await runConfirmation('whatsapp');

    expect(mockConfirmBookingById).toHaveBeenCalledWith(123, 1, 'manual_dashboard', undefined);
    expect(mockWhatsappSendText).toHaveBeenCalledWith({
      userId: 1,
      phoneNumberId: 'waba_id_123',
      to: '919999999999',
      text: expect.stringContaining('confirmed'),
    });
    expect(mockCreateOutreachMessage).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ success: true, bookingId: 123, status: 'confirmed', confirmationRecovery: { state: 'complete', canRetry: false } });
  });

  it('should confirm booking and send Instagram DM', async () => {
    mockSendInstagramDM.mockResolvedValue({ success: true });
    await runConfirmation('instagram');

    expect(mockSendInstagramDM).toHaveBeenCalledWith({
      recipientId: 'guest_ig',
      message: expect.stringContaining('confirmed'),
      userId: 1,
      conversationId: 456,
    });
  });

  it('should confirm booking and send Facebook DM', async () => {
    mockSendFacebookDM.mockResolvedValue({ success: true });
    await runConfirmation('facebook');

    expect(mockSendFacebookDM).toHaveBeenCalledWith({
      conversationId: 456,
      recipientId: '919999999999',
      message: expect.stringContaining('confirmed'),
      userId: 1,
    });
  });

  it('should confirm booking and send SMS', async () => {
    mockSendSMS.mockResolvedValue({ success: true });
    await runConfirmation('sms');

    expect(mockSendSMS).toHaveBeenCalledWith(1, '919999999999', expect.stringContaining('confirmed'));
  });

  it('should confirm booking and send Email', async () => {
    mockSendEmailWithUserCredentials.mockResolvedValue({ success: true });
    await runConfirmation('email');

    expect(mockSendEmailWithUserCredentials).toHaveBeenCalledWith(1, expect.objectContaining({
      to: 'guest@example.com',
      subject: expect.stringContaining('booking confirmed'),
      text: expect.stringContaining('confirmed'),
      skipConversationLog: true,
    }));
  });

  it('should confirm booking and send Gmail', async () => {
    mockSendEmailWithUserCredentials.mockResolvedValue({ success: true });
    await runConfirmation('gmail');

    expect(mockSendEmailWithUserCredentials).toHaveBeenCalledWith(1, expect.objectContaining({
      to: 'guest@example.com',
      subject: expect.stringContaining('booking confirmed'),
      text: expect.stringContaining('confirmed'),
      skipConversationLog: true,
    }));
  });

  it('should confirm booking and send Twitter DM', async () => {
    mockSendTwitterDM.mockResolvedValue({ success: true });
    await runConfirmation('twitter', { metadata: { twitterId: 'tw_user_123' } });

    expect(mockSendTwitterDM).toHaveBeenCalledWith({
      recipientId: '919999999999',
      message: expect.stringContaining('confirmed'),
      userId: 1,
    });
  });

  it('should confirm booking and send LinkedIn DM', async () => {
    mockSendLinkedInDM.mockResolvedValue({ success: true });
    await runConfirmation('linkedin', { metadata: { linkedinUrn: 'li_user_123' } });

    expect(mockSendLinkedInDM).toHaveBeenCalledWith({
      recipientUrn: '919999999999',
      message: expect.stringContaining('confirmed'),
      userId: 1,
    });
  });

  it('does not send a duplicate confirmation when another worker owns the notification claim', async () => {
    mockClaimConfirmationNotification.mockResolvedValue(false);
    const res = await runConfirmation('whatsapp');

    expect(mockWhatsappSendText).not.toHaveBeenCalled();
    expect(mockCreateOutreachMessage).not.toHaveBeenCalled();
    expect(mockCompleteConfirmationNotification).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ success: true, bookingId: 123, status: 'confirmed', confirmationRecovery: { state: 'complete', canRetry: false } });
  });

  it('scopes cancellation to the authenticated owner and returns the refund state', async () => {
    mockCancelBookingById.mockResolvedValue({
      id: 123,
      status: 'cancelled',
      paymentStatus: 'refund_pending',
    });
    const req = {
      params: { id: '123' },
      body: { reason: 'Guest requested cancellation' },
      user: { id: 77 },
    };
    const res = {
      status: jest.fn<any>().mockReturnThis(),
      json: jest.fn<any>().mockReturnThis(),
    };

    await cancelBooking(req as never, res as never);

    expect(mockCancelBookingById).toHaveBeenCalledWith(123, 77, 'Guest requested cancellation');
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      bookingId: 123,
      status: 'cancelled',
      paymentStatus: 'refund_pending',
    });
  });

  it('rejects cancellation without an authenticated owner', async () => {
    const req = {
      params: { id: '123' },
      body: { reason: 'Guest requested cancellation' },
    };
    const res = {
      status: jest.fn<any>().mockReturnThis(),
      json: jest.fn<any>().mockReturnThis(),
    };

    await cancelBooking(req as never, res as never);

    expect(mockCancelBookingById).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
