/**
 * Batch Enrichment Service
 * ========================
 *
 * Höpprestanda batch enrichment som använder parenthesized OR queries
 * för att minimera Gmail API-anrop och undvika rate limits.
 *
 * Baserat på POC-resultat:
 * - Parenthesized OR: 50% snabbare än individuella sökningar
 * - 100% accuracy med korrekt syntax
 * - Dramatisk minskning av rate limit-risk
 */

import { GmailClient, GmailMessage } from '../utils/gmail-client';
import { prisma } from '../database/client';
import { parseEmailWithML } from '../parsers/ml-parser';
import { EmailHeaders } from '../types';
import { gmailRateLimiter } from '../utils/gmail-rate-limiter';
import { BookingDataMerger } from '../utils/booking-data-merger';
import { bookingUpdateEmitter } from '../utils/booking-update-emitter';
import { EmailLinkManager } from '../utils/email-link-manager';
import { wsManager } from './websocket-manager';

export interface BatchEnrichmentResult {
  totalBookingsProcessed: number;
  totalEmailsFound: number;
  totalEmailsProcessed: number;
  batchesProcessed: number;
  totalBatches: number;
  errors: string[];
  executionTime: number;
}

export interface BatchEnrichmentProgress {
  phase: 'batching' | 'searching' | 'processing' | 'completed';
  currentBatch: number;
  totalBatches: number;
  currentEmail: number;
  totalEmails: number;
  bookingsEnriched: number;
  totalBookings: number;
}

export class BatchEnrichmentService {
  private readonly BATCH_SIZE = 12; // Optimal batch size based on POC
  private readonly MAX_RESULTS_PER_BATCH = 100; // Gmail API limit safety

  constructor(
    private gmailClient: GmailClient,
    private userId: number,
    private sessionId: string
  ) {}

  /**
   * Huvudmetod: Batch enrichment av alla bokningskoder
   */
  async batchEnrichBookings(
    bookingCodes: string[],
    onProgress?: (progress: BatchEnrichmentProgress) => void
  ): Promise<BatchEnrichmentResult> {
    const startTime = Date.now();

    console.log(`🚀 [BATCH ENRICHMENT] Starting batch enrichment for ${bookingCodes.length} booking codes`);

    const result: BatchEnrichmentResult = {
      totalBookingsProcessed: bookingCodes.length,
      totalEmailsFound: 0,
      totalEmailsProcessed: 0,
      batchesProcessed: 0,
      totalBatches: 0,
      errors: [],
      executionTime: 0
    };

    try {
      // Dela upp bokningskoder i batches
      const batches = this.chunkArray(bookingCodes, this.BATCH_SIZE);
      result.totalBatches = batches.length;

      console.log(`📦 [BATCH ENRICHMENT] Created ${batches.length} batches of ${this.BATCH_SIZE} booking codes each`);

      onProgress?.({
        phase: 'batching',
        currentBatch: 0,
        totalBatches: batches.length,
        currentEmail: 0,
        totalEmails: 0,
        bookingsEnriched: 0,
        totalBookings: bookingCodes.length
      });

      // Processar varje batch sekventiellt för att undvika rate limits
      for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = batches[batchIndex];

        console.log(`🔍 [BATCH ENRICHMENT] Processing batch ${batchIndex + 1}/${batches.length} with ${batch.length} booking codes`);

        onProgress?.({
          phase: 'searching',
          currentBatch: batchIndex + 1,
          totalBatches: batches.length,
          currentEmail: 0,
          totalEmails: 0,
          bookingsEnriched: result.totalEmailsProcessed,
          totalBookings: bookingCodes.length
        });

        try {
          const batchResult = await this.processBatch(batch, batchIndex + 1, onProgress);

          result.totalEmailsFound += batchResult.emailsFound;
          result.totalEmailsProcessed += batchResult.emailsProcessed;
          result.batchesProcessed++;

          console.log(`✅ [BATCH ENRICHMENT] Batch ${batchIndex + 1} completed: ${batchResult.emailsFound} emails found, ${batchResult.emailsProcessed} processed`);

        } catch (error) {
          const errorMsg = `Batch ${batchIndex + 1} failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
          console.error(`❌ [BATCH ENRICHMENT] ${errorMsg}`);
          result.errors.push(errorMsg);
        }

        // Rate limiting delay mellan batches
        if (batchIndex < batches.length - 1) {
          console.log(`⏳ [BATCH ENRICHMENT] Waiting 2s before next batch...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }

    } catch (error) {
      const errorMsg = `Batch enrichment failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      console.error(`❌ [BATCH ENRICHMENT] ${errorMsg}`);
      result.errors.push(errorMsg);
    }

    result.executionTime = Date.now() - startTime;

    console.log(`🏁 [BATCH ENRICHMENT] Completed in ${result.executionTime}ms`);
    console.log(`📊 [BATCH ENRICHMENT] Results: ${result.totalEmailsFound} emails found, ${result.totalEmailsProcessed} processed, ${result.errors.length} errors`);

    onProgress?.({
      phase: 'completed',
      currentBatch: result.totalBatches,
      totalBatches: result.totalBatches,
      currentEmail: result.totalEmailsFound,
      totalEmails: result.totalEmailsFound,
      bookingsEnriched: result.totalEmailsProcessed,
      totalBookings: bookingCodes.length
    });

    return result;
  }

  /**
   * Processar en batch av bokningskoder
   */
  private async processBatch(
    bookingCodes: string[],
    batchNumber: number,
    onProgress?: (progress: BatchEnrichmentProgress) => void
  ): Promise<{ emailsFound: number; emailsProcessed: number }> {

    // Skapa parenthesized OR query (enligt POC)
    const query = `("${bookingCodes.join('" OR "')}") AND (from:automated@airbnb.com OR from:noreply@airbnb.com OR from:express@airbnb.com)`;

    console.log(`   🔍 [BATCH ${batchNumber}] Query: ${query}`);

    // Utför batch-sökning
    const emailIds = await gmailRateLimiter.queueRequest(() =>
      this.gmailClient.searchEmails(query, this.MAX_RESULTS_PER_BATCH)
    );

    console.log(`   📧 [BATCH ${batchNumber}] Found ${emailIds.length} emails`);

    if (emailIds.length === 0) {
      return { emailsFound: 0, emailsProcessed: 0 };
    }

    // Processar varje email
    let emailsProcessed = 0;

    for (let emailIndex = 0; emailIndex < emailIds.length; emailIndex++) {
      const emailId = emailIds[emailIndex];

      onProgress?.({
        phase: 'processing',
        currentBatch: batchNumber,
        totalBatches: 0, // Will be set by caller
        currentEmail: emailIndex + 1,
        totalEmails: emailIds.length,
        bookingsEnriched: emailsProcessed,
        totalBookings: bookingCodes.length
      });

      try {
        const processed = await this.processEmail(emailId, bookingCodes);
        if (processed) {
          emailsProcessed++;
        }
      } catch (error) {
        console.error(`   ⚠️ [BATCH ${batchNumber}] Failed to process email ${emailId}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    return { emailsFound: emailIds.length, emailsProcessed };
  }

  /**
   * Processar ett enskilt email
   */
  private async processEmail(emailId: string, relevantBookingCodes: string[]): Promise<boolean> {
    try {
      // Kolla om vi redan processerat detta mejl
      const existingBooking = await prisma.booking.findFirst({
        where: {
          userId: this.userId,
          gmailId: emailId
        }
      });

      if (existingBooking) {
        console.log(`   ⏭️ Email ${emailId} already processed for ${existingBooking.bookingCode}`);
        return false;
      }

      // Hämta email från Gmail
      const email = await gmailRateLimiter.queueRequest(() =>
        this.gmailClient.getEmail(emailId)
      );

      if (!email) {
        console.error(`   ❌ Could not fetch email ${emailId}`);
        return false;
      }

      // Extrahera headers och innehåll
      const headers = this.extractEmailHeaders(email);
      const rawContent = this.extractRawContent(email);

      if (!rawContent || !headers) {
        console.error(`   ❌ Could not extract content or headers from email ${emailId}`);
        return false;
      }

      // Parsa med ML
      const parsedData = await parseEmailWithML(
        headers.subject || '',
        headers.from || '',
        rawContent,
        this.userId,
        headers.date
      );

      if (!parsedData?.bookingCode) {
        console.log(`   ⚠️ No booking code found in email ${emailId}`);
        return false;
      }

      // Verifiera att bokningskoden är relevant för denna batch
      if (!relevantBookingCodes.includes(parsedData.bookingCode)) {
        console.log(`   ⚠️ Email ${emailId} belongs to ${parsedData.bookingCode}, not in current batch`);
        return false;
      }

      // Skip booking_confirmation och booking_reminder under enrichment
      if (parsedData.emailType === 'booking_confirmation' || parsedData.emailType === 'booking_reminder') {
        console.log(`   ⏭️ SKIPPING ${parsedData.emailType} during enrichment - already processed in initial scan`);
        return false;
      }

      console.log(`   📋 Processing ${parsedData.emailType} for ${parsedData.bookingCode} (email: ${emailId})`);

      // Uppdatera bokningen med enriched data
      await this.upsertEnrichedBooking(parsedData, emailId, email.threadId);

      return true;

    } catch (error) {
      console.error(`   ❌ Error processing email ${emailId}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return false;
    }
  }

  /**
   * Skapa eller uppdatera bokning med enriched data
   */
  private async upsertEnrichedBooking(parsedData: any, emailId: string, threadId: string): Promise<void> {
    try {
      const existingBooking = await prisma.booking.findFirst({
        where: {
          userId: this.userId,
          bookingCode: parsedData.bookingCode
        }
      });

      // Convert Prisma booking dates to string format for BookingDataMerger
      const existingForMerge = existingBooking ? {
        ...existingBooking,
        checkInDate: existingBooking.checkInDate?.toISOString().split('T')[0] || null,
        checkOutDate: existingBooking.checkOutDate?.toISOString().split('T')[0] || null
      } : null;

      const mergedData = BookingDataMerger.smartMerge(existingForMerge, parsedData);

      // Convert string dates back to Date objects for Prisma
      const createData = {
        userId: this.userId,
        bookingCode: parsedData.bookingCode, // Ensure bookingCode is always present
        gmailId: emailId,
        gmailThreadId: threadId,
        emailDate: new Date(),
        parseAttempts: 1,
        ...(mergedData.guestName && { guestName: mergedData.guestName }),
        ...(mergedData.checkInDate && { checkInDate: new Date(mergedData.checkInDate) }),
        ...(mergedData.checkOutDate && { checkOutDate: new Date(mergedData.checkOutDate) }),
        ...(mergedData.nights && { nights: mergedData.nights }),
        ...(mergedData.guestTotalEur !== undefined && { guestTotalEur: mergedData.guestTotalEur }),
        ...(mergedData.hostEarningsEur !== undefined && { hostEarningsEur: mergedData.hostEarningsEur }),
        ...(mergedData.cleaningFeeEur !== undefined && { cleaningFeeEur: mergedData.cleaningFeeEur }),
        ...(mergedData.serviceFeeEur !== undefined && { serviceFeeEur: mergedData.serviceFeeEur }),
        ...(mergedData.guestTotalSek !== undefined && { guestTotalSek: mergedData.guestTotalSek }),
        ...(mergedData.hostEarningsSek !== undefined && { hostEarningsSek: mergedData.hostEarningsSek }),
        ...(mergedData.cleaningFeeSek !== undefined && { cleaningFeeSek: mergedData.cleaningFeeSek }),
        ...(mergedData.serviceFeeSek !== undefined && { serviceFeeSek: mergedData.serviceFeeSek }),
        ...(mergedData.status && { status: mergedData.status })
      };

      const updateData = {
        gmailId: emailId,
        gmailThreadId: threadId,
        emailDate: new Date(),
        parseAttempts: { increment: 1 },
        ...(mergedData.guestName && { guestName: mergedData.guestName }),
        ...(mergedData.checkInDate && { checkInDate: new Date(mergedData.checkInDate) }),
        ...(mergedData.checkOutDate && { checkOutDate: new Date(mergedData.checkOutDate) }),
        ...(mergedData.nights && { nights: mergedData.nights }),
        ...(mergedData.guestTotalEur !== undefined && { guestTotalEur: mergedData.guestTotalEur }),
        ...(mergedData.hostEarningsEur !== undefined && { hostEarningsEur: mergedData.hostEarningsEur }),
        ...(mergedData.cleaningFeeEur !== undefined && { cleaningFeeEur: mergedData.cleaningFeeEur }),
        ...(mergedData.serviceFeeEur !== undefined && { serviceFeeEur: mergedData.serviceFeeEur }),
        ...(mergedData.guestTotalSek !== undefined && { guestTotalSek: mergedData.guestTotalSek }),
        ...(mergedData.hostEarningsSek !== undefined && { hostEarningsSek: mergedData.hostEarningsSek }),
        ...(mergedData.cleaningFeeSek !== undefined && { cleaningFeeSek: mergedData.cleaningFeeSek }),
        ...(mergedData.serviceFeeSek !== undefined && { serviceFeeSek: mergedData.serviceFeeSek }),
        ...(mergedData.status && { status: mergedData.status })
      };

      await prisma.booking.upsert({
        where: {
          userId_bookingCode: {
            userId: this.userId,
            bookingCode: parsedData.bookingCode
          }
        },
        create: createData,
        update: updateData
      });

      // Skapa email link för denna email
      try {
        const emailType = this.mapEmailTypeForEmailLink(parsedData.emailType);
        const subject = parsedData.subject || `${parsedData.emailType} email`;
        const emailDate = parsedData.emailDate ? new Date(parsedData.emailDate) : new Date();

        await EmailLinkManager.addEmailLinkByBookingCode(
          this.userId,
          parsedData.bookingCode,
          emailType,
          emailId,
          threadId,
          subject,
          emailDate
        );
      } catch (error) {
        console.error(`   ⚠️  Failed to create email link for ${parsedData.bookingCode}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        // Don't throw - this shouldn't stop the enrichment process
      }

      // Emit events för WebSocket updates
      const booking = await prisma.booking.findFirst({
        where: {
          userId: this.userId,
          bookingCode: parsedData.bookingCode
        }
      });

      if (booking) {
        await bookingUpdateEmitter.emitBookingUpdated(this.userId, booking, {}, parseInt(this.sessionId));
        if (wsManager) {
          wsManager.broadcastBookingUpdated(this.userId, booking);
        }
      }

    } catch (error) {
      console.error(`   ❌ Failed to upsert booking data for ${parsedData.bookingCode}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    }
  }

  /**
   * Extrahera email headers
   */
  private extractEmailHeaders(message: GmailMessage): EmailHeaders | undefined {
    try {
      const headers = message.payload?.headers || [];
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
      console.error(`   ⚠️ Error extracting email headers: ${error}`);
      return undefined;
    }
  }

  /**
   * Extrahera råinnehåll från email
   */
  private extractRawContent(message: GmailMessage): string | null {
    try {
      const extractFromPart = (part: any): string => {
        let content = '';

        if (part.body?.data) {
          try {
            const decoded = Buffer.from(part.body.data, 'base64').toString('utf-8');
            content += decoded + '\n';
          } catch (e) {
            console.error(`   ⚠️ Failed to decode part ${part.mimeType}: ${e}`);
          }
        }

        if (part.parts) {
          for (const subPart of part.parts) {
            content += extractFromPart(subPart);
          }
        }

        return content;
      };

      if (message.payload?.parts) {
        let allContent = '';
        for (const part of message.payload.parts) {
          allContent += extractFromPart(part);
        }
        if (allContent.trim()) {
          return allContent.trim();
        }
      }

      // Fallback: direct body extraction
      if (message.payload?.body?.data) {
        try {
          return Buffer.from(message.payload.body.data, 'base64').toString('utf-8');
        } catch (e) {
          console.error(`   ⚠️ Failed to decode main body: ${e}`);
        }
      }

      return null;
    } catch (error) {
      console.error(`   ⚠️ Error extracting raw content: ${error}`);
      return null;
    }
  }

  /**
   * Dela upp array i chunks
   */
  private chunkArray<T>(array: T[], chunkSize: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += chunkSize) {
      chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
  }

  /**
   * Map email type från ML-system till EmailLinkManager format
   */
  private mapEmailTypeForEmailLink(emailType?: string): 'confirmation' | 'payout' | 'reminder' | 'cancellation' | 'modification' {
    if (!emailType) return 'confirmation';

    switch (emailType) {
      case 'booking_confirmation':
        return 'confirmation';
      case 'booking_reminder':
        return 'reminder';
      case 'payout':
        return 'payout';
      case 'cancellation':
        return 'cancellation';
      case 'change_request':
      case 'modification':
        return 'modification';
      default:
        console.warn(`Unknown email type for email link: ${emailType}, defaulting to 'confirmation'`);
        return 'confirmation';
    }
  }

  /**
   * Få statistik om batch enrichment
   */
  getStats() {
    return {
      batchSize: this.BATCH_SIZE,
      maxResultsPerBatch: this.MAX_RESULTS_PER_BATCH
    };
  }
}