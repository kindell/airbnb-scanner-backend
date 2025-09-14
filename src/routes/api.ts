import express from 'express';
import jwt from 'jsonwebtoken';
import { authenticateJWT } from '../middleware/auth';
import { prisma } from '../database/client';
import { MLEmailParser } from '../parsers/MLEmailParser';
import { GmailClient } from '../utils/gmail-client';
import { EmailHeaders } from '../types';
import { decodeGmailContent, decodeGmailContentForML } from '../utils/email-decoder';
import { EmailLinkManager } from '../utils/email-link-manager';
import { BookingDataMerger } from '../utils/booking-data-merger';
import { bookingUpdateEmitter } from '../utils/booking-update-emitter';
import { wsManager } from '../services/websocket-manager';
import { sessionManager } from '../utils/persistent-session-manager';

const router = express.Router();

// Global scanning status tracker
const scanningStatus = new Map<number, {
  isScanning: boolean;
  year?: number;
  startTime?: Date;
  lastMessage?: string;
  currentStatus?: string; // 'starting', 'searching', 'processing', 'completed', 'error'
  totalEmails?: number;
  progress?: {
    current: number;
    total: number;
    processed: number;
    skipped: number;
    errors: number;
  };
}>();

// Global stream connections tracker for broadcasting updates
const activeStreamConnections = new Map<number, Array<(data: any) => void>>();

// Helper function to broadcast updates to all active stream connections for a user
const broadcastToStreams = (userId: number, data: any) => {
  // Legacy EventSource connections (keep for compatibility during migration)
  const connections = activeStreamConnections.get(userId);
  if (connections && connections.length > 0) {
    console.log(`📡 Broadcasting to ${connections.length} EventSource connection(s) for user ${userId}:`, data);
    connections.forEach(sendUpdate => {
      try {
        sendUpdate(data);
      } catch (error) {
        console.error('Error broadcasting to EventSource:', error);
      }
    });
  }
  
  // New WebSocket broadcasting
  if (wsManager) {
    console.log(`📡 Broadcasting to WebSocket clients for user ${userId}:`, data.status || data.type);
    wsManager.broadcastScanProgress(userId, data);
  }
};

/**
 * GET /api/process-emails/stream
 * Stream real-time progress of email processing (no middleware auth, handles JWT manually)
 */
router.get('/process-emails/stream/:year/:quarter', async (req: any, res: any) => {
  const { year, quarter } = req.params;
  const { token } = req.query;
  
  // Verify JWT token from query parameter since EventSource can't send headers
  let userId;
  try {
    if (!token) {
      throw new Error('No token provided');
    }
    console.log('🔍 SSE JWT verification:', { tokenReceived: !!token, jwtSecret: !!process.env.JWT_SECRET });
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
    console.log('🔓 SSE JWT decoded:', { decoded, userId: decoded.userId });
    userId = decoded.userId;
    
    if (!userId) {
      throw new Error('No user ID in token');
    }
  } catch (error: any) {
    console.error('❌ SSE JWT verification failed:', error);
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    res.end('Unauthorized: ' + (error?.message || 'Unknown error'));
    return;
  }
  
  // Set up Server-Sent Events
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  const sendUpdate = (data: any) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    // Get user for Gmail access
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });
    
    if (!user || !user.gmailAccessToken) {
      sendUpdate({ error: 'Gmail access required' });
      return res.end();
    }

    sendUpdate({ status: 'starting', message: `🔍 Starting Q${quarter} ${year} email processing...` });

    // Initialize Gmail client and parser
    const gmailClient = new GmailClient(user);
    const parser = new MLEmailParser(req.user!.id);
    
    // Search for booking and payout emails
    let searchQuery = 'from:automated@airbnb.com OR from:noreply@airbnb.com';
    searchQuery += ' (subject:"bokning bekräftad" OR subject:"booking confirmed" OR subject:"reservation confirmed" OR subject:"En utbetalning på" OR subject:"Bokningspåminnelse" OR subject:"booking reminder" OR subject:"Avbokad")';
    
    const quarterMap: Record<number, { start: string; end: string }> = {
      1: { start: `${year}/1/1`, end: `${year}/3/31` },
      2: { start: `${year}/4/1`, end: `${year}/6/30` },
      3: { start: `${year}/7/1`, end: `${year}/9/30` },
      4: { start: `${year}/10/1`, end: `${year}/12/31` }
    };
    
    const dates = quarterMap[parseInt(quarter)];
    if (dates) {
      searchQuery += ` after:${dates.start} before:${dates.end}`;
    }

    console.log(`🔍 Gmail search query: ${searchQuery}`);
    sendUpdate({ status: 'searching', message: `📧 Searching for emails...` });
    let emailIds = await gmailClient.searchEmails(searchQuery, 500);
    
    // Also search previous year for all emails (for cross-year bookings and payouts)
    const prevYear = parseInt(year) - 1;
    const prevYearQuery = 'from:automated@airbnb.com OR from:noreply@airbnb.com';
    const prevYearSearchQuery = prevYearQuery + ' (subject:"bokning bekräftad" OR subject:"booking confirmed" OR subject:"reservation confirmed" OR subject:"En utbetalning på" OR subject:"Bokningspåminnelse" OR subject:"booking reminder" OR subject:"Avbokad")' + ` after:${prevYear}/1/1 before:${prevYear}/12/31`;
    console.log(`🔍 Additional search for previous year emails: ${prevYearSearchQuery}`);
    sendUpdate({ status: 'searching', message: `📧 Also searching ${prevYear} for all relevant emails...` });
    const prevYearEmailIds = await gmailClient.searchEmails(prevYearSearchQuery, 500);
    
    // Combine results and remove duplicates
    emailIds = [...emailIds, ...prevYearEmailIds.filter(id => !emailIds.includes(id))];
    
    if (emailIds.length === 0) {
      sendUpdate({ status: 'completed', message: '✅ No emails found for this period', processed: 0, saved: 0 });
      return res.end();
    }

    sendUpdate({ 
      status: 'processing', 
      message: `📬 Found ${emailIds.length} potential emails`, 
      total: emailIds.length 
    });

    let processed = 0;
    let saved = 0;
    const savedBookings: any[] = [];

    // Process emails one by one with real-time updates
    for (const emailId of emailIds) {
      try {
        processed++;
        
        // Check if already processed
        const existingBooking = await prisma.booking.findFirst({
          where: { userId, gmailId: emailId }
        });
        
        if (existingBooking) {
          sendUpdate({ 
            status: 'progress', 
            message: `⏭️ Skipping already processed email`,
            processed, 
            saved,
            progress: Math.round((processed / emailIds.length) * 100)
          });
          continue;
        }
        
        // Get and parse email
        const email = await gmailClient.getEmail(emailId);
        const emailContent = extractEmailContent(email);
        
        if (!emailContent) {
          sendUpdate({ 
            status: 'progress', 
            message: `⚠️ Could not extract content from email`,
            processed, 
            saved,
            progress: Math.round((processed / emailIds.length) * 100)
          });
          continue;
        }

        sendUpdate({ 
          status: 'progress', 
          message: `🔍 Parsing email ${processed}/${emailIds.length}...`,
          processed, 
          saved,
          progress: Math.round((processed / emailIds.length) * 100)
        });
        
        // Extract headers for ML parser
        const headers = extractEmailHeaders(email);
        console.log(`[DEBUG] Extracted headers for email ${emailId}:`, headers ? `subject="${headers.subject}", from="${headers.from}"` : 'null');
        
        // Try to parse as booking confirmation first
        let bookingData = await parser.parseBookingEmail({
          emailId,
          rawEmailContent: emailContent,
          gmailId: emailId,
          gmailThreadId: email.threadId,
          headers: headers
        });

        // If that fails, try to parse as payout notification
        if (!bookingData) {
          bookingData = await parser.parsePayoutNotificationForBooking({
            emailId,
            rawEmailContent: emailContent,
            gmailId: emailId,
            gmailThreadId: email.threadId,
            headers: headers
          });
        }
        
        if (bookingData) {
          // Save to database
          const booking = await prisma.booking.create({
            data: {
              userId,
              gmailId: bookingData.gmailId,
              gmailThreadId: bookingData.gmailThreadId,
              bookingCode: bookingData.bookingCode,
              guestName: bookingData.guestName,
              checkInDate: bookingData.checkInDate ? new Date(bookingData.checkInDate) : null,
              checkOutDate: bookingData.checkOutDate ? new Date(bookingData.checkOutDate) : null,
              nights: bookingData.nights,
              guestTotalEur: bookingData.guestTotalEur,
              guestTotalSek: bookingData.guestTotalSek,
              hostEarningsEur: bookingData.hostEarningsEur,
              hostEarningsSek: bookingData.hostEarningsSek,
              cleaningFeeEur: bookingData.cleaningFeeEur,
              cleaningFeeSek: bookingData.cleaningFeeSek,
              status: 'processed'
            }
          });
          
          saved++;
          savedBookings.push({
            bookingCode: booking.bookingCode,
            guestName: booking.guestName,
            amount: booking.guestTotalEur,
            checkInDate: booking.checkInDate
          });

          sendUpdate({ 
            status: 'progress', 
            message: `✅ Saved booking: ${booking.bookingCode} - ${booking.guestName}`,
            processed, 
            saved,
            progress: Math.round((processed / emailIds.length) * 100),
            latestBooking: {
              bookingCode: booking.bookingCode,
              guestName: booking.guestName,
              amount: booking.guestTotalEur,
              checkInDate: booking.checkInDate
            }
          });
        }
        
        // Small delay to avoid overwhelming the UI
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (error: any) {
        sendUpdate({ 
          status: 'progress', 
          message: `❌ Error processing email: ${error.message}`,
          processed, 
          saved,
          progress: Math.round((processed / emailIds.length) * 100)
        });
      }
    }
    
  } catch (error: any) {
    sendUpdate({ status: 'error', message: `❌ Processing failed: ${error.message}` });
    res.end();
  }
});

/**
 * GET /api/process-emails/stream/:year
 * Stream real-time progress of email processing for entire year
 */
router.get('/process-emails/stream/:year', async (req: any, res: any) => {
  const { year } = req.params;
  const { token, action } = req.query;
  
  // Verify JWT token from query parameter since EventSource can't send headers
  let userId;
  try {
    if (!token) {
      throw new Error('No token provided');
    }
    console.log('🔍 SSE JWT verification:', { tokenReceived: !!token, jwtSecret: !!process.env.JWT_SECRET });
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
    console.log('🔓 SSE JWT decoded:', { decoded, userId: decoded.userId });
    userId = decoded.userId;
    
    if (!userId) {
      throw new Error('No user ID in token');
    }
  } catch (error: any) {
    console.error('❌ SSE JWT verification failed:', error);
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    res.end('Unauthorized: ' + (error?.message || 'Unknown error'));
    return;
  }
  
  // Set up Server-Sent Events
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  const sendUpdate = (data: any) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    // Get user for Gmail access
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });
    
    if (!user || !user.gmailAccessToken) {
      sendUpdate({ error: 'Gmail access required' });
      return res.end();
    }

    // Check if there's already an active scan - both in-memory and database
    const existingStatus = scanningStatus.get(userId);
    console.log(`🔍 Reconnection check - In-memory status for user ${userId}:`, existingStatus ? 
      { isScanning: existingStatus.isScanning, year: existingStatus.year, currentStatus: existingStatus.currentStatus } : 
      'Not found'
    );
    
    // Also check database for active sessions
    const activeSession = await prisma.scanningSession.findFirst({
      where: {
        userId,
        status: 'running',
        completedAt: null
      },
      orderBy: { startedAt: 'desc' }
    });
    
    console.log(`🔍 Active database session for user ${userId}:`, activeSession ? 
      { id: activeSession.id, year: activeSession.year, status: activeSession.status, currentStep: activeSession.currentStep } : 
      'None found'
    );
    
    if (existingStatus?.isScanning || activeSession) {
      const scanYear = existingStatus?.year || activeSession?.year;
      console.log(`🔄 User ${userId} has active scanning for year ${scanYear}, connecting to existing stream`);
      
      // If we have database session but no in-memory status, restore it
      if (!existingStatus && activeSession) {
        console.log(`🔄 Restoring in-memory scanning status from database session ${activeSession.id}`);
        scanningStatus.set(userId, {
          isScanning: true,
          year: activeSession.year,
          startTime: activeSession.startedAt,
          currentStatus: activeSession.currentStep || 'processing',
          lastMessage: activeSession.currentMessage || `Återansluter till scanning för ${activeSession.year}...`,
          progress: { 
            current: 0, 
            total: 0, 
            processed: 0, 
            skipped: 0, 
            errors: 0 
          }
        });
      }
      
      // Register this connection to receive broadcasts from the active scan
      if (!activeStreamConnections.has(userId)) {
        activeStreamConnections.set(userId, []);
      }
      const connections = activeStreamConnections.get(userId)!;
      connections.push(sendUpdate);
      
      // Send initial reconnection message
      const statusToUse = existingStatus || scanningStatus.get(userId);
      sendUpdate({ 
        status: 'reconnecting', 
        message: `🔄 Återansluter till pågående scanning för ${scanYear}...`,
        progress: statusToUse?.progress
      });
      
      // Clean up connection when client disconnects
      req.on('close', () => {
        console.log(`🔌 Client disconnected from stream for user ${userId}`);
        const connections = activeStreamConnections.get(userId);
        if (connections) {
          const index = connections.indexOf(sendUpdate);
          if (index > -1) {
            connections.splice(index, 1);
          }
          if (connections.length === 0) {
            activeStreamConnections.delete(userId);
          }
        }
      });
      
      return;
    }

    // Block automatic scans unless explicitly requested
    if (action !== 'start') {
      console.log(`🚫 Blocking automatic scan for user ${userId}, year ${year} - no explicit start action`);
      sendUpdate({ 
        status: 'blocked', 
        message: '🚫 Automatisk scanning blockerad. Klicka "Starta Email-Skanning" för att starta manuellt.',
      });
      
      // Keep connection alive but don't start scanning
      const keepAlive = setInterval(() => {
        sendUpdate({ 
          status: 'waiting', 
          message: '⏳ Väntar på manuell start...',
        });
      }, 10000);
      
      // Close connection after 30 seconds of inactivity
      setTimeout(() => {
        clearInterval(keepAlive);
        res.end();
      }, 30000);
      
      return;
    }

    // Only start new scan if explicitly requested with action=start
    console.log(`🚀 Starting new scan for user ${userId}, year ${year} (explicit start)`);
    
    // Find existing queued session or create new one
    let sessionRecord = await prisma.scanningSession.findFirst({
      where: {
        userId,
        year: parseInt(year),
        status: 'queued'
      },
      orderBy: { startedAt: 'desc' }
    });

    if (!sessionRecord) {
      // Create session if none exists (fallback)
      sessionRecord = await prisma.scanningSession.create({
        data: {
          userId,
          year: parseInt(year),
          status: 'running',
          currentMessage: `🔍 Startar sökning efter Airbnb emails för hela ${year}...`,
          currentStep: 'starting'
        }
      });
      console.log(`📝 Created new session ${sessionRecord.id} (no queued session found)`);
    } else {
      // Update existing session to running
      sessionRecord = await prisma.scanningSession.update({
        where: { id: sessionRecord.id },
        data: {
          status: 'running',
          currentMessage: `🔍 Startar sökning efter Airbnb emails för hela ${year}...`,
          currentStep: 'starting',
          lastUpdateAt: new Date()
        }
      });
      console.log(`📝 Updated existing session ${sessionRecord.id} to running`);
    }
    
    // Mark scanning as started
    scanningStatus.set(userId, {
      isScanning: true,
      year: parseInt(year),
      startTime: new Date(),
      currentStatus: 'starting',
      lastMessage: `🔍 Startar sökning efter Airbnb emails för hela ${year}...`,
    });
    
    // Register this connection for broadcasting
    if (!activeStreamConnections.has(userId)) {
      activeStreamConnections.set(userId, []);
    }
    const connections = activeStreamConnections.get(userId)!;
    connections.push(sendUpdate);
    
    // Clean up connection when client disconnects
    req.on('close', () => {
      console.log(`🔌 Client disconnected from stream for user ${userId}`);
      const connections = activeStreamConnections.get(userId);
      if (connections) {
        const index = connections.indexOf(sendUpdate);
        if (index > -1) {
          connections.splice(index, 1);
        }
        if (connections.length === 0) {
          activeStreamConnections.delete(userId);
        }
      }
    });
    
    const broadcastUpdate = (data: any) => {
      sendUpdate(data);
      broadcastToStreams(userId, data);
    };
    
    broadcastUpdate({ 
      status: 'starting', 
      message: `🔍 Startar sökning efter Airbnb emails för hela ${year}...`
    });

    // Initialize Gmail client and parser
    const gmailClient = new GmailClient(user);
    const parser = new MLEmailParser(req.user!.id);

    // OPTIMIZED: Only search for booking confirmations to get booking codes
    // All other emails (payouts, reminders, changes) will be fetched during enrichment
    const allEmailIds = await gmailClient.searchAirbnbBookingEmails(parseInt(year));
    
    // Update session and scanning status with email count
    sessionRecord = await prisma.scanningSession.update({
      where: { id: sessionRecord.id },
      data: {
        totalEmails: allEmailIds.length,
        currentMessage: `📧 Hittade ${allEmailIds.length} booking confirmation emails för ${year}`,
        currentStep: 'searching',
        lastUpdateAt: new Date()
      }
    });

    scanningStatus.set(userId, {
      isScanning: true,
      year: parseInt(year),
      startTime: scanningStatus.get(userId)?.startTime || new Date(),
      currentStatus: 'searching',
      lastMessage: `📧 Hittade ${allEmailIds.length} booking confirmation emails för ${year}`,
      totalEmails: allEmailIds.length,
    });
    
    sendUpdate({ 
      status: 'searching', 
      message: `📧 Hittade ${allEmailIds.length} booking confirmation emails för ${year}` 
    });

    if (allEmailIds.length === 0) {
      // Save completed session to database for history
      await prisma.scanningSession.create({
        data: {
          userId,
          year: parseInt(year),
          status: 'completed',
          totalEmails: 0,
          processedEmails: 0,
          skippedEmails: 0,
          errorEmails: 0,
          currentMessage: '✅ Inga nya emails hittades för den valda perioden.',
          currentStep: 'completed',
          completedAt: new Date()
        }
      });
      
      scanningStatus.delete(userId);
      
      sendUpdate({ 
        status: 'completed', 
        message: '✅ Inga nya emails hittades för den valda perioden.',
        processed: 0,
        skipped: 0,
        errors: 0
      });
      return res.end();
    }

    // Update to processing step
    scanningStatus.set(userId, {
      isScanning: true,
      year: parseInt(year),
      startTime: scanningStatus.get(userId)?.startTime || new Date(),
      currentStatus: 'processing',
      lastMessage: `⚡ Börjar bearbeta ${allEmailIds.length} emails...`,
      totalEmails: allEmailIds.length
    });
    
    sendUpdate({ 
      status: 'processing', 
      message: `⚡ Börjar bearbeta ${allEmailIds.length} emails...`,
      total: allEmailIds.length 
    });

    let processed = 0;
    let skipped = 0;
    let errors = 0;

    // Process emails one by one
    for (const emailId of allEmailIds) {
      try {
        // Check if scanning has been stopped by user
        const currentStatus = scanningStatus.get(userId);
        if (!currentStatus?.isScanning) {
          console.log('🛑 Scanning stopped by user');
          break;
        }
        
        // Check if already processed
        const existing = await prisma.booking.findFirst({
          where: { 
            userId: userId, 
            gmailId: emailId 
          }
        });

        if (existing) {
          skipped++;
          const progress = {
            current: processed + skipped + errors,
            total: allEmailIds.length,
            processed,
            skipped,
            errors
          };
          
          // Update scanning status
          scanningStatus.set(userId, {
            isScanning: true,
            year: parseInt(year),
            startTime: scanningStatus.get(userId)?.startTime || new Date(),
            progress
          });
          
          sendUpdate({
            status: 'progress',
            message: `⏭️  Hoppade över redan bearbetad email (${processed + skipped + errors}/${allEmailIds.length})`,
            progress
          });
          continue;
        }

        // Get email content
        const email = await gmailClient.getEmail(emailId);
        
        // Extract text content
        const extractText = (payload: any): string => {
          const extractFromPart = (part: any): string => {
            let content = '';
            
            // Extract content from this part if it has body data
            if (part.body?.data) {
              try {
                // Use simple base64 decode like ML tests for better content preservation
                const decoded = Buffer.from(part.body.data, 'base64').toString('utf-8');
                console.log(`[DEBUG] Part ${part.mimeType || 'unknown'}: ${decoded.length} chars`);
                content += decoded + '\n';
              } catch (e) {
                console.log(`[DEBUG] Failed to decode part ${part.mimeType}: ${e}`);
              }
            }
            
            // Recursively extract from nested parts
            if (part.parts) {
              for (const subPart of part.parts) {
                content += extractFromPart(subPart);
              }
            }
            
            return content;
          };
          
          // For multipart emails, extract from ALL parts recursively
          if (payload.parts) {
            let allContent = '';
            for (const part of payload.parts) {
              allContent += extractFromPart(part);
            }
            console.log(`[DEBUG] Total extracted content: ${allContent.length} chars from ${payload.parts.length} parts`);
            return allContent;
          }
          
          // Single part email
          if (payload.body?.data) {
            // Use simple base64 decode like ML tests for better content preservation
            const content = Buffer.from(payload.body.data, 'base64').toString('utf-8');
            console.log(`[DEBUG] Single part content: ${content.length} chars`);
            return content;
          }
          
          return '';
        };

        const emailContent = extractText(email.payload);
        
        // Extract headers for ML parser
        const headers = extractEmailHeaders(email);
        console.log(`[DEBUG] Extracted headers for email ${emailId}:`, headers ? `subject="${headers.subject}", from="${headers.from}"` : 'null');
        
        // Parse with AI
        const bookingData = await parser.parseBookingEmail({
          emailId: emailId,
          rawEmailContent: emailContent,
          gmailId: emailId,
          gmailThreadId: email.threadId,
          headers: headers
        });

        if (bookingData && bookingData.bookingCode) {
          // Update session with current booking being processed
          await prisma.scanningSession.update({
            where: { id: sessionRecord.id },
            data: {
              currentBookingCode: bookingData.bookingCode,
              currentGuestName: bookingData.guestName,
              lastUpdateAt: new Date()
            }
          });

          // Temporarily use simple logic until TypeScript issues are resolved
          console.log(`📊 Processing booking: ${bookingData.bookingCode} with data:`, {
            guestTotalSek: bookingData.guestTotalSek,
            hostEarningsSek: bookingData.hostEarningsSek,
            cleaningFeeSek: bookingData.cleaningFeeSek,
            serviceFeeSek: bookingData.serviceFeeSek
          });
          
          // Save booking to database - restore simple logic but always save economic data
          try {
            const upsertResult = await prisma.booking.upsert({
              where: {
                userId_bookingCode: {
                  userId,
                  bookingCode: bookingData.bookingCode
                }
              },
              create: {
                userId,
                bookingCode: bookingData.bookingCode!,
                guestName: bookingData.guestName,
                checkInDate: bookingData.checkInDate ? new Date(bookingData.checkInDate) : null,
                checkOutDate: bookingData.checkOutDate ? new Date(bookingData.checkOutDate) : null,
                nights: bookingData.nights,
                guestTotalEur: bookingData.guestTotalEur,
                hostEarningsEur: bookingData.hostEarningsEur,
                cleaningFeeEur: bookingData.cleaningFeeEur,
                serviceFeeEur: bookingData.serviceFeeEur,
                guestTotalSek: bookingData.guestTotalSek,
                hostEarningsSek: bookingData.hostEarningsSek,
                cleaningFeeSek: bookingData.cleaningFeeSek,
                serviceFeeSek: bookingData.serviceFeeSek,
                // Auto-detect private bookings (no guest name or "Private booking" format)
                status: bookingData.status || (
                  !bookingData.guestName || 
                  bookingData.guestName.startsWith('Private booking') 
                  ? 'private' : null
                ),
                gmailId: bookingData.gmailId,
                gmailThreadId: bookingData.gmailThreadId,
                parseAttempts: 1,
                // Set initial enrichment state
                enrichmentStatus: 'scanning',
                enrichmentProgress: 0,
                enrichmentTotal: 1
              },
              update: {
                // Always update with new data from ML, prioritize booking_confirmation
                guestName: bookingData.guestName || undefined,
                checkInDate: bookingData.checkInDate ? new Date(bookingData.checkInDate) : undefined,
                checkOutDate: bookingData.checkOutDate ? new Date(bookingData.checkOutDate) : undefined,
                nights: bookingData.nights || undefined,
                // FORCE save economic data when available - use explicit values to ensure Prisma includes them
                ...(bookingData.guestTotalEur !== null && bookingData.guestTotalEur !== undefined ? { guestTotalEur: bookingData.guestTotalEur } : {}),
                ...(bookingData.hostEarningsEur !== null && bookingData.hostEarningsEur !== undefined ? { hostEarningsEur: bookingData.hostEarningsEur } : {}),
                ...(bookingData.cleaningFeeEur !== null && bookingData.cleaningFeeEur !== undefined ? { cleaningFeeEur: bookingData.cleaningFeeEur } : {}),
                ...(bookingData.serviceFeeEur !== null && bookingData.serviceFeeEur !== undefined ? { serviceFeeEur: bookingData.serviceFeeEur } : {}),
                ...(bookingData.guestTotalSek !== null && bookingData.guestTotalSek !== undefined ? { guestTotalSek: bookingData.guestTotalSek } : {}),
                ...(bookingData.hostEarningsSek !== null && bookingData.hostEarningsSek !== undefined ? { hostEarningsSek: bookingData.hostEarningsSek } : {}),
                ...(bookingData.cleaningFeeSek !== null && bookingData.cleaningFeeSek !== undefined ? { cleaningFeeSek: bookingData.cleaningFeeSek } : {}),
                ...(bookingData.serviceFeeSek !== null && bookingData.serviceFeeSek !== undefined ? { serviceFeeSek: bookingData.serviceFeeSek } : {}),
                status: bookingData.status || (
                  !bookingData.guestName || 
                  bookingData.guestName.startsWith('Private booking') 
                  ? 'private' : undefined
                ),
                gmailId: bookingData.gmailId || undefined,
                gmailThreadId: bookingData.gmailThreadId || undefined,
                parseAttempts: { increment: 1 }
              }
            });
            processed++;
            console.log(`💾 Upserted booking ${bookingData.bookingCode} to database`);
            
            // Emit booking created/updated event
            try {
              if (upsertResult.parseAttempts === 1) {
                console.log(`📡 Emitting CREATED event for new booking ${bookingData.bookingCode}`);
                await bookingUpdateEmitter.emitBookingCreated(userId, upsertResult, sessionRecord.id);
              } else {
                console.log(`📡 Emitting UPDATED event for existing booking ${bookingData.bookingCode}`);
                await bookingUpdateEmitter.emitBookingUpdated(userId, upsertResult, {}, sessionRecord.id);
              }
            } catch (emitError) {
              console.error('❌ Failed to emit booking event:', emitError);
            }
            
            // Save email link for this booking
            if (upsertResult && bookingData.gmailId) {
              await saveMainEmailLink(upsertResult.id, bookingData, headers);
            }
            
            // Inline enrichment: If this is the first time we see this booking code, enrich it immediately
            if (upsertResult && upsertResult.parseAttempts === 1) {
              try {
                console.log(`🔍 First time seeing ${bookingData.bookingCode}, running inline enrichment...`);
                
                // Update status to 'enriching' before starting enrichment
                const enrichingBooking = await prisma.booking.update({
                  where: { id: upsertResult.id },
                  data: {
                    enrichmentStatus: 'enriching',
                    enrichmentProgress: 0
                  }
                });
                
                // Emit enriching status update
                try {
                  console.log(`📡 Emitting UPDATED event for enrichment start: enriching`);
                  await bookingUpdateEmitter.emitBookingUpdated(userId, enrichingBooking, { enrichmentStatus: { old: 'scanning', new: 'enriching' } }, sessionRecord.id);
                } catch (emitError) {
                  console.error('❌ Failed to emit enriching status event:', emitError);
                }
                
                const { BookingEnricher } = await import('../utils/booking-enricher');
                const enricher = new BookingEnricher(gmailClient, userId);
                const enrichmentResult = await enricher.enrichBooking(bookingData.bookingCode);
                
                // Get the updated booking to check final status after enrichment
                const updatedBooking = await prisma.booking.findUnique({
                  where: { id: upsertResult.id }
                });
                
                // Determine final status based on enrichment results
                let finalStatus = 'upcoming'; // Default
                
                // Check if cancelled based on the booking status after enrichment
                if (updatedBooking?.status === 'cancelled' || updatedBooking?.status === 'cancelled_with_payout') {
                  finalStatus = 'cancelled';
                } else if (bookingData.checkOutDate && new Date(bookingData.checkOutDate) < new Date()) {
                  // Past checkout date = completed
                  finalStatus = 'completed';
                }
                
                // Update final enrichment status
                const finalBooking = await prisma.booking.update({
                  where: { id: upsertResult.id },
                  data: {
                    enrichmentStatus: finalStatus,
                    enrichmentProgress: enrichmentResult.emailsProcessed || 0,
                    enrichmentTotal: enrichmentResult.emailsFound || 0
                  }
                });
                
                // Emit enrichment status update
                try {
                  console.log(`📡 Emitting UPDATED event for enrichment status: ${finalStatus}`);
                  await bookingUpdateEmitter.emitBookingUpdated(userId, finalBooking, { enrichmentStatus: { old: 'enriching', new: finalStatus } }, sessionRecord.id);
                } catch (emitError) {
                  console.error('❌ Failed to emit enrichment status event:', emitError);
                }
                
                if (enrichmentResult.dataImproved) {
                  console.log(`✅ Inline enrichment improved ${bookingData.bookingCode}: ${enrichmentResult.emailsProcessed} additional emails processed. Status: ${finalStatus}`);
                } else if (enrichmentResult.emailsFound > 0) {
                  console.log(`📝 Inline enrichment for ${bookingData.bookingCode}: processed ${enrichmentResult.emailsProcessed}/${enrichmentResult.emailsFound} emails, no improvement. Status: ${finalStatus}`);
                }
              } catch (enrichmentError: any) {
                console.log(`⚠️ Inline enrichment failed for ${bookingData.bookingCode}: ${enrichmentError.message}`);
                // Set as upcoming if enrichment fails
                const fallbackBooking = await prisma.booking.update({
                  where: { id: upsertResult.id },
                  data: {
                    enrichmentStatus: 'upcoming',
                    enrichmentProgress: 0,
                    enrichmentTotal: 0
                  }
                });
                
                // Emit fallback status update
                try {
                  console.log(`📡 Emitting UPDATED event for fallback enrichment status: upcoming`);
                  await bookingUpdateEmitter.emitBookingUpdated(userId, fallbackBooking, { enrichmentStatus: { old: 'enriching', new: 'upcoming' } }, sessionRecord.id);
                } catch (emitError) {
                  console.error('❌ Failed to emit fallback enrichment status event:', emitError);
                }
              }
            }
            
          } catch (dbError: any) {
            console.error(`❌ Failed to save booking ${bookingData.bookingCode}:`, dbError);
            // Treat as processed since parsing worked, just database failed
            processed++;
          }
          
          sendUpdate({
            status: 'progress',
            message: `✅ Bearbetade booking ${bookingData.bookingCode} (${processed + skipped + errors}/${allEmailIds.length})`,
            progress: {
              current: processed + skipped + errors,
              total: allEmailIds.length,
              processed,
              skipped,
              errors
            }
          });
        } else {
          skipped++;
          sendUpdate({
            status: 'progress', 
            message: `⏭️  Kunde inte extrahera booking-data (${processed + skipped + errors}/${allEmailIds.length})`,
            progress: {
              current: processed + skipped + errors,
              total: allEmailIds.length,
              processed,
              skipped,
              errors
            }
          });
        }

        // Update session progress for every email for better user experience
        try {
            await prisma.scanningSession.update({
              where: { id: sessionRecord.id },
              data: {
                currentEmailIndex: processed + skipped + errors,
                processedEmails: processed,
                skippedEmails: skipped,
                errorEmails: errors,
                currentMessage: `Bearbetar emails: ${processed + skipped + errors}/${allEmailIds.length}`,
                lastUpdateAt: new Date()
              }
            });
        } catch (updateError) {
          console.error('Failed to update session progress:', updateError);
        }

        // Small delay to prevent overwhelming the client
        await new Promise(resolve => setTimeout(resolve, 100));

      } catch (error: any) {
        errors++;
        console.error(`❌ Error processing email ${emailId}:`, error);
        sendUpdate({
          status: 'progress',
          message: `❌ Fel vid bearbetning av email (${processed + skipped + errors}/${allEmailIds.length}): ${error.message}`,
          progress: {
            current: processed + skipped + errors,
            total: allEmailIds.length,
            processed,
            skipped,
            errors
          }
        });
      }
    }

    // Update session to completed status
    await prisma.scanningSession.update({
      where: { id: sessionRecord.id },
      data: {
        status: 'completed',
        processedEmails: processed,
        skippedEmails: skipped,
        errorEmails: errors,
        currentMessage: `🎉 Bearbetning klar! Bearbetade: ${processed}, Hoppade över: ${skipped}, Fel: ${errors}`,
        currentStep: 'completed',
        completedAt: new Date(),
        lastUpdateAt: new Date()
      }
    });
    
    // Clear from active scanning status
    scanningStatus.delete(userId);
    
    sendUpdate({ 
      status: 'completed', 
      message: `🎉 Bearbetning klar! Bearbetade: ${processed}, Hoppade över: ${skipped}, Fel: ${errors}`,
      processed,
      skipped,
      errors
    });

    // Performance logging removed - using pure ML parser now

  } catch (error: any) {
    console.error('❌ SSE Error:', error);
    
    // Save failed session to database
    try {
      await prisma.scanningSession.create({
        data: {
          userId,
          year: parseInt(year),
          status: 'failed',
          currentMessage: `❌ Ett fel uppstod: ${error.message}`,
          currentStep: 'error',
          completedAt: new Date()
        }
      });
    } catch (dbError) {
      console.error('❌ Failed to save error session:', dbError);
    }
    
    // Clear from active scanning status
    scanningStatus.delete(userId);
    
    sendUpdate({ 
      error: error.message,
      status: 'error',
      message: `❌ Ett fel uppstod: ${error.message}` 
    });
  } finally {
    res.end();
  }
});

/**
 * GET /api/scanning-status
 * Check if scanning is currently active for user
 */
router.get('/scanning-status/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    
    // First check in-memory active scanning
    const activeStatus = scanningStatus.get(userId);
    if (activeStatus?.isScanning) {
      return res.json({
        data: {
          isActive: true,
          progress: activeStatus.progress,
          message: activeStatus.lastMessage || activeStatus.currentStatus,
          year: activeStatus.year
        }
      });
    }
    
    // FIXED: Also check database for active sessions (after server restart)
    const activeSession = await prisma.scanningSession.findFirst({
      where: { 
        userId,
        status: { in: ['running', 'queued'] },
        completedAt: null
      },
      orderBy: { startedAt: 'desc' }
    });
    
    if (activeSession) {
      return res.json({
        data: {
          isActive: true,
          progress: Math.round((activeSession.processedEmails / (activeSession.totalEmails || 1)) * 100),
          message: activeSession.currentMessage || `📧 Bearbetar ${activeSession.year} (${activeSession.processedEmails}/${activeSession.totalEmails})`,
          year: activeSession.year
        }
      });
    }
    
    // If not active, get most recent completed session for display
    const lastSession = await prisma.scanningSession.findFirst({
      where: { userId },
      orderBy: { completedAt: 'desc' }
    });
    
    res.json({
      data: {
        isActive: false,
        message: lastSession?.currentMessage || 'Redo att scanna'
      }
    });
  } catch (error) {
    console.error('❌ Error getting scanning status:', error);
    res.json({ data: { isActive: false, message: 'Error loading status' } });
  }
});

/**
 * POST /api/stop-scanning
 * Stop active scanning session for user
 */
router.post('/stop-scanning', async (req: any, res: any) => {
  try {
    // Extract JWT token from Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No valid authorization token provided' });
    }
    
    const token = authHeader.substring(7); // Remove "Bearer " prefix
    
    // Verify JWT token
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
    const userId = decoded.userId;
    
    // Clear in-memory scanning status
    const wasScanning = scanningStatus.has(userId);
    scanningStatus.delete(userId);
    
    // Update database to mark active sessions as cancelled
    const cancelledSessions = await prisma.scanningSession.updateMany({
      where: { 
        userId,
        status: { in: ['running', 'queued'] },
        completedAt: null
      },
      data: { 
        status: 'cancelled',
        currentMessage: '🛑 Scanning avbruten av användare',
        currentStep: 'cancelled',
        completedAt: new Date(),
        lastUpdateAt: new Date()
      }
    });

    console.log(`🛑 Cancelled ${cancelledSessions.count} scanning sessions for user ${userId}`);
    
    res.json({ 
      data: {
        cancelled: cancelledSessions.count,
        message: cancelledSessions.count > 0 ? 
          `Scanning stoppad (${cancelledSessions.count} sessioner avbrutna)` : 
          'Ingen aktiv scanning att stoppa' 
      }
    });
    
  } catch (error) {
    console.error('❌ Error stopping scanning:', error);
    res.status(500).json({ error: 'Failed to stop scanning' });
  }
});

// Apply authentication to all OTHER API routes
router.use(authenticateJWT as express.RequestHandler);

/**
 * GET /api/stats
 * Get user's processing statistics
 */
router.get('/stats', async (req: any, res: any) => {
  try {
    const userId = req.user!.id;
    
    const [
      bookingsCount,
      payoutsCount,
      matchesCount,
      pdfCount
    ] = await Promise.all([
      prisma.booking.count({ where: { userId } }),
      prisma.payout.count({ where: { userId } }),
      prisma.bookingPayoutMatch.count({ where: { userId } }),
      prisma.pdfDocument.count({ where: { userId } })
    ]);

    // Get revenue by year
    const bookingsByYear = await prisma.booking.groupBy({
      by: ['checkInDate'],
      where: { 
        userId,
        hostEarningsSek: { not: null }
      },
      _sum: {
        hostEarningsSek: true
      }
    });

    const revenueByYear: Record<string, number> = {};
    bookingsByYear.forEach(booking => {
      if (booking.checkInDate) {
        const year = booking.checkInDate.getFullYear().toString();
        revenueByYear[year] = (revenueByYear[year] || 0) + (booking._sum.hostEarningsSek || 0);
      }
    });

    res.json({
      bookings: bookingsCount,
      payouts: payoutsCount,
      matches: matchesCount,
      pdfs: pdfCount,
      revenueByYear,
      lastUpdated: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Stats API error:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

/**
 * GET /api/bookings
 * Get user's bookings with optional filters
 */
router.get('/bookings', async (req: any, res: any) => {
  try {
    const userId = req.user!.id;
    const { year, status, limit = 500, offset = 0, includePrivate = 'false' } = req.query;
    
    const where: any = { userId };
    
    if (year) {
      const yearNum = parseInt(year as string);
      where.checkInDate = {
        gte: new Date(`${yearNum}-01-01`),
        lte: new Date(`${yearNum}-12-31`)
      };
    }
    
    if (status) {
      where.status = status as string;
    } else if (includePrivate === 'false') {
      // By default, exclude private bookings unless explicitly requested
      where.status = {
        not: 'private'
      };
    }
    
    const bookings = await prisma.booking.findMany({
      where,
      orderBy: { checkInDate: 'desc' },
      take: parseInt(limit as string),
      skip: parseInt(offset as string),
      include: {
        payouts: {
          include: {
            payout: true
          }
        },
        pdfDocuments: true,
        emailLinks: {
          orderBy: { createdAt: 'desc' }
        }
      }
    });
    
    res.json({ data: bookings });
  } catch (error) {
    console.error('❌ Bookings API error:', error);
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

/**
 * GET /api/payouts
 * Get user's payouts
 */
router.get('/payouts', async (req: any, res: any) => {
  try {
    const userId = req.user!.id;
    const { limit = 500, offset = 0 } = req.query;
    
    const payouts = await prisma.payout.findMany({
      where: { userId },
      orderBy: { payoutDate: 'desc' },
      take: parseInt(limit as string),
      skip: parseInt(offset as string),
      include: {
        bookingMatches: {
          include: {
            booking: true
          }
        }
      }
    });
    
    res.json(payouts);
  } catch (error) {
    console.error('❌ Payouts API error:', error);
    res.status(500).json({ error: 'Failed to fetch payouts' });
  }
});

/**
 * GET /api/bookings/:bookingId/gmail-links
 * Get Gmail links for a specific booking
 */
router.get('/bookings/:bookingId/gmail-links', async (req: any, res: any) => {
  try {
    const userId = req.user!.id;
    const bookingId = parseInt(req.params.bookingId);
    
    if (isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }
    
    // Verify user owns this booking
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: { userId: true, bookingCode: true, guestName: true }
    });
    
    if (!booking || booking.userId !== userId) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    
    // Get all email links for this booking
    const emailLinks = await EmailLinkManager.getEmailLinksForBooking(bookingId);
    
    // Generate Gmail URLs organized by email type
    const gmailUrls = EmailLinkManager.generateGmailUrls(emailLinks);
    
    res.json({
      bookingId,
      bookingCode: booking.bookingCode,
      guestName: booking.guestName,
      emailCount: emailLinks.length,
      gmailUrls,
      emailDetails: emailLinks.map(link => ({
        emailType: link.emailType,
        subject: link.subject,
        emailDate: link.emailDate,
        gmailUrl: `https://mail.google.com/mail/u/0/#inbox/${link.gmailId}`
      }))
    });
  } catch (error) {
    console.error('❌ Gmail links API error:', error);
    res.status(500).json({ error: 'Failed to fetch Gmail links' });
  }
});

/**
 * GET /api/bookings/code/:bookingCode/gmail-links
 * Get Gmail links for a booking by booking code
 */
router.get('/bookings/code/:bookingCode/gmail-links', async (req: any, res: any) => {
  try {
    const userId = req.user!.id;
    const bookingCode = req.params.bookingCode;
    
    // Find booking by code
    const booking = await prisma.booking.findUnique({
      where: {
        userId_bookingCode: {
          userId,
          bookingCode
        }
      },
      select: { id: true, bookingCode: true, guestName: true }
    });
    
    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    
    // Get all email links for this booking
    const emailLinks = await EmailLinkManager.getEmailLinksForBooking(booking.id);
    
    // Generate Gmail URLs organized by email type
    const gmailUrls = EmailLinkManager.generateGmailUrls(emailLinks);
    
    res.json({
      bookingId: booking.id,
      bookingCode: booking.bookingCode,
      guestName: booking.guestName,
      emailCount: emailLinks.length,
      gmailUrls,
      emailDetails: emailLinks.map(link => ({
        emailType: link.emailType,
        subject: link.subject,
        emailDate: link.emailDate,
        gmailUrl: `https://mail.google.com/mail/u/0/#inbox/${link.gmailId}`
      }))
    });
  } catch (error) {
    console.error('❌ Gmail links API error:', error);
    res.status(500).json({ error: 'Failed to fetch Gmail links' });
  }
});

/**
 * POST /api/test-parser
 * Test parser functionality with sample data
 */
router.post('/test-parser', async (req: any, res: any) => {
  try {
    const { emailData } = req.body;
    
    if (!emailData) {
      return res.status(400).json({ error: 'Email data required' });
    }
    
    const parser = new MLEmailParser(req.user!.id);
    const result = await parser.parseBookingEmail(emailData);
    
    res.json({
      success: !!result,
      data: result
    });
  } catch (error) {
    console.error('❌ Parser test error:', error);
    res.status(500).json({ error: 'Parser test failed' });
  }
});

/**
 * GET /api/user/settings
 * Get user settings
 */
router.get('/user/settings', async (req: any, res: any) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: {
        settings: true,
        gmailAccessToken: true,
        gmailRefreshToken: true,
        gmailTokenExpiry: true
      }
    });
    
    res.json({
      settings: user?.settings || {},
      hasGmailAccess: !!(user?.gmailAccessToken && user?.gmailRefreshToken)
    });
  } catch (error) {
    console.error('❌ User settings API error:', error);
    res.status(500).json({ error: 'Failed to fetch user settings' });
  }
});

/**
 * PUT /api/user/settings
 * Update user settings
 */
router.put('/user/settings', async (req: any, res: any) => {
  try {
    const { settings } = req.body;
    
    const updatedUser = await prisma.user.update({
      where: { id: req.user!.id },
      data: { 
        settings: settings,
        updatedAt: new Date()
      }
    });
    
    res.json({ 
      success: true,
      settings: updatedUser.settings 
    });
  } catch (error) {
    console.error('❌ Update settings API error:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

/**
 * GET /api/profile
 * Get current user profile
 */
router.get('/profile', async (req: any, res: any) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: {
        id: true,
        email: true,
        displayName: true,
        googleId: true
      }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ data: user });
  } catch (error) {
    console.error('❌ Profile API error:', error);
    res.status(500).json({ error: 'Failed to get user profile' });
  }
});

/**
 * POST /api/process-emails
 * Process Airbnb booking emails and save bookings
 */
router.post('/process-emails', async (req: any, res: any) => {
  try {
    const userId = req.user!.id;
    const { year, quarter } = req.body;
    
    // Get user for Gmail access
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });
    
    if (!user || !user.gmailAccessToken) {
      return res.status(400).json({ 
        error: 'Gmail access required',
        message: 'Please authenticate with Gmail first'
      });
    }
    
    console.log(`🔍 Processing emails for Q${quarter} ${year} for user ${user.email}`);
    
    // Initialize Gmail client and parser
    const gmailClient = new GmailClient(user);
    const parser = new MLEmailParser(req.user!.id);
    
    // Search for booking emails in the specified quarter
    let searchQuery = 'from:automated@airbnb.com OR from:noreply@airbnb.com';
    searchQuery += ' (subject:"bokning bekräftad" OR subject:"booking confirmed" OR subject:"reservation confirmed")';
    
    if (year && quarter) {
      // Q1: Jan-Mar, Q2: Apr-Jun, Q3: Jul-Sep, Q4: Oct-Dec
      const quarterMap: Record<number, { start: string; end: string }> = {
        1: { start: `${year}/1/1`, end: `${year}/3/31` },
        2: { start: `${year}/4/1`, end: `${year}/6/30` },
        3: { start: `${year}/7/1`, end: `${year}/9/30` },
        4: { start: `${year}/10/1`, end: `${year}/12/31` }
      };
      
      const dates = quarterMap[quarter];
      if (dates) {
        searchQuery += ` after:${dates.start} before:${dates.end}`;
      }
    }
    
    console.log(`📧 Gmail search query: ${searchQuery}`);
    const emailIds = await gmailClient.searchEmails(searchQuery, 500);
    
    if (emailIds.length === 0) {
      return res.json({
        success: true,
        message: 'No booking emails found for the specified period',
        processed: 0,
        saved: 0,
        errors: []
      });
    }
    
    console.log(`📬 Found ${emailIds.length} potential booking emails`);
    
    let processed = 0;
    let saved = 0;
    const errors: string[] = [];
    
    // Process emails in batches to avoid rate limits
    const batchSize = 10;
    for (let i = 0; i < emailIds.length; i += batchSize) {
      const batch = emailIds.slice(i, i + batchSize);
      
      for (const emailId of batch) {
        try {
          processed++;
          
          // Check if we already processed this email
          const existingBooking = await prisma.booking.findFirst({
            where: { 
              userId,
              gmailId: emailId 
            }
          });
          
          if (existingBooking) {
            console.log(`⏭️  Skipping already processed email: ${emailId}`);
            continue;
          }
          
          // Get full email content
          const email = await gmailClient.getEmail(emailId);
          
          // Extract email content for parsing
          const emailContent = extractEmailContent(email);
          if (!emailContent) {
            console.log(`⚠️  Could not extract content from email: ${emailId}`);
            continue;
          }
          
          // Parse with AI
          const bookingData = await parser.parseBookingEmail({
            emailId,
            rawEmailContent: emailContent,
            gmailId: emailId,
            gmailThreadId: email.threadId
          });
          
          if (bookingData) {
            // Save to database - note: using bookingCode from database schema
            const booking = await prisma.booking.create({
              data: {
                userId,
                gmailId: bookingData.gmailId,
                gmailThreadId: bookingData.gmailThreadId,
                bookingCode: bookingData.bookingCode,
                guestName: bookingData.guestName,
                checkInDate: bookingData.checkInDate ? new Date(bookingData.checkInDate) : null,
                checkOutDate: bookingData.checkOutDate ? new Date(bookingData.checkOutDate) : null,
                nights: bookingData.nights,
                guestTotalEur: bookingData.guestTotalEur,
                guestTotalSek: bookingData.guestTotalSek,
                hostEarningsEur: bookingData.hostEarningsEur,
                hostEarningsSek: bookingData.hostEarningsSek,
                cleaningFeeEur: bookingData.cleaningFeeEur,
                cleaningFeeSek: bookingData.cleaningFeeSek,
                status: 'processed'
              }
            });
            
            saved++;
            console.log(`✅ Saved booking: ${booking.bookingCode} - ${booking.guestName}`);
          }
          
          // Small delay to avoid rate limits
          await new Promise(resolve => setTimeout(resolve, 100));
          
        } catch (error: any) {
          console.error(`❌ Error processing email ${emailId}:`, error.message);
          errors.push(`Email ${emailId}: ${error.message}`);
        }
      }
      
      // Longer delay between batches
      if (i + batchSize < emailIds.length) {
        console.log(`⏸️  Processed batch ${Math.floor(i/batchSize) + 1}, waiting before next batch...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
    console.log(`🎉 Processing complete: ${saved}/${processed} emails saved as bookings`);
    
    res.json({
      success: true,
      message: `Processing complete for Q${quarter} ${year}`,
      emailsFound: emailIds.length,
      processed,
      saved,
      errors: errors.slice(0, 10) // Return first 10 errors only
    });
    
  } catch (error: any) {
    console.error('❌ Email processing error:', error);
    res.status(500).json({ 
      error: 'Email processing failed',
      message: error.message 
    });
  }
});

// DELETE all bookings endpoint  
router.delete('/bookings/all', async (req, res) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
    const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
    if (!user) return res.status(401).json({ error: 'Invalid token' });
    
    const deleted = await prisma.booking.deleteMany({ where: { userId: user.id } });
    console.log(`🗑️ Deleted ${deleted.count} bookings for user ${user.id}`);
    res.json({ data: { success: true, deletedCount: deleted.count, message: `Deleted ${deleted.count} bookings` } });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to delete bookings' });
  }
});

/**
 * Helper function to extract headers from Gmail message
 */
function extractEmailHeaders(message: any): EmailHeaders | undefined {
  try {
    const headers = message.payload?.headers || [];
    console.log(`[DEBUG] extractEmailHeaders: Found ${headers.length} headers, payload exists: ${!!message.payload}`);
    const headerMap: any = {};
    
    for (const header of headers) {
      headerMap[header.name.toLowerCase()] = header.value;
    }
    
    return {
      from: headerMap.from || '',
      to: headerMap.to || '',
      subject: headerMap.subject || '',
      date: headerMap.date || '',
      messageId: headerMap['message-id'] || ''
    };
  } catch (error) {
    console.error('Error extracting email headers:', error);
    return undefined;
  }
}

/**
 * Helper function to extract readable content from Gmail message
 */
function extractEmailContent(message: any): string | null {
  try {
    if (message.payload?.body?.data) {
      return decodeGmailContent(message.payload.body.data);
    }
    
    if (message.payload?.parts) {
      let plainText = '';
      let htmlText = '';
      
      // Extract both plain text and HTML content
      for (const part of message.payload.parts) {
        if (part.mimeType === 'text/plain' && part.body?.data) {
          plainText = decodeGmailContent(part.body.data);
        } else if (part.mimeType === 'text/html' && part.body?.data) {
          const html = decodeGmailContent(part.body.data);
          // Convert HTML to text and extract meaningful content
          htmlText = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        }
      }
      
      // For Airbnb emails, combine both plain text and HTML since important data is in HTML
      if (plainText && htmlText) {
        return plainText + '\n\n' + htmlText;
      }
      
      // Fall back to either one available
      return plainText || htmlText;
    }
    
    // Fall back to raw format if payload is empty (happens with some Gmail emails)
    if (message.raw) {
      const raw = Buffer.from(message.raw, 'base64').toString('utf-8');
      
      // Extract HTML content from raw email
      const htmlMatch = raw.match(/Content-Type: text\/html[\s\S]*?\r?\n\r?\n([\s\S]*?)(?=\r?\n--|\r?\n\r?\nContent-Type:|$)/);
      if (htmlMatch && htmlMatch[1]) {
        // Decode base64 HTML if it's encoded
        let html = htmlMatch[1];
        if (html.match(/^[A-Za-z0-9+/=\s]+$/)) {
          try {
            html = Buffer.from(html.replace(/\s/g, ''), 'base64').toString('utf-8');
          } catch (e) {
            // If decoding fails, use as-is
          }
        }
        
        // Convert HTML to text
        const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        if (text.length > 100) { // Only return if we got meaningful content
          return text;
        }
      }
      
      // Extract plain text content from raw email as fallback
      const textMatch = raw.match(/Content-Type: text\/plain[\s\S]*?\r?\n\r?\n([\s\S]*?)(?=\r?\n--|\r?\n\r?\nContent-Type:|$)/);
      if (textMatch && textMatch[1]) {
        return textMatch[1].trim();
      }
    }
    
    return null;
  } catch (error) {
    console.error('Error extracting email content:', error);
    return null;
  }
}

/**
 * Save email link for main processing
 */
async function saveMainEmailLink(bookingId: number, bookingData: any, headers?: EmailHeaders) {
  try {
    // Determine email type from booking data
    let emailType: 'confirmation' | 'payout' | 'reminder' | 'cancellation' | 'modification' = 'confirmation';
    
    if (bookingData.emailType === 'booking_confirmation') {
      emailType = 'confirmation';
    } else if (bookingData.emailType === 'booking_reminder') {
      emailType = 'reminder';
    } else if (bookingData.emailType === 'payout') {
      emailType = 'payout';
    } else if (bookingData.emailType === 'cancellation') {
      emailType = 'cancellation';
    } else if (bookingData.status?.includes('modified')) {
      emailType = 'modification';
    }
    
    // Use headers for subject and date if available
    const subject = headers?.subject || `${emailType} email`;
    const emailDate = headers?.date ? new Date(headers.date) : new Date();

    await EmailLinkManager.addEmailLink({
      bookingId,
      emailType,
      gmailId: bookingData.gmailId,
      gmailThreadId: bookingData.gmailThreadId,
      subject,
      emailDate
    });
    
    console.log(`📧 Saved ${emailType} email link for booking ${bookingId}`);
    
  } catch (error) {
    console.warn(`⚠️ Failed to save main email link for booking ${bookingId}: ${error}`);
  }
}

/**
 * POST /api/scan-year
 * Start a new year-wide scanning session with persistent tracking
 */
router.post('/scan-year', async (req: any, res: any) => {
  try {
    console.log('📥 POST /api/scan-year received:', req.body);
    const { years, quickScan } = req.body;
    
    // Manual JWT token verification like other endpoints
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token provided' });
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
    const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
    if (!user) return res.status(401).json({ error: 'Invalid token' });
    
    const userId = user.id;

    // Handle years array or default to current year if empty
    const currentYear = new Date().getFullYear();
    const yearsToScan = years && years.length > 0 ? years : [currentYear];
    
    console.log(`🚀 Starting ${quickScan ? 'QUICK' : 'FULL'} scan for ${yearsToScan.join(', ')} by user ${userId}`);

    // Validate years
    for (const year of yearsToScan) {
      if (!year || isNaN(year) || year < 2020 || year > currentYear) {
        return res.status(400).json({ error: `Invalid year provided: ${year}` });
      }
    }
    
    const year = yearsToScan[0]; // For now, scan the first year (maintain backward compatibility)

    // Check if user already has an active scanning session
    console.log(`🔍 Checking for active sessions for user ${userId}`);
    const activeSession = await prisma.scanningSession.findFirst({
      where: {
        userId,
        status: { in: ['running', 'queued'] },
        completedAt: null
      }
    });

    console.log('🔍 Active session check result:', activeSession);
    
    if (activeSession) {
      console.log(`❌ 409 Conflict: Active session found - ID: ${activeSession.id}, Status: ${activeSession.status}`);
      return res.status(409).json({ 
        error: 'Scanning session already in progress',
        sessionId: activeSession.id,
        year: activeSession.year,
        status: activeSession.status
      });
    }
    
    console.log('✅ No active sessions found, proceeding with scan creation');

    // Get user for Gmail access
    const userRecord = await prisma.user.findUnique({
      where: { id: userId }
    });
    
    if (!userRecord || !userRecord.gmailAccessToken) {
      return res.status(400).json({ error: 'Gmail access required' });
    }

    // Create a new persistent scanning session
    let sessionRecord = await prisma.scanningSession.create({
      data: {
        userId,
        year: parseInt(year),
        status: 'running',
        searchQuery: `from:automated@airbnb.com OR from:noreply@airbnb.com after:${year}/1/1 before:${year+1}/1/1`,
        emailTypes: JSON.stringify(['booking_confirmation', 'payout', 'cancellation', 'modification']),
        dateRange: JSON.stringify({ from: `${year}-01-01`, to: `${year}-12-31` }),
        currentMessage: `🔍 Startar sökning efter Airbnb emails för hela ${year}...`,
        currentStep: 'starting'
      }
    });

    console.log(`📊 Created scanning session ${sessionRecord.id} for year ${year} - starting processing immediately`);

    // Start processing asynchronously 
    setImmediate(async () => {
      try {
        // Use EmailProcessor with enrichment support
        const { EmailProcessor } = await import('../services/email-processor');
        const { prisma } = await import('../database/client');
        const processor = new EmailProcessor({
          prisma,
          userId,
          user: userRecord,
          sessionId: sessionRecord.id,
          year: parseInt(year),
          onProgress: (data: any) => {
            console.log('📊 [PROGRESS] EmailProcessor progress:', data.status, data.message || data.progress);
          },
          onBroadcast: async (userId: number, data: any) => {
            console.log('📡 [BROADCAST] Broadcasting progress:', data.status, data.message || data.progress);
            broadcastToStreams(userId, data);
            if (wsManager) {
              wsManager.broadcastScanStatus(userId, data);
            }

            // DISABLED: Old individual enrichment system - now using batch enrichment only
            // Update enrichment progress during scanning
            // if ((data.status === 'progress' || data.status === 'processing') && sessionManager) {
            //   console.log(`🔍 [DEBUG] Triggering enrichment stats update for user ${userId} (${data.status})`);
            //   await sessionManager.updateEnrichmentStats(userId).catch(err =>
            //     console.warn(`⚠️ Failed to update enrichment stats during scan:`, err?.message)
            //   );
            // }
          }
        });
        
        const emailIds = await processor.searchBookingEmails();
        
        // Use parallel processing for performance optimization
        const { getParallelProcessingConfig, calculatePerformanceImprovement } = await import('../config/parallel-processing');
        const parallelConfig = getParallelProcessingConfig();
        
        console.log(`🔍 [DEBUG] Parallel config check: enabled=${parallelConfig.enabled}, emailCount=${emailIds.length}`);
        console.log(`🔍 [DEBUG] Parallel config details:`, JSON.stringify(parallelConfig, null, 2));
        
        if (parallelConfig.enabled && emailIds.length > 0) {
          const perfEstimate = calculatePerformanceImprovement(parallelConfig, emailIds.length);
          console.log(`🚀 [CLEAN v5.0 + ENRICHMENT] Sequential Processing with ML + Gmail Rate Limiter + Background Enrichment:`);
          console.log(`   - Emails to process: ${emailIds.length}`);
          console.log(`   - ML Workers: Enabled (persistent processes)`);
          console.log(`   - Gmail Rate Limiter: 1 request/second`);
          console.log(`   - Enrichment: Background (non-blocking)`);
          
          await processor.processEmailsSequential(emailIds);
        } else {
          console.log(`📧 [CLEAN v5.0] Using sequential processing`);
          console.log(`   - Email count: ${emailIds.length}`);
          await processor.processEmailsSequential(emailIds);
        }
      } catch (error: any) {
        console.error(`❌ Background processing failed for session ${sessionRecord.id}:`, error);
        // Update session as failed
        await prisma.scanningSession.update({
          where: { id: sessionRecord.id },
          data: {
            status: 'failed',
            currentMessage: `❌ Processing failed: ${error.message}`,
            completedAt: new Date()
          }
        });
        
        // Broadcast error via WebSocket
        if (wsManager) {
          wsManager.broadcastScanStatus(userId, {
            status: 'failed',
            message: `❌ Processing failed: ${error.message}`,
            sessionId: sessionRecord.id
          });
        }
      }
    });

    res.json({
      success: true,
      message: 'Scanning started successfully',
      sessionId: sessionRecord.id,
      year: year,
      status: 'running'
    });

  } catch (error) {
    console.error('❌ Error starting scan-year:', error);
    res.status(500).json({ error: 'Failed to start scanning session' });
  }
});

/**
 * POST /api/quick-scan
 * Perform quick analysis to count potential booking confirmations by year
 */
router.post('/quick-scan', async (req: any, res: any) => {
  try {
    // Manual JWT token verification like other endpoints
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token provided' });
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
    const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
    if (!user) return res.status(401).json({ error: 'Invalid token' });
    
    console.log(`🔍 Quick scan requested by user ${user.id} (${user.email})`);

    const gmailClient = new GmailClient(user);
    
    // Check if user has valid Gmail access
    if (!(await gmailClient.hasValidAccess())) {
      return res.status(401).json({ 
        error: 'Gmail access required',
        needsAuth: true,
        authUrl: '/setup/gmail'
      });
    }

    const yearAnalysis: { [year: number]: number } = {};
    const currentYear = new Date().getFullYear();
    
    // Scan the last 6 years for potential booking confirmations
    for (let year = currentYear; year >= currentYear - 5; year--) {
      try {
        console.log(`📊 Quick scanning year ${year}...`);
        const emailIds = await gmailClient.searchAirbnbBookingEmails(year);
        yearAnalysis[year] = emailIds.length;
        console.log(`   Year ${year}: ${emailIds.length} potential confirmations`);
      } catch (error) {
        console.error(`❌ Error scanning year ${year}:`, error);
        yearAnalysis[year] = 0;
      }
    }

    // Calculate totals and recommendations
    const totalPotential = Object.values(yearAnalysis).reduce((sum, count) => sum + count, 0);
    const recommendedYears = Object.entries(yearAnalysis)
      .filter(([_, count]) => count > 0)
      .sort(([_, a], [__, b]) => b - a)
      .slice(0, 3)
      .map(([year, count]) => ({ year: parseInt(year), count }));

    // Estimate scanning time (rough estimate: 1-2 seconds per email)
    const timeEstimates = Object.fromEntries(
      Object.entries(yearAnalysis).map(([year, count]) => [
        year, 
        {
          count,
          estimatedMinutes: Math.ceil(count * 1.5 / 60) || 1, // 1.5 seconds per email, min 1 minute
          priority: count > 10 ? 'high' : count > 5 ? 'medium' : 'low'
        }
      ])
    );

    res.json({
      success: true,
      analysis: {
        totalPotentialBookings: totalPotential,
        yearBreakdown: yearAnalysis,
        timeEstimates,
        recommendations: {
          suggestedYears: recommendedYears,
          message: totalPotential > 0 
            ? `Hittade ${totalPotential} potentiella bokningar. Rekommenderar att börja med ${recommendedYears[0]?.year || currentYear}.`
            : 'Inga bokningsbekräftelser hittades. Kontrollera Gmail-anslutningen.'
        }
      },
      scanMetadata: {
        scannedYears: Object.keys(yearAnalysis).map(Number),
        scanTime: new Date().toISOString(),
        gmailConnected: true
      }
    });

  } catch (error: any) {
    console.error('❌ Quick scan error:', error);
    res.status(500).json({ 
      error: 'Quick scan failed',
      message: error.message,
      needsAuth: error.message.includes('authentication') || error.message.includes('401')
    });
  }
});

/**
 * POST /api/rescan-booking
 * Rescan a specific booking by its booking code
 */
router.post('/rescan-booking', async (req: any, res: any) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'No authentication token provided' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;

    const userId = decoded.userId;
    const { bookingCode } = req.body;

    if (!bookingCode) {
      return res.status(400).json({ error: 'Booking code is required' });
    }

    console.log(`🔄 Starting rescan for booking: ${bookingCode}`);

    // Get user for Gmail access
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Initialize Gmail client
    const { GmailClient } = require('../utils/gmail-client');
    const gmailClient = new GmailClient(user);

    // Search for emails related to this booking code
    const query = `from:automated@airbnb.com OR from:noreply@airbnb.com OR from:express@airbnb.com "${bookingCode}"`;
    console.log(`🔍 Searching Gmail with query: ${query}`);
    
    const emailIds = await gmailClient.searchEmails(query, 50);
    console.log(`📧 Found ${emailIds.length} emails for booking ${bookingCode}`);

    if (emailIds.length === 0) {
      return res.status(404).json({ 
        error: 'No emails found for this booking code',
        emailsFound: 0,
        processed: 0
      });
    }

    // Use BookingEnricher instead of manual ML parsing - this ensures we get the same 
    // robust enrichment process that works correctly with cancellations
    const { BookingEnricher } = require('../utils/booking-enricher');
    const enricher = new BookingEnricher(gmailClient, userId);

    let processedCount = 0;
    let bookingCreated = false;
    let bookingUpdated = false;
    let enrichmentRun = false;

    try {
      console.log(`🔄 Using BookingEnricher for comprehensive rescan of ${bookingCode}...`);
      
      // Check if booking exists before enrichment
      const existingBookingBefore = await prisma.booking.findFirst({
        where: { userId, bookingCode }
      });

      // Run the same enrichment process as the scanner and debug tool
      const enrichmentResult = await enricher.enrichBooking(bookingCode);
      
      // Check booking status after enrichment
      const existingBookingAfter = await prisma.booking.findFirst({
        where: { userId, bookingCode }
      });
      
      if (existingBookingAfter) {
        if (!existingBookingBefore) {
          bookingCreated = true;
          console.log(`🆕 BookingEnricher created new booking ${bookingCode}`);
        } else {
          bookingUpdated = true;
          console.log(`🔄 BookingEnricher updated existing booking ${bookingCode}`);
          
          // Check if status changed (e.g. to cancelled)
          if (existingBookingBefore.status !== existingBookingAfter.status) {
            console.log(`   Status changed: ${existingBookingBefore.status} → ${existingBookingAfter.status}`);
          }
        }
      }
      
      processedCount = enrichmentResult.emailsProcessed || emailIds.length;
      enrichmentRun = true;
      
      console.log(`✅ BookingEnricher rescan completed for ${bookingCode}: ${enrichmentResult.emailsProcessed}/${enrichmentResult.emailsFound} emails processed`);
      
    } catch (error) {
      console.error(`❌ BookingEnricher error for ${bookingCode}:`, error);
      throw error;
    }

    res.json({
      success: true,
      bookingCode,
      emailsFound: emailIds.length,
      processed: processedCount,
      bookingCreated,
      bookingUpdated: bookingUpdated && !bookingCreated,
      enrichmentRun,
      message: `Rescan completed for ${bookingCode}. Found ${emailIds.length} emails, processed ${processedCount}.`
    });

  } catch (error: any) {
    console.error('❌ Rescan booking error:', error);
    res.status(500).json({ 
      error: 'Rescan failed',
      message: error.message
    });
  }
});

/**
 * Helper function to filter result data for database insertion
 * Removes fields that are not in the Prisma schema
 */
function filterBookingData(result: any) {
  const { 
    rawEmailContent, 
    emailType,
    emailId,
    propertyName,
    hasTaxes,
    hostEarningsBeforeTaxEur,
    hostEarningsAfterTaxEur,
    hostEarningsBeforeTaxSek,
    hostEarningsAfterTaxSek,
    cleaningFeeBeforeTaxEur,
    cleaningFeeAfterTaxEur,
    cleaningFeeBeforeTaxSek,
    cleaningFeeAfterTaxSek,
    vatRate,
    taxDetails,
    ...filteredResult 
  } = result;
  
  // Convert date strings to Date objects for Prisma DateTime fields
  if (filteredResult.checkInDate && typeof filteredResult.checkInDate === 'string') {
    filteredResult.checkInDate = new Date(filteredResult.checkInDate);
  }
  if (filteredResult.checkOutDate && typeof filteredResult.checkOutDate === 'string') {
    filteredResult.checkOutDate = new Date(filteredResult.checkOutDate);
  }
  
  return filteredResult;
}

/**
 * Process emails for a year and broadcast progress via WebSocket
 */
async function processEmailsForYear(userId: number, year: number, sessionId: number, user: any) {
  console.log(`📧 Starting processEmailsForYear for user ${userId}, year ${year}, session ${sessionId}`);
  // This function is now handled by EmailProcessor in the main route
  console.log(`✅ Completed processEmailsForYear for user ${userId}, year ${year}`);
}

export default router;