import { PrismaClient } from '@prisma/client';
import { MLEmailParser } from '../parsers/MLEmailParser';
import { GmailClient } from '../utils/gmail-client';
import { EmailHeaders } from '../types';
import { decodeGmailContent } from '../utils/email-decoder';
import { EmailLinkManager } from '../utils/email-link-manager';
import { BookingDataMerger } from '../utils/booking-data-merger';
import { bookingUpdateEmitter } from '../utils/booking-update-emitter';
import { wsManager } from '../services/websocket-manager';

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

    await this.completeSession(emailIds.length, processed, skipped, errors);
    return { processed, skipped, errors, totalEmails: emailIds.length };
  }

  private async processBookingData(bookingData: any, emailId: string, email: any, headers: EmailHeaders | null): Promise<boolean> {
    try {
      // Update session with current booking being processed
      await this.prisma.scanningSession.update({
        where: { id: this.sessionId },
        data: {
          currentBookingCode: bookingData.bookingCode,
          lastUpdateAt: new Date()
        }
      });

      // Check if booking exists
      const existingBooking = await this.prisma.booking.findFirst({
        where: {
          userId: this.userId,
          bookingCode: bookingData.bookingCode
        }
      });

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

        // Check if enrichment is needed for existing booking
        if (existingBooking.enrichmentStatus === 'scanning' || existingBooking.enrichmentStatus === 'pending') {
          console.log(`🔍 [ENRICHMENT DEBUG] Existing booking needs enrichment: ${bookingData.bookingCode}`);
          await this.enrichBooking(updatedBooking, bookingData);
        }

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

        // Inline enrichment: First time seeing this booking code, enrich it immediately
        await this.enrichBooking(newBooking, bookingData);
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

  private async enrichBooking(booking: any, bookingData: any): Promise<void> {
    try {
      console.log(`🔍 [ENRICHMENT DEBUG] Starting enrichment for ${bookingData.bookingCode}...`);
      
      // Update status to 'enriching' before starting enrichment
      const enrichingBooking = await this.prisma.booking.update({
        where: { id: booking.id },
        data: {
          enrichmentStatus: 'enriching',
          enrichmentProgress: 0
        }
      });
      
      // Broadcast enriching status update
      if (wsManager) {
        wsManager.broadcastBookingUpdated(this.userId, enrichingBooking);
      }
      
      const { BookingEnricher } = await import('../utils/booking-enricher');
      const enricher = new BookingEnricher(this.gmailClient, this.userId);
      console.log(`🔍 [ENRICHMENT DEBUG] Creating enricher with Gmail client: ${this.gmailClient ? 'YES' : 'NO'}`);
      const enrichmentResult = await enricher.enrichBooking(bookingData.bookingCode);
      
      // Get the updated booking to check final status after enrichment
      const updatedBooking = await this.prisma.booking.findUnique({
        where: { id: booking.id }
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
      const finalBooking = await this.prisma.booking.update({
        where: { id: booking.id },
        data: {
          enrichmentStatus: finalStatus,
          enrichmentProgress: enrichmentResult.emailsProcessed || 0,
          enrichmentTotal: enrichmentResult.emailsFound || 0
        }
      });
      
      // Broadcast enrichment completion
      if (wsManager) {
        wsManager.broadcastBookingUpdated(this.userId, finalBooking);
      }
      
      console.log(`✅ Enrichment completed for ${bookingData.bookingCode}: ${finalStatus}`);
      
    } catch (enrichmentError) {
      console.error(`❌ Failed to enrich booking ${bookingData.bookingCode}:`, enrichmentError);
      
      // Update status to 'error' if enrichment fails
      await this.prisma.booking.update({
        where: { id: booking.id },
        data: {
          enrichmentStatus: 'error'
        }
      });
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