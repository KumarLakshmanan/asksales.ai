import { db } from '../../models/db.js';
import { sql } from 'drizzle-orm';
import { logger } from '../../utils/logger.js';
import { KnowledgeBaseModel } from '../../models/knowledgeBase/functions.js';
import { knowledgeBaseService } from '../KnowledgeBaseService.js';

export class HotelRagSyncService {
  private static instance: HotelRagSyncService;

  static getInstance(): HotelRagSyncService {
    if (!this.instance) this.instance = new HotelRagSyncService();
    return this.instance;
  }

  async syncRoomTypeToRag(userId: number, roomTypeId: number): Promise<void> {
    try {
      // 1. Fetch room type and hotel details
      const roomTypeResult = await db.execute(sql`
        SELECT rt.*, hp.currency AS currency
        FROM room_types rt
        JOIN hotel_properties hp ON hp.id = rt.hotel_id
        WHERE rt.id = ${roomTypeId} AND hp.user_id = ${userId}
        LIMIT 1
      `);
      
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rt = (roomTypeResult.rows as any[])[0];
      if (!rt) {
        logger.warn({ userId, roomTypeId }, '[HotelRagSyncService] Room type not found for syncing');
        return;
      }

      const roomTypeName = rt.name;
      const description = rt.description || '';
      const capacity = Number(rt.capacity || 1);
      const basePrice = Number(rt.base_price || 0);
      const minPrice = Number(rt.min_price || 0);
      const maxDiscountPct = Number(rt.max_discount_pct || 0);
      const currency = rt.currency || 'INR';
      const amenities = Array.isArray(rt.amenities) ? rt.amenities : [];

      const sourceUrl = `hotel_room_type://${roomTypeId}`;
      const title = `Room Type: ${roomTypeName}`;
      const kbDescription = `Amenities, capacity, and rates for ${roomTypeName}.`;
      
      const content = `Room Type: ${roomTypeName}
Description: ${description || 'No description available'}
Capacity: Up to ${capacity} guest(s)
Base Price: ${basePrice} ${currency} per night
Minimum Price: ${minPrice} ${currency} per night
Maximum Discount: ${maxDiscountPct}%
Amenities: ${amenities.length > 0 ? amenities.join(', ') : 'None specified'}`;

      // 2. Check if a KB entry already exists for this room type
      let kbEntry = await KnowledgeBaseModel.findBySourceUrl(userId, sourceUrl);
      
      if (kbEntry) {
        // Update existing KB entry
        await KnowledgeBaseModel.update(kbEntry.id, userId, {
          title,
          description: kbDescription,
          content,
          type: 'document',
        });
        logger.info({ userId, roomTypeId, kbEntryId: kbEntry.id }, '[HotelRagSyncService] Updated room type knowledge base entry');
      } else {
        // Create new KB entry
        kbEntry = await KnowledgeBaseModel.create({
          userId,
          title,
          description: kbDescription,
          content,
          type: 'document',
          processingStatus: 'completed',
          sourceUrl,
        });
        logger.info({ userId, roomTypeId, kbEntryId: kbEntry.id }, '[HotelRagSyncService] Created room type knowledge base entry');
      }

      // 3. Index it in the vector DB (generates and stores embeddings)
      await knowledgeBaseService.indexEntry(userId, kbEntry.id, content);
      
      logger.info({ userId, roomTypeId }, '[HotelRagSyncService] Successfully synced room type to vector database (RAG)');
    } catch (err) {
      logger.error({ err, userId, roomTypeId }, '[HotelRagSyncService] Failed to sync room type to RAG');
    }
  }

  async deleteRoomTypeFromRag(userId: number, roomTypeId: number): Promise<void> {
    try {
      const sourceUrl = `hotel_room_type://${roomTypeId}`;
      const kbEntry = await KnowledgeBaseModel.findBySourceUrl(userId, sourceUrl);
      if (kbEntry) {
        await knowledgeBaseService.removeEntryEmbeddings(userId, kbEntry.id);
        await KnowledgeBaseModel.delete(kbEntry.id, userId);
        logger.info({ userId, roomTypeId }, '[HotelRagSyncService] Deleted room type knowledge base entry and embeddings');
      }
    } catch (err) {
      logger.error({ err, userId, roomTypeId }, '[HotelRagSyncService] Failed to delete room type from RAG');
    }
  }
}

export const hotelRagSyncService = HotelRagSyncService.getInstance();
