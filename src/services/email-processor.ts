import { PrismaClient } from '@prisma/client';
import { MLEmailParser } from '../parsers/MLEmailParser';
import { GmailClient } from '../utils/gmail-client';
import { EmailHeaders } from '../types';
import { decodeGmailContent } from '../utils/email-decoder';
import { EmailLinkManager } from '../utils/email-link-manager';
import { BookingDataMerger } from '../utils/booking-data-merger';
import { bookingUpdateEmitter } from '../utils/booking-update-emitter';
import { wsManager } from '../services/websocket-manager';
import { sessionManager } from '../utils/persistent-session-manager';
import { BatchEnrichmentService } from './batch-enrichment';

export interface EmailProcessorOptions {
  prisma: PrismaClient;
  userId: number;
  user: any;
  sessionId: number;
  year: number;
  onProgress?: (data: any) => void;
  onBroadcast?: (userId: number, data: any) => void;
}

export interface ProcessingResult {
  processed: number;
  skipped: number;
  errors: number;
  totalEmails: number;
}

export class EmailProcessor {
  private prisma: PrismaClient;
  private userId: number;
  private user: any;
  private sessionId: number;
  private year: number;
  private onProgress?: (data: any) => void;
  private onBroadcast?: (userId: number, data: any) => void;
  private gmailClient: GmailClient;
  private parser: MLEmailParser;
  private newBookingCodes: Set<string> = new Set(); // Samla bokningskoder för batch enrichment

  constructor(options: EmailProcessorOptions) {
    this.prisma = options.prisma;
    this.userId = options.userId;
    this.user = options.user;
    this.sessionId = options.sessionId;
    this.year = options.year;
    this.onProgress = options.onProgress;
    this.onBroadcast = options.onBroadcast;
    
    this.gmailClient = new GmailClient(this.user);
    this.parser = new MLEmailParser(this.userId);
  }

  async searchBookingEmails(): Promise<string[]> {
    console.log(`🎯 Searching for booking confirmations only (enricher handles the rest)...`);
    const allEmailIds = await this.gmailClient.searchAirbnbBookingEmails(this.year);
    console.log(`📧 Found ${allEmailIds.length} booking confirmation emails`);
    return allEmailIds;
  }

  async updateSessionWithEmailCount(totalEmails: number): Promise<void> {
    await this.prisma.scanningSession.update({
      where: { id: this.sessionId },
      data: {
        totalEmails: totalEmails,
        currentMessage: `📧 Hittade ${totalEmails} booking confirmation emails för ${this.year}`,
        currentStep: 'searching',
        lastUpdateAt: new Date()
      }
    });

    this.emitProgress({
      status: 'searching',
      message: `📧 Hittade ${totalEmails} booking confirmation emails för ${this.year}`
    });
  }

  async processEmailsSequential(emailIds: string[]): Promise<ProcessingResult> {
    console.log(`🚀 [CLEAN v5.0 + ENRICHMENT] Sequential processing with ML workers + Gmail rate limiter + background enrichment - ${emailIds.length} emails`);
    
    if (emailIds.length === 0) {
      await this.completeSession(0, 0, 0, 0);
      return { processed: 0, skipped: 0, errors: 0, totalEmails: 0 };
    }

    console.log(`🚀 Starting SEQUENTIAL email processing: ${emailIds.length} emails`);

    this.emitProgress({
      status: 'processing',
      message: `🔄 Börjar bearbetning av ${emailIds.length} emails...`
    });

    let processed = 0;
    let skipped = 0;
    let errors = 0;
    const linkManager = new EmailLinkManager();

    // Filter out already processed emails first
    const unprocessedEmailIds = await this.filterUnprocessedEmails(emailIds);
    console.log(`📋 Filtered emails: ${unprocessedEmailIds.length}/${emailIds.length} need processing`);
    
    skipped = emailIds.length - unprocessedEmailIds.length;
    
    if (unprocessedEmailIds.length === 0) {
      console.log('✅ All emails already processed, skipping');
      await this.completeSession(emailIds.length, 0, skipped, 0);
      return { processed: 0, skipped, errors: 0, totalEmails: emailIds.length };
    }

    // Process emails sequentially with Gmail rate limiting
    for (let i = 0; i < unprocessedEmailIds.length; i++) {
      // Check if scanning has been stopped
      const session = await this.prisma.scanningSession.findUnique({
        where: { id: this.sessionId },
        select: { status: true }
      });
      
      if (session?.status === 'cancelled') {
        console.log(`🛑 Scanning stopped by user (session ${this.sessionId})`);
        break;
      }

      const emailId = unprocessedEmailIds[i];
      const progress = i + 1;
      const total = unprocessedEmailIds.length;
      
      console.log(`📧 Processing email ${progress}/${total}: ${emailId}`);
      
      this.emitProgress({
        status: 'processing',
        message: `📧 Bearbetar email ${progress}/${total}...`
      });
      
      try {

        // Fetch email via Gmail Rate Limiter (1 request/second)
        console.log(`🔄 [v5.0] Fetching email via rate limiter: ${emailId}`);
        const email = await this.gmailClient.getEmail(emailId);

        if (!email) {
          console.log(`⚠️ Could not fetch email ${emailId}`);
          errors++;
          continue;
        }

        // Process email with ML parser
        console.log(`🧠 [v5.0] Processing with ML parser: ${emailId}`);
        const result = await this.processSingleEmail(email, linkManager);
        console.log(`🔍 [DEBUG] processSingleEmail returned: ${JSON.stringify({ success: result.success, error: result.error })}`);

        if (result.success) {
          processed++;
          console.log(`✅ Email ${processed}/${emailIds.length} processed successfully`);
        } else {
          errors++;
          console.log(`❌ Email ${processed + errors}/${emailIds.length} failed: ${result.error}`);
        }

        console.log(`🔍 [DEBUG] About to update progress for email ${progress}/${total}`);

        // Update progress every email
        const progressData = {
          current: processed + skipped + errors,
          total: emailIds.length,
          processed,
          skipped,
          errors
        };

        const progressMessage = {
          status: 'progress',
          message: `📧 ${processed + skipped + errors}/${emailIds.length} emails bearbetade (${processed} lyckade, ${errors} fel)`,
          progress: progressData
        };

        console.log('🔍 [DEBUG] Sending progress to frontend:', JSON.stringify(progressMessage));
        this.emitProgress(progressMessage);

        console.log(`🔍 [DEBUG] Progress emitted for email ${progress}/${total}, about to continue to next email`);

      } catch (error) {
        console.error(`❌ Error processing email ${emailId}:`, error);
        errors++;
      }

      console.log(`🔍 [DEBUG] End of loop iteration for email ${progress}/${total}, moving to next email...`);
    }

    console.log(`📊 Sequential processing completed:`);
    console.log(`   - Total emails: ${emailIds.length}`);
    console.log(`   - Processed: ${processed}`);
    console.log(`   - Skipped: ${skipped}`);
    console.log(`   - Errors: ${errors}`);

    // Run batch enrichment after scanning is complete
    await this.runBatchEnrichment();

    await this.completeSession(emailIds.length, processed, skipped, errors);
    return { processed, skipped, errors, totalEmails: emailIds.length };
  }

  async processEmails(emailIds: string[]): Promise<ProcessingResult> {
    if (emailIds.length === 0) {
      await this.completeSession(0, 0, 0, 0);
      return { processed: 0, skipped: 0, errors: 0, totalEmails: 0 };
    }

    this.emitProgress({
      status: 'processing',
      message: `⚡ Börjar bearbeta ${emailIds.length} emails...`
    });

    let processed = 0;
    let skipped = 0;
    let errors = 0;
    const linkManager = new EmailLinkManager();

    for (let i = 0; i < emailIds.length; i++) {
      const emailId = emailIds[i];
      
      try {
        // Check if scanning has been stopped by user
        const session = await this.prisma.scanningSession.findUnique({
          where: { id: this.sessionId },
          select: { status: true }
        });
        
        if (session?.status === 'cancelled') {
          console.log(`🛑 Scanning stopped by user (session ${this.sessionId})`);
          break;
        }
        
        const progress = {
          current: processed + skipped + errors,
          total: emailIds.length,
          processed,
          skipped,
          errors
        };

        // Check if email was already processed
        const existingBooking = await this.prisma.booking.findFirst({
          where: {
            userId: this.userId,
            gmailId: emailId
          }
        });

        if (existingBooking) {
          skipped++;
          this.emitProgress({
            status: 'progress',
            message: `⏭️  Hoppade över redan bearbetad email (${processed + skipped + errors}/${emailIds.length})`,
            progress
          });
          continue;
        }

        // Get email content
        const email = await this.gmailClient.getEmail(emailId);
        
        // Extract text content
        const emailContent = this.extractEmailContent(email);
        
        // Extract headers for ML parser
        const headers = this.extractEmailHeaders(email);
        
        // Parse with AI
        const bookingData = await this.parser.parseBookingEmail({
          emailId: emailId,
          rawEmailContent: emailContent,
          gmailId: emailId,
          gmailThreadId: email.threadId,
          headers: headers || undefined
        });

        if (bookingData && bookingData.bookingCode) {
          const result = await this.processBookingData(bookingData, emailId, email, headers);
          if (result) {
            processed++;
          } else {
            errors++;
          }
        } else {
          console.log(`⚠️ No booking code found in email ${emailId}`);
          errors++;
        }

        // Update progress
        const finalProgress = {
          current: processed + skipped + errors,
          total: emailIds.length,
          processed,
          skipped,
          errors
        };

        this.emitProgress({
          status: 'progress',
          message: `📧 Bearbetade ${processed + skipped + errors}/${emailIds.length} emails`,
          progress: finalProgress
        });

      } catch (error) {
        console.error(`❌ Error processing email ${emailId}:`, error);
        errors++;
      }
    }

    // Run batch enrichment after scanning is complete
    await this.runBatchEnrichment();

    await this.completeSession(emailIds.length, processed, skipped, errors);
    return { processed, skipped, errors, totalEmails: emailIds.length };
  }

  /**
   * Filter emails that haven't been processed yet (batch optimization)
   */
  private async filterUnprocessedEmails(emailIds: string[]): Promise<string[]> {
    const existingBookings = await this.prisma.booking.findMany({
      where: {
        userId: this.userId,
        gmailId: { in: emailIds }
      },
      select: { gmailId: true }
    });

    const processedIds = new Set(existingBookings.map(b => b.gmailId).filter(id => id));
    return emailIds.filter(id => !processedIds.has(id));
  }

  /**
   * Process a single email (extracted from the main loop for parallel processing)
   */
  private async processSingleEmail(email: any, linkManager: EmailLinkManager): Promise<{ success: boolean; error?: any }> {
    try {
      // Extract text content
      const emailContent = this.extractEmailContent(email);
      
      // Extract headers for ML parser
      const headers = this.extractEmailHeaders(email);
      
      // [CLEAN v5.0] Parse with ML, enrich in background
      console.log(`🧠 [CLEAN v5.0] Using ML parser for email ${email.id}`);
      const bookingData = await this.parser.parseBookingEmail({
        emailId: email.id,
        rawEmailContent: emailContent,
        gmailId: email.id,
        gmailThreadId: email.threadId,
        headers: headers || undefined
      });

      if (bookingData && bookingData.bookingCode) {
        const result = await this.processBookingData(bookingData, email.id, email, headers);
        return { success: result };
      } else {
        console.log(`⚠️ No booking code found in email ${email.id}`);
        return { success: false, error: 'No booking code found' };
      }
    } catch (error) {
      console.error(`❌ Error processing single email ${email.id}:`, error);
      return { success: false, error };
    }
  }

  private async processBookingData(bookingData: any, emailId: string, email: any, headers: EmailHeaders | null): Promise<boolean> {
    try {
      console.log(`🔍 [DEBUG] processBookingData starting for booking ${bookingData.bookingCode}`);

      // Update session with current booking being processed (non-blocking with timeout)
      console.log(`🔍 [DEBUG] Updating scanning session with current booking code ${bookingData.bookingCode}`);
      try {
        const sessionUpdatePromise = this.prisma.scanningSession.update({
          where: { id: this.sessionId },
          data: {
            currentBookingCode: bookingData.bookingCode,
            lastUpdateAt: new Date()
          }
        });

        // Add 5 second timeout to prevent hanging
        await Promise.race([
          sessionUpdatePromise,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Session update timeout')), 5000)
          )
        ]);
        console.log(`🔍 [DEBUG] Scanning session updated successfully`);
      } catch (error) {
        console.error(`⚠️ [DEBUG] Session update failed (non-critical):`, error instanceof Error ? error.message : String(error));
        // Continue processing - session update failure should not block email processing
      }

      // Check if booking exists
      console.log(`🔍 [DEBUG] Checking if booking ${bookingData.bookingCode} exists in database`);
      const existingBooking = await this.prisma.booking.findFirst({
        where: {
          userId: this.userId,
          bookingCode: bookingData.bookingCode
        }
      });
      console.log(`🔍 [DEBUG] Database query completed: ${existingBooking ? 'booking exists' : 'booking does not exist'}`);


      console.log(`🔍 [ENRICHMENT DEBUG] Booking ${bookingData.bookingCode}: ${existingBooking ? 'EXISTS' : 'NEW'}`);
      if (existingBooking) {
        console.log(`   Current enrichmentStatus: ${existingBooking.enrichmentStatus}`);
      }

      if (existingBooking) {
        // Update existing booking
        const updatedBooking = await this.prisma.booking.update({
          where: { id: existingBooking.id },
          data: {
            ...this.filterBookingData(bookingData),
            userId: this.userId,
            gmailId: emailId,
            gmailThreadId: email.threadId,
            emailDate: new Date(parseInt(email.internalDate)),
            updatedAt: new Date(),
            parseAttempts: { increment: 1 }
          }
        });

        console.log(`🔄 Updated existing booking ${bookingData.bookingCode}`);

        // Mark ALL existing bookings for batch enrichment during scanning
        console.log(`🔍 [BATCH ENRICHMENT] Existing booking marked for batch enrichment: ${bookingData.bookingCode}`);
        this.newBookingCodes.add(bookingData.bookingCode);

        // Emit booking update event
        try {
          await bookingUpdateEmitter.emitBookingUpdated(this.userId, updatedBooking, {}, this.sessionId);
        } catch (emitError) {
          console.error('❌ Failed to emit booking update event:', emitError);
        }

        // Broadcast via WebSocket
        if (wsManager) {
          wsManager.broadcastBookingUpdated(this.userId, updatedBooking);
        }

      } else {
        // Create new booking
        const newBooking = await this.prisma.booking.create({
          data: {
            ...this.filterBookingData(bookingData),
            userId: this.userId,
            gmailId: emailId,
            gmailThreadId: email.threadId,
            emailDate: new Date(parseInt(email.internalDate)),
          }
        });

        console.log(`✅ Created new booking ${bookingData.bookingCode}`);

        // Emit booking created event
        try {
          await bookingUpdateEmitter.emitBookingCreated(this.userId, newBooking, this.sessionId);
        } catch (emitError) {
          console.error('❌ Failed to emit booking created event:', emitError);
        }

        // Broadcast via WebSocket
        if (wsManager) {
          wsManager.broadcastBookingCreated(this.userId, newBooking);
        }

        // Mark new booking for batch enrichment
        console.log(`🔍 [BATCH ENRICHMENT] New booking marked for batch enrichment: ${bookingData.bookingCode}`);
        this.newBookingCodes.add(bookingData.bookingCode);
      }

      // Save email link for this booking
      if (bookingData.gmailId) {
        await this.saveMainEmailLink(existingBooking?.id || (await this.prisma.booking.findFirst({
          where: { userId: this.userId, bookingCode: bookingData.bookingCode }
        }))?.id, bookingData, headers);
      }

      return true;
    } catch (error) {
      console.error(`❌ Error processing booking data:`, error);
      return false;
    }
  }

  /**
   * Kör batch enrichment för alla insamlade bokningskoder
   */
  async runBatchEnrichment(): Promise<void> {
    if (this.newBookingCodes.size === 0) {
      console.log(`📦 [BATCH ENRICHMENT] No booking codes to enrich, skipping batch enrichment`);
      return;
    }

    const bookingCodes = Array.from(this.newBookingCodes);
    console.log(`🚀 [BATCH ENRICHMENT] Starting batch enrichment for ${bookingCodes.length} NEW booking codes: ${bookingCodes.join(', ')}`);

    try {
      const batchEnrichmentService = new BatchEnrichmentService(
        this.gmailClient,
        this.userId,
        this.sessionId.toString()
      );

      // Progress callback to update session manager with enrichment stats
      const onProgress = (progress: any) => {
        console.log(`📊 [BATCH ENRICHMENT] Progress: ${progress.phase} - Batch ${progress.currentBatch}/${progress.totalBatches}, Email ${progress.currentEmail}/${progress.totalEmails}, Enriched ${progress.bookingsEnriched}/${progress.totalBookings}`);

        // Broadcast enrichment progress via WebSocket
        if (wsManager) {
          wsManager.broadcastScanProgress(this.userId, {
            enrichment: {
              total: progress.totalBookings,
              completed: progress.bookingsEnriched,
              inProgress: Math.max(0, progress.currentEmail - progress.bookingsEnriched),
              percentage: Math.round((progress.bookingsEnriched / progress.totalBookings) * 100),
              message: `🧠 Enriching: ${progress.bookingsEnriched}/${progress.totalBookings} bookings completed${progress.currentEmail > progress.bookingsEnriched ? ` (${progress.currentEmail - progress.bookingsEnriched} in progress...)` : ''}`
            }
          });
        }
      };

      const result = await batchEnrichmentService.batchEnrichBookings(bookingCodes, onProgress);

      console.log(`✅ [BATCH ENRICHMENT] Completed: ${result.totalEmailsProcessed} emails processed, ${result.errors.length} errors in ${result.executionTime}ms`);

      // Broadcast final enrichment stats
      if (wsManager) {
        wsManager.broadcastScanProgress(this.userId, {
          enrichment: {
            total: bookingCodes.length,
            completed: bookingCodes.length,
            inProgress: 0,
            percentage: 100,
            message: `🧠 Enrichment completed: ${bookingCodes.length}/${bookingCodes.length} bookings enriched`
          }
        });
      }

      // Clear the booking codes set for next run
      this.newBookingCodes.clear();

    } catch (error: any) {
      console.error(`❌ [BATCH ENRICHMENT] Error: ${error?.message}`);
      console.error(error);

      // Clear the set even on error to prevent retry loops
      this.newBookingCodes.clear();
    }
  }

  private async completeSession(totalEmails: number, processed: number, skipped: number, errors: number): Promise<void> {
    const message = totalEmails === 0 
      ? '✅ Inga nya emails hittades för den valda perioden.'
      : `✅ Slutfört! Bearbetade ${processed} emails, hoppade över ${skipped}, ${errors} fel.`;

    await this.prisma.scanningSession.update({
      where: { id: this.sessionId },
      data: {
        status: 'completed',
        totalEmails,
        processedEmails: processed,
        skippedEmails: skipped,
        errorEmails: errors,
        currentMessage: message,
        currentStep: 'completed',
        completedAt: new Date()
      }
    });

    this.emitProgress({
      status: 'completed',
      message,
      processed,
      skipped,
      errors
    });
  }

  private emitProgress(data: any): void {
    if (this.onProgress) {
      this.onProgress(data);
    }
    if (this.onBroadcast) {
      this.onBroadcast(this.userId, data);
    }
  }

  private extractEmailContent(email: any): string {
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
    if (email.payload.parts) {
      let allContent = '';
      for (const part of email.payload.parts) {
        allContent += extractFromPart(part);
      }
      console.log(`[DEBUG] Total extracted content: ${allContent.length} chars from ${email.payload.parts.length} parts`);
      return allContent;
    }
    
    // Single part email
    if (email.payload.body?.data) {
      // Use simple base64 decode like ML tests for better content preservation
      const content = Buffer.from(email.payload.body.data, 'base64').toString('utf-8');
      console.log(`[DEBUG] Single part content: ${content.length} chars`);
      return content;
    }
    
    return '';
  }

  private extractEmailHeaders(email: any): EmailHeaders | null {
    if (!email.payload?.headers) return null;

    const headers: EmailHeaders = {
      subject: '',
      from: '',
      to: '',
      date: '',
      messageId: ''
    };

    for (const header of email.payload.headers) {
      switch (header.name.toLowerCase()) {
        case 'subject':
          headers.subject = header.value;
          break;
        case 'from':
          headers.from = header.value;
          break;
        case 'to':
          headers.to = header.value;
          break;
        case 'date':
          headers.date = header.value;
          break;
        case 'message-id':
          headers.messageId = header.value;
          break;
      }
    }

    return headers;
  }

  private filterBookingData(data: any): any {
    // Filter out undefined/null values and format data for database
    const filtered: any = {};
    
    // Copy defined fields only
    const fields = [
      'bookingCode', 'guestName', 'checkInDate', 'checkOutDate', 'nights',
      'guestTotalEur', 'hostEarningsEur', 'cleaningFeeEur', 'serviceFeeEur', 'occupancyTaxEur',
      'guestTotalSek', 'hostEarningsSek', 'cleaningFeeSek', 'serviceFeeSek', 'occupancyTaxSek',
      'exchangeRate', 'status', 'aiModel', 'confidence'
    ];

    for (const field of fields) {
      if (data[field] !== undefined && data[field] !== null) {
        filtered[field] = data[field];
      }
    }

    // DEBUG: Log date conversion process
    if (filtered.checkInDate) {
      console.log(`🐛 [DATE DEBUG] EmailProcessor.filterBookingData for ${filtered.bookingCode}:`);
      console.log(`   Input checkInDate: ${filtered.checkInDate} (type: ${typeof filtered.checkInDate})`);
    }

    // Convert date strings to Date objects for Prisma DateTime fields
    if (filtered.checkInDate && typeof filtered.checkInDate === 'string') {
      const originalDate = filtered.checkInDate;
      filtered.checkInDate = new Date(filtered.checkInDate);
      console.log(`   Converted "${originalDate}" to Date: ${filtered.checkInDate} (${filtered.checkInDate.toISOString()})`);
    }
    if (filtered.checkOutDate && typeof filtered.checkOutDate === 'string') {
      const originalDate = filtered.checkOutDate;
      filtered.checkOutDate = new Date(filtered.checkOutDate);
      console.log(`   Converted "${originalDate}" to Date: ${filtered.checkOutDate} (${filtered.checkOutDate.toISOString()})`);
    }

    // Set defaults for required fields
    filtered.status = filtered.status || 'confirmed';
    filtered.enrichmentStatus = 'scanning';
    filtered.enrichmentProgress = 0;
    filtered.enrichmentTotal = 0;
    filtered.hasChanges = false;
    filtered.changeCount = 0;
    filtered.parseAttempts = 1;

    return filtered;
  }

  /**
   * Fallback email parsing without ML workers (TEST v3.0)
   */
  private async fallbackParseBookingEmail(emailContent: string, emailId: string): Promise<any> {
    console.log(`📝 [FALLBACK v3.0] Parsing email ${emailId} with simple regex extraction`);
    
    // Simple regex-based booking code extraction
    const bookingCodeMatch = emailContent.match(/(?:booking|reservation|confirmation)[\s#]*:?\s*([A-Z0-9]{6,12})/i);
    
    if (bookingCodeMatch) {
      const bookingCode = bookingCodeMatch[1];
      console.log(`✅ [FALLBACK v3.0] Found booking code: ${bookingCode}`);
      
      // Return minimal booking data structure
      return {
        bookingCode,
        emailType: 'confirmation',
        confidence: 0.8,
        gmailId: emailId,
        // Add some basic extracted data if possible
        guestName: this.extractGuestName(emailContent),
        checkInDate: this.extractDate(emailContent, 'check.*in'),
        checkOutDate: this.extractDate(emailContent, 'check.*out')
      };
    }
    
    console.log(`❌ [FALLBACK v3.0] No booking code found in email ${emailId}`);
    return null;
  }

  private extractGuestName(content: string): string | null {
    const nameMatch = content.match(/(?:guest|name|hello|dear)[\s:]*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
    return nameMatch ? nameMatch[1] : null;
  }

  private extractDate(content: string, pattern: string): string | null {
    const regex = new RegExp(pattern + '[\\s:]*([0-9]{1,2}[/-][0-9]{1,2}[/-][0-9]{2,4})', 'i');
    const match = content.match(regex);
    return match ? match[1] : null;
  }

  private async saveMainEmailLink(bookingId: number | undefined, bookingData: any, headers: EmailHeaders | null): Promise<void> {
    if (!bookingId) return;

    try {
      await EmailLinkManager.addEmailLink({
        bookingId,
        gmailId: bookingData.gmailId,
        gmailThreadId: bookingData.gmailThreadId,
        subject: headers?.subject || 'Unknown',
        emailDate: headers?.date ? new Date(headers.date) : new Date(),
        emailType: 'confirmation'
      });
    } catch (error) {
      console.error('❌ Failed to save email link:', error);
    }
  }
}