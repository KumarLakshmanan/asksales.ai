import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { logger } from '../../utils/logger.js';
import { bookingService } from '../../services/booking/BookingService.js';
import { getAvailabilityProvider } from '../../services/booking/AvailabilityProvider.js';

// Schema for tool output
const toolResultSchema = z.object({
  success: z.boolean(),
  toolName: z.string(),
  output: z.any().optional(),
  error: z.string().optional(),
});

export const checkRoomAvailabilityTool = createTool({
  id: 'check_room_availability',
  description: 'Check hotel room availability and pricing for a specific date range and number of guests. Returns list of available room types, pricing per night, total pricing, and maximum guest capacity.',
  inputSchema: z.object({
    startDate: z.string().describe('Check-in date in YYYY-MM-DD format (e.g. 2026-06-25)'),
    endDate: z.string().describe('Check-out date in YYYY-MM-DD format (e.g. 2026-06-28)'),
    guests: z.number().describe('Number of guests staying in the room'),
  }),
  outputSchema: toolResultSchema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: async ({ startDate, endDate, guests }, { mastra }: any) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const context = (mastra as any)?.__toolContext;
      const userId = context?.userId;
      if (!userId) {
        return { success: false, toolName: 'check_room_availability', error: 'No userId found in context' };
      }

      const availableRoomTypes = await getAvailabilityProvider().searchAvailability({
        userId,
        checkIn: startDate,
        checkOut: endDate,
        guests,
        rooms: 1,
      });

      return {
        success: true,
        toolName: 'check_room_availability',
        output: {
          available: availableRoomTypes.length > 0,
          rooms: availableRoomTypes.map((room) => ({
            roomTypeId: room.roomTypeId,
            name: room.name,
            capacity: room.capacity,
            pricePerNight: room.pricePerNight,
            totalPrice: room.totalPrice,
            nights: room.nights,
            availableCount: room.availableCount,
            currency: room.currency,
            amenities: room.amenities,
          })),
          nights: availableRoomTypes[0]?.nights || 0,
        },
      };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error('[hotelTools] checkRoomAvailability error:', error);
      return { success: false, toolName: 'check_room_availability', error: error.message };
    }
  },
});

export const bookRoomTool = createTool({
  id: 'book_room',
  description: 'Book a room for a guest. Creates a pending booking and returns a payment link for the customer. Requires roomTypeId, guestName, guestEmail (optional), check-in date, check-out date, and totalPrice.',
  inputSchema: z.object({
    roomTypeId: z.number().describe('The ID of the room type to book'),
    guestName: z.string().describe('First and last name of the primary guest'),
    guestEmail: z.string().optional().describe('Email address of the guest'),
    startDate: z.string().describe('Check-in date in YYYY-MM-DD format (e.g. 2026-06-25)'),
    endDate: z.string().describe('Check-out date in YYYY-MM-DD format (e.g. 2026-06-28)'),
    totalPrice: z.number().describe('The quoted total price for the entire stay'),
    guests: z.number().optional().describe('Number of guests (default 1)'),
    rooms: z.number().optional().describe('Number of rooms to book (default 1)'),
  }),
  outputSchema: toolResultSchema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: async ({ roomTypeId, guestName, guestEmail, startDate, endDate, totalPrice, guests = 1, rooms = 1 }, { mastra }: any) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const context = (mastra as any)?.__toolContext;
      const userId = context?.userId;
      if (!userId) {
        return { success: false, toolName: 'book_room', error: 'No userId found in context' };
      }

      const res = await bookingService.createBooking({
        userId,
        conversationId: context?.threadId,
        roomTypeId,
        guestName,
        guestEmail: guestEmail || null,
        guestPhone: null,
        checkIn: startDate,
        checkOut: endDate,
        guests,
        rooms,
        agreedTotalPrice: totalPrice,
      });

      if ('error' in res) {
        return { success: false, toolName: 'book_room', error: res.error };
      }

      return {
        success: true,
        toolName: 'book_room',
        output: {
          bookingId: res.booking.id,
          status: res.booking.status,
          totalPrice: res.booking.totalPrice,
          currency: res.booking.currency,
          paymentLink: res.paymentUrl,
          message: `Booking created in pending_payment status (Booking ID: ${res.booking.id}). Share the payment link with the guest to confirm.`,
        },
      };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error('[hotelTools] bookRoom error:', error);
      return { success: false, toolName: 'book_room', error: error.message };
    }
  },
});
