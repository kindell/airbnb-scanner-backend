/**
 * Booking Update Emitter
 * ======================
 * 
 * Central event emitter for real-time booking updates.
 * Handles creation, updates, and real-time notifications.
 */

import { EventEmitter } from 'events';
import { prisma } from '../database/client';

export interface BookingUpdateData {
  userId: number;
  sessionId?: number | null;
  bookingId: number;
  booking?: any; // Full booking object
  eventType: 'created' | 'updated' | 'enriched';
  changes?: Record<string, { old: any; new: any }>;
  timestamp: Date;
}

class BookingUpdateEmitter extends EventEmitter {
  
  /**
   * Emit booking update and save to database
   */
  async emitBookingUpdate(data: BookingUpdateData): Promise<void> {
    try {
      // Save event to database for persistence
      await prisma.bookingUpdateEvent.create({
        data: {
          userId: data.userId,
          sessionId: data.sessionId,
          bookingId: data.bookingId,
          eventType: data.eventType,
          changes: data.changes ? JSON.stringify(data.changes) : null,
          createdAt: data.timestamp
        }
      });
      
      // Emit real-time event
      this.emit('booking_update', data);
      
      console.log(`📡 Emitted ${data.eventType} event for booking ${data.bookingId} (user ${data.userId})`);
      
    } catch (error) {
      console.error('❌ Failed to emit booking update:', error);
    }
  }
  
  /**
   * Emit booking creation event
   */
  async emitBookingCreated(userId: number, booking: any, sessionId?: number): Promise<void> {
    await this.emitBookingUpdate({
      userId,
      sessionId,
      bookingId: booking.id,
      booking,
      eventType: 'created',
      timestamp: new Date()
    });
  }
  
  /**
   * Emit booking update event with changes
   */
  async emitBookingUpdated(
    userId: number, 
    booking: any, 
    changes: Record<string, { old: any; new: any }>, 
    sessionId?: number
  ): Promise<void> {
    await this.emitBookingUpdate({
      userId,
      sessionId,
      bookingId: booking.id,
      booking,
      eventType: 'updated',
      changes,
      timestamp: new Date()
    });
  }
  
  /**
   * Emit booking enrichment event
   */
  async emitBookingEnriched(userId: number, booking: any, sessionId?: number): Promise<void> {
    await this.emitBookingUpdate({
      userId,
      sessionId,
      bookingId: booking.id,
      booking,
      eventType: 'enriched',
      timestamp: new Date()
    });
  }
  
  /**
   * Get recent booking updates for a user
   */
  async getRecentUpdates(userId: number, limit: number = 50): Promise<BookingUpdateData[]> {
    const updates = await prisma.bookingUpdateEvent.findMany({
      where: { userId },
      include: { booking: true },
      orderBy: { createdAt: 'desc' },
      take: limit
    });
    
    return updates.map(update => ({
      userId: update.userId,
      sessionId: update.sessionId || undefined,
      bookingId: update.bookingId,
      booking: update.booking,
      eventType: update.eventType as 'created' | 'updated' | 'enriched',
      changes: update.changes ? JSON.parse(update.changes) : undefined,
      timestamp: update.createdAt
    }));
  }
  
  /**
   * Clean up old events (run periodically)
   */
  async cleanupOldEvents(daysToKeep: number = 30): Promise<void> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
    
    const { count } = await prisma.bookingUpdateEvent.deleteMany({
      where: {
        createdAt: { lt: cutoffDate }
      }
    });
    
    if (count > 0) {
      console.log(`🧹 Cleaned up ${count} old booking update events`);
    }
  }
}

// Singleton instance
export const bookingUpdateEmitter = new BookingUpdateEmitter();

// Auto-cleanup old events daily
if (process.env.NODE_ENV === 'production') {
  setInterval(() => {
    bookingUpdateEmitter.cleanupOldEvents().catch(console.error);
  }, 24 * 60 * 60 * 1000); // Every 24 hours
}