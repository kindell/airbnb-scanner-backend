/**
 * Real-time Booking Stream API
 * ============================
 * 
 * Server-Sent Events endpoint for live booking updates during scanning.
 */

import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../database/client';
import { bookingUpdateEmitter } from '../utils/booking-update-emitter';

const router = Router();

/**
 * Real-time booking updates stream
 * GET /api/bookings/stream?token=jwt_token
 */
router.get('/stream', async (req, res) => {
  try {
    // Verify JWT token from query parameter
    const { token } = req.query;
    console.log('🔍 Token received in booking-stream:', { token, query: req.query });
    if (!token || typeof token !== 'string') {
      console.log('❌ No token provided in booking-stream');
      return res.status(401).json({ error: 'Access denied. No token provided.' });
    }

    let userId: number;
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
      userId = parseInt(decoded.userId) || parseInt(decoded.sub);
      console.log('📡 SSE JWT decoded:', { decoded, userId });
    } catch (err) {
      return res.status(403).json({ error: 'Invalid token.' });
    }

    // Set up Server-Sent Events
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Cache-Control'
    });

    console.log(`🔗 SSE booking stream connected for user ${userId}`);

    // Send initial booking list
    try {
      const bookings = await prisma.booking.findMany({
        where: { userId, status: { not: 'private' } },
        include: {
          emailLinks: true,
          payouts: {
            include: { payout: true }
          }
        },
        orderBy: { checkInDate: 'desc' },
        take: 100 // Limit initial load
      });

      res.write(`data: ${JSON.stringify({
        type: 'initial_bookings',
        bookings: bookings.map(booking => ({
          ...booking,
          hasPayouts: booking.payouts.length > 0,
          emailCount: booking.emailLinks.length
        })),
        count: bookings.length,
        timestamp: new Date().toISOString()
      })}\n\n`);

      console.log(`📊 Sent initial ${bookings.length} bookings to user ${userId}`);
    } catch (error) {
      console.error('❌ Error fetching initial bookings:', error);
      res.write(`data: ${JSON.stringify({
        type: 'error',
        message: 'Failed to fetch initial bookings'
      })}\n\n`);
    }

    // Track last seen event to avoid duplicates
    let lastSeenEventId = 0;
    
    // Get initial last event ID
    try {
      const latestEvent = await prisma.bookingUpdateEvent.findFirst({
        where: { userId },
        orderBy: { id: 'desc' }
      });
      if (latestEvent) {
        lastSeenEventId = latestEvent.id;
      }
    } catch (error) {
      console.error('❌ Error getting latest event ID:', error);
    }

    // Poll for new booking updates (database-based)
    const pollForUpdates = async () => {
      try {
        const newEvents = await prisma.bookingUpdateEvent.findMany({
          where: {
            userId,
            id: { gt: lastSeenEventId }
          },
          include: {
            booking: {
              include: {
                emailLinks: true,
                payouts: {
                  include: { payout: true }
                }
              }
            }
          },
          orderBy: { id: 'asc' },
          take: 10 // Limit to prevent overwhelming
        });

        if (newEvents.length > 0) {
          for (const event of newEvents) {
            if (event.booking) {
              const enrichedBooking = {
                ...event.booking,
                hasPayouts: event.booking.payouts.length > 0,
                emailCount: event.booking.emailLinks.length
              };

              const eventData = {
                type: event.eventType,
                booking: enrichedBooking,
                changes: event.changes ? JSON.parse(event.changes) : undefined,
                timestamp: event.createdAt.toISOString()
              };

              res.write(`data: ${JSON.stringify(eventData)}\n\n`);
              console.log(`📡 Sent ${event.eventType} update for booking ${event.bookingId} to user ${userId} (from DB)`);
            }
            
            lastSeenEventId = Math.max(lastSeenEventId, event.id);
          }
        }
      } catch (error) {
        console.error('❌ Error polling for booking updates:', error);
      }
    };

    // Initial poll after short delay
    setTimeout(pollForUpdates, 1000);
    
    // Poll every 2 seconds for new events
    const pollInterval = setInterval(pollForUpdates, 2000);

    // Listen for booking updates
    const handleBookingUpdate = async (eventData: any) => {
      if (eventData.userId === userId) {
        try {
          // Get full booking data with relations
          const fullBooking = await prisma.booking.findUnique({
            where: { id: eventData.bookingId },
            include: {
              emailLinks: true,
              payouts: {
                include: { payout: true }
              }
            }
          });

          if (fullBooking) {
            const enrichedBooking = {
              ...fullBooking,
              hasPayouts: fullBooking.payouts.length > 0,
              emailCount: fullBooking.emailLinks.length
            };

            res.write(`data: ${JSON.stringify({
              type: eventData.eventType,
              booking: enrichedBooking,
              changes: eventData.changes,
              timestamp: eventData.timestamp || new Date().toISOString()
            })}\n\n`);

            console.log(`📡 Sent ${eventData.eventType} update for booking ${eventData.bookingId} to user ${userId}`);
          }
        } catch (error) {
          console.error('❌ Error sending booking update:', error);
        }
      }
    };

    // Subscribe to booking updates
    bookingUpdateEmitter.on('booking_update', handleBookingUpdate);

    // Handle client disconnect
    const cleanup = () => {
      clearInterval(pollInterval);
      bookingUpdateEmitter.off('booking_update', handleBookingUpdate);
      console.log(`🔌 SSE booking stream disconnected for user ${userId}`);
    };

    req.on('close', cleanup);
    req.on('error', cleanup);

    // Keep connection alive with heartbeat
    const heartbeat = setInterval(() => {
      res.write(`data: ${JSON.stringify({
        type: 'heartbeat',
        timestamp: new Date().toISOString()
      })}\n\n`);
    }, 30000); // Every 30 seconds

    req.on('close', () => {
      clearInterval(heartbeat);
      cleanup();
    });

  } catch (error) {
    console.error('❌ Error in booking stream:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Get session status for persistent progress
 * GET /api/bookings/session-status/:userId
 */
router.get('/session-status/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    
    // Check for active scanning session
    const activeSession = await prisma.scanningSession.findFirst({
      where: {
        userId,
        status: { in: ['running', 'queued'] },
        completedAt: null
      },
      orderBy: { startedAt: 'desc' }
    });

    if (activeSession) {
      res.json({
        isScanning: true,
        sessionId: activeSession.id,
        status: activeSession.status,
        year: activeSession.year,
        currentEmailIndex: activeSession.currentEmailIndex || 0,
        totalEmails: activeSession.totalEmails || 0,
        processedEmails: activeSession.processedEmails || 0,
        skippedEmails: activeSession.skippedEmails || 0,
        errorEmails: activeSession.errorEmails || 0,
        currentMessage: activeSession.currentMessage,
        currentStep: activeSession.currentStep,
        currentBookingCode: activeSession.currentBookingCode,
        currentGuestName: activeSession.currentGuestName,
        // Enhanced progress message for reload
        progressMessage: activeSession.currentBookingCode 
          ? `✅ Bearbetade booking ${activeSession.currentBookingCode}${activeSession.currentGuestName ? ` - ${activeSession.currentGuestName}` : ''} (${(activeSession.processedEmails || 0) + (activeSession.skippedEmails || 0) + (activeSession.errorEmails || 0)}/${activeSession.totalEmails || 0})`
          : activeSession.currentMessage || `🔄 Återansluter till pågående scanning (år ${activeSession.year})...`,
        bookingsFound: activeSession.bookingsFound || 0,
        bookingsUpdated: activeSession.bookingsUpdated || 0,
        lastUpdateAt: activeSession.lastUpdateAt,
        estimatedTimeLeft: activeSession.estimatedTimeLeft,
        // Add progress summary for frontend
        progress: {
          current: (activeSession.processedEmails || 0) + (activeSession.skippedEmails || 0) + (activeSession.errorEmails || 0),
          total: activeSession.totalEmails || 0,
          processed: activeSession.processedEmails || 0,
          skipped: activeSession.skippedEmails || 0,
          errors: activeSession.errorEmails || 0
        }
      });
    } else {
      res.json({ isScanning: false });
    }

  } catch (error) {
    console.error('❌ Error checking session status:', error);
    res.status(500).json({ error: 'Failed to check session status' });
  }
});

/**
 * Get recent booking updates history
 * GET /api/bookings/recent-updates
 */
router.get('/recent-updates', async (req: any, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const limit = parseInt(req.query.limit as string) || 20;
    
    const updates = await bookingUpdateEmitter.getRecentUpdates(userId, limit);
    
    res.json({
      updates,
      count: updates.length
    });

  } catch (error) {
    console.error('❌ Error fetching recent updates:', error);
    res.status(500).json({ error: 'Failed to fetch recent updates' });
  }
});

export default router;