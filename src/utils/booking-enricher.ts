/**
 * Booking Enrichment Service
 * ==========================
 * 
 * Efter initial Gmail-scan, söker vi bakåt för varje bokningskod
 * för att hitta ALL relaterad email-data utan år-begränsningar.
 * 
 * Detta löser problemet där bekräftelser kan komma tidigare år
 * än påminnelser/utbetalningar.
 */

import { GmailClient } from './gmail-client';
import { prisma } from '../database/client';
import { parseEmailWithML } from '../parsers/ml-parser';
import { EmailHeaders } from '../types';
import { decodeGmailContent, decodeGmailContentForML } from './email-decoder';
import { EmailLinkManager } from './email-link-manager';
import { BookingDataMerger } from './booking-data-merger';
import { bookingUpdateEmitter } from './booking-update-emitter';
// Email content extraction will be handled inline

export interface EnrichmentResult {
  bookingCode: string;
  emailsFound: number;
  emailsProcessed: number;
  dataImproved: boolean;
  changeDetected: boolean;
  payoutCorrected: boolean;
  errors: string[];
}

export class BookingEnricher {
  constructor(private gmailClient: GmailClient, private userId: number) {}

  /**
   * Extrahera headers från Gmail-meddelande (samma som huvudscanningen)
   */
  private extractEmailHeaders(message: any): EmailHeaders | undefined {
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
      console.log(`   ⚠️ Error extracting email headers: ${error}`);
      return undefined;
    }
  }

  /**
   * Extrahera råinnehåll från Gmail-meddelande (prioriterar HTML för bättre data-extraktion)
   */
  private extractRawContent(message: any): string | null {
    try {
      console.log(`   🔍 Extracting content from message structure:`, message.payload ? 'has payload' : 'no payload');
      const extractFromPart = (part: any): string => {
        let content = '';
        
        // Extract content from this part if it has body data - use simple base64 decode
        if (part.body?.data) {
          try {
            const decoded = Buffer.from(part.body.data, 'base64').toString('utf-8');
            content += decoded + '\n';
          } catch (e) {
            console.log(`   ⚠️ Failed to decode part ${part.mimeType}: ${e}`);
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
      
      // Extract from all parts recursively
      if (message.payload?.parts) {
        let allContent = '';
        for (const part of message.payload.parts) {
          allContent += extractFromPart(part);
        }
        console.log(`   📄 Extracted content from all parts: ${allContent.length} chars`);
        if (allContent.trim()) {
          return allContent.trim();
        }
      }
      
      // Single part email - use simple base64 decode like main scanner
      if (message.payload?.body?.data) {
        return Buffer.from(message.payload.body.data, 'base64').toString('utf-8');
      }
      
      if (message.raw) {
        return Buffer.from(message.raw, 'base64').toString('utf-8');
      }
      
      return null;
    } catch (error) {
      console.log(`   ⚠️ Error extracting content: ${error}`);
      return null;
    }
  }

  /**
   * Enrichera alla ofullständiga bokningar med bakåtlänkad sökning
   */
  async enrichIncompleteBookings(): Promise<EnrichmentResult[]> {
    console.log('🔍 Starting booking enrichment process...');
    
    // Hitta ofullständiga bokningar (saknar viktiga fält ELLER potentiella datum-problem)
    const incompleteBookings = await prisma.booking.findMany({
      where: {
        userId: this.userId,
        OR: [
          { checkInDate: null },
          { checkOutDate: null },
          { guestName: null },
          { hostEarningsEur: null },
          { guestTotalEur: null },
          // Include bookings that might have date conflicts to validate against payout emails
          { hasChanges: false } // Re-check bookings that haven't been marked as changed
        ]
      },
      select: {
        bookingCode: true,
        guestName: true,
        checkInDate: true,
        checkOutDate: true,
        hostEarningsEur: true,
        guestTotalEur: true,
        hasChanges: true
      }
    });

    console.log(`📊 Found ${incompleteBookings.length} incomplete bookings to enrich`);
    
    const results: EnrichmentResult[] = [];
    
    for (const booking of incompleteBookings) {
      const result = await this.enrichBooking(booking.bookingCode);
      results.push(result);
      
      // Lite paus för att inte överbelasta Gmail API
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    return results;
  }

  /**
   * Enrichera en specifik bokning genom att söka alla relaterade mejl
   */
  async enrichBooking(bookingCode: string): Promise<EnrichmentResult> {
    console.log(`🔍 Enriching booking: ${bookingCode}`);
    
    const result: EnrichmentResult = {
      bookingCode,
      emailsFound: 0,
      emailsProcessed: 0,
      dataImproved: false,
      changeDetected: false,
      payoutCorrected: false,
      errors: []
    };

    try {
      // Sök ALLA mejl för denna bokningskod utan år-begränsning
      const query = `${bookingCode} (from:automated@airbnb.com OR from:noreply@airbnb.com OR from:express@airbnb.com)`;
      console.log(`   Query: ${query}`);
      
      const emailIds = await this.gmailClient.searchEmails(query, 20);
      result.emailsFound = emailIds.length;
      
      if (emailIds.length === 0) {
        console.log(`   ⚠️ No additional emails found for ${bookingCode}`);
        return result;
      }

      console.log(`   📧 Found ${emailIds.length} emails for ${bookingCode}`);

      // Spara data före enrichment för jämförelse
      const beforeEnrichment = await prisma.booking.findUnique({
        where: { 
          userId_bookingCode: { 
            userId: this.userId, 
            bookingCode 
          } 
        }
      });

      // Processera varje mejl och uppdatera bokningen
      for (const emailId of emailIds) {
        try {
          console.log(`   🔄 Processing email ${emailId} for ${bookingCode}...`);
          // Kolla om vi redan processerat detta mejl
          const existingBooking = await prisma.booking.findFirst({
            where: {
              userId: this.userId,
              gmailId: emailId
            }
          });

          if (existingBooking && existingBooking.bookingCode === bookingCode) {
            console.log(`   ⏭️ Email ${emailId} already processed`);
            continue;
          }

          // Hämta och parsa mejl
          console.log(`   📥 Fetching email ${emailId} via Gmail API...`);
          const email = await this.gmailClient.getEmail(emailId);
          console.log(`   ✅ Gmail API success for ${emailId}: ${email ? 'got email data' : 'NO DATA'}`);
          
          // Extrahera råinnehåll för ML-parsern
          const rawContent = this.extractRawContent(email);
          console.log(`   📄 Content extraction for ${emailId}: ${rawContent ? `${rawContent.length} chars` : 'FAILED'}`);
          if (!rawContent) {
            result.errors.push(`Could not extract content from email ${emailId}`);
            console.log(`   ❌ Content extraction failed for ${emailId}`);
            continue;
          }

          // Extrahera headers från Gmail API (samma som huvudscanningen)
          const headers = this.extractEmailHeaders(email);
          console.log(`   📧 Headers for ${emailId}:`, headers ? `subject="${headers.subject}", from="${headers.from}"` : 'null');

          console.log(`   🤖 Processing email ${emailId}`);

          // Parsa med ML med korrekt headers
          const parsedData = await parseEmailWithML(
            headers?.subject || '',
            headers?.from || '',
            rawContent,
            this.userId,
            headers?.date
          );

          // Handle both bookingCode and payoutId from different parsers
          const extractedCode = parsedData?.bookingCode || parsedData?.payoutId;
          if (!parsedData || extractedCode !== bookingCode) {
            console.log(`   ⚠️ Parsed booking code mismatch: expected ${bookingCode}, got ${extractedCode} (bookingCode: ${parsedData?.bookingCode}, payoutId: ${parsedData?.payoutId})`);
            continue;
          }

          // Ensure bookingCode is set for consistency
          if (parsedData && !parsedData.bookingCode && parsedData.payoutId) {
            parsedData.bookingCode = parsedData.payoutId;
          }

          // Add subject to parsedData for email link type detection
          if (parsedData && headers?.subject) {
            parsedData.subject = headers.subject;
          }

          // Debug emailType preservation
          console.log(`     📋 emailType before upsert: ${parsedData?.emailType} for ${extractedCode}`);

          // CRITICAL FIX: Skip booking_confirmation and booking_reminder during enrichment
          // booking_confirmation was already processed in initial scan
          // booking_reminder contains no new information, just duplicates booking_confirmation data
          if (parsedData?.emailType === 'booking_confirmation') {
            console.log(`     ⏭️ SKIPPING booking_confirmation during enrichment - already processed in initial scan`);
            continue;
          }
          
          if (parsedData?.emailType === 'booking_reminder') {
            console.log(`     ⏭️ SKIPPING booking_reminder during enrichment - contains no new information, only duplicates existing data`);
            continue;
          }

          // Uppdatera bokningen med enriched data
          await this.upsertEnrichedBooking(parsedData, emailId, email.threadId);
          result.emailsProcessed++;

        } catch (error: any) {
          console.log(`   ❌ Error processing email ${emailId}: ${error.message}`);
          result.errors.push(`Email ${emailId}: ${error.message}`);
        }
      }

      // Fas 2: Change Detection - Sök efter ändrings-sekvenser
      console.log(`   🔄 Phase 2: Change detection for ${bookingCode}`);
      const changeDetectionResult = await this.detectAndProcessChanges(bookingCode);
      result.changeDetected = changeDetectionResult.changeDetected;
      if (changeDetectionResult.error) {
        result.errors.push(changeDetectionResult.error);
      }

      // Fas 3: Payout-based date correction - Final verification
      console.log(`   💰 Phase 3: Payout-based date correction for ${bookingCode}`);
      const payoutCorrectionResult = await this.correctDatesFromPayout(bookingCode);
      result.payoutCorrected = payoutCorrectionResult.corrected;
      if (payoutCorrectionResult.error) {
        result.errors.push(payoutCorrectionResult.error);
      }

      // Kontrollera om data förbättrades
      const afterEnrichment = await prisma.booking.findUnique({
        where: { 
          userId_bookingCode: { 
            userId: this.userId, 
            bookingCode 
          } 
        }
      });

      result.dataImproved = this.hasDataImproved(beforeEnrichment, afterEnrichment);
      
      if (result.dataImproved) {
        console.log(`   ✅ ${bookingCode} data improved! Processed ${result.emailsProcessed}/${result.emailsFound} emails`);
      } else {
        console.log(`   📝 ${bookingCode} processed ${result.emailsProcessed} emails, no significant improvement`);
      }

    } catch (error: any) {
      console.log(`   ❌ Error enriching ${bookingCode}: ${error.message}`);
      result.errors.push(`Enrichment failed: ${error.message}`);
    }

    // Emit enriched event after processing all emails for this booking
    try {
      const currentBooking = await prisma.booking.findFirst({
        where: {
          userId: this.userId,
          bookingCode: bookingCode
        }
      });
      
      if (currentBooking) {
        console.log(`🔔 Emitting ENRICHED event for ${bookingCode} after processing ${result.emailsProcessed} emails`);
        await bookingUpdateEmitter.emitBookingEnriched(this.userId, currentBooking);
        console.log(`✅ Successfully emitted enriched event for ${bookingCode}`);
      }
    } catch (emitError: any) {
      console.error(`❌ Failed to emit enriched event for ${bookingCode}:`, emitError);
    }

    return result;
  }

  /**
   * Uppdatera bokning med enriched data using centralized merger
   */
  private async upsertEnrichedBooking(parsedData: any, gmailId: string, threadId: string) {
    // Use centralized merger (imported at top)

    // Get current booking to check existing values
    const currentBooking = await prisma.booking.findUnique({
      where: { 
        userId_bookingCode: { 
          userId: this.userId, 
          bookingCode: parsedData.bookingCode 
        } 
      }
    });

    // Prepare enrichment data with gmail references
    const enrichmentData = {
      ...parsedData,
      gmailId: gmailId,
      gmailThreadId: threadId
    };

    // Convert current booking to BookingData format (dates as strings) 
    const currentData = currentBooking ? {
      bookingCode: currentBooking.bookingCode,
      guestName: currentBooking.guestName,
      checkInDate: currentBooking.checkInDate?.toISOString().split('T')[0] || null,
      checkOutDate: currentBooking.checkOutDate?.toISOString().split('T')[0] || null,
      nights: currentBooking.nights,
      guestTotalEur: currentBooking.guestTotalEur,
      hostEarningsEur: currentBooking.hostEarningsEur,
      cleaningFeeEur: currentBooking.cleaningFeeEur,
      serviceFeeEur: currentBooking.serviceFeeEur,
      guestTotalSek: currentBooking.guestTotalSek,
      hostEarningsSek: currentBooking.hostEarningsSek,
      cleaningFeeSek: currentBooking.cleaningFeeSek,
      serviceFeeSek: currentBooking.serviceFeeSek,
      status: currentBooking.status,
      gmailId: currentBooking.gmailId,
      gmailThreadId: currentBooking.gmailThreadId
    } : null;

    // Use centralized smart merge logic (same as api.ts!)
    const mergedData = BookingDataMerger.smartMerge(currentData, enrichmentData);
    
    // Special handling for cancellations detected in enrichment
    // ONLY trigger this logic if we actually have a cancellation email or status
    if (parsedData.emailType === 'cancellation' || 
        parsedData.status === 'cancelled' ||
        (parsedData.subject && (
          parsedData.subject.toLowerCase().includes('avbokad') ||
          parsedData.subject.toLowerCase().includes('cancelled') ||
          parsedData.subject.toLowerCase().includes('annullerad') ||
          parsedData.subject.toLowerCase().includes('inställd')
        ))) {
      
      console.log(`     🚫 CANCELLATION DETECTED for ${parsedData.bookingCode}`);
      
      // Check if there are any actual payout matches for this booking (not just emails)
      const bookingRecord = await prisma.booking.findFirst({
        where: {
          bookingCode: parsedData.bookingCode,
          userId: this.userId
        },
        include: {
          payouts: {
            include: {
              payout: true
            }
          }
        }
      });
      
      const actualPayouts = bookingRecord?.payouts || [];
      console.log(`     💰 Found ${actualPayouts.length} actual payout matches for cancelled booking`);
      
      if (actualPayouts.length > 0) {
        // Has actual payout matches - keep earnings from payout
        const totalPayoutAmount = actualPayouts.reduce((sum, match) => sum + match.payout.amount, 0);
        mergedData.status = 'cancelled_with_payout';
        console.log(`     ✅ Keeping earnings - ${actualPayouts.length} payout(s) totaling €${totalPayoutAmount.toFixed(2)}`);
      } else {
        // No actual payouts - zero out earnings from confirmation
        mergedData.status = 'cancelled';
        mergedData.hostEarningsEur = 0;
        mergedData.hostEarningsSek = 0;
        mergedData.guestTotalEur = 0;  // Also zero guest total since booking was cancelled
        mergedData.guestTotalSek = 0;
        mergedData.cleaningFeeEur = 0;
        mergedData.cleaningFeeSek = 0;
        mergedData.serviceFeeEur = 0;
        mergedData.serviceFeeSek = 0;
        console.log(`     🚫 ZEROED EARNINGS - no actual payout matches found for cancelled booking`);
      }
      
      console.log(`     🚫 FINAL STATUS: ${mergedData.status} (earnings: €${mergedData.hostEarningsEur || 0})`);
    }
    
    // Convert merged data to database update format
    const updateData: any = {
      parseAttempts: { increment: 1 },
      updatedAt: new Date()
    };
    
    // Apply merged fields to update data
    if (mergedData.guestName !== undefined) updateData.guestName = mergedData.guestName;
    if (mergedData.checkInDate !== undefined) updateData.checkInDate = mergedData.checkInDate ? new Date(mergedData.checkInDate) : null;
    if (mergedData.checkOutDate !== undefined) updateData.checkOutDate = mergedData.checkOutDate ? new Date(mergedData.checkOutDate) : null;
    if (mergedData.nights !== undefined) updateData.nights = mergedData.nights;
    if (mergedData.guestTotalEur !== undefined) updateData.guestTotalEur = mergedData.guestTotalEur;
    if (mergedData.hostEarningsEur !== undefined) updateData.hostEarningsEur = mergedData.hostEarningsEur;
    if (mergedData.cleaningFeeEur !== undefined) updateData.cleaningFeeEur = mergedData.cleaningFeeEur;
    if (mergedData.serviceFeeEur !== undefined) updateData.serviceFeeEur = mergedData.serviceFeeEur;
    if (mergedData.guestTotalSek !== undefined) updateData.guestTotalSek = mergedData.guestTotalSek;
    if (mergedData.hostEarningsSek !== undefined) updateData.hostEarningsSek = mergedData.hostEarningsSek;
    if (mergedData.cleaningFeeSek !== undefined) updateData.cleaningFeeSek = mergedData.cleaningFeeSek;
    if (mergedData.serviceFeeSek !== undefined) updateData.serviceFeeSek = mergedData.serviceFeeSek;
    if (mergedData.status !== undefined) updateData.status = mergedData.status;
    if (mergedData.gmailId !== undefined) updateData.gmailId = mergedData.gmailId;
    if (mergedData.gmailThreadId !== undefined) updateData.gmailThreadId = mergedData.gmailThreadId;

    const updatedBooking = await prisma.booking.update({
      where: {
        userId_bookingCode: {
          userId: this.userId,
          bookingCode: parsedData.bookingCode
        }
      },
      data: updateData
    });

    // Save email link with proper type detection
    if (gmailId && updatedBooking) {
      await this.saveEmailLink(updatedBooking.id, parsedData, gmailId, threadId);
    }

    console.log(`     💾 Updated booking ${parsedData.bookingCode} with enriched data`);
  }

  /**
   * Save email link with proper type detection
   */
  private async saveEmailLink(bookingId: number, parsedData: any, gmailId: string, threadId?: string) {
    try {
      // Determine email type from parsed data
      let emailType: 'confirmation' | 'payout' | 'reminder' | 'cancellation' | 'modification' = 'confirmation';
      
      if (parsedData.emailType === 'booking_confirmation') {
        emailType = 'confirmation';
      } else if (parsedData.emailType === 'booking_reminder') {
        emailType = 'reminder';
      } else if (parsedData.emailType === 'payout') {
        emailType = 'payout';
      } else if (parsedData.emailType === 'cancellation') {
        emailType = 'cancellation';
      } else if (parsedData.status?.includes('modified') || parsedData.emailType === 'booking_modification') {
        emailType = 'modification';
      }
      
      // Fallback: Detect email type from subject if parsedData.emailType is not reliable
      if (parsedData.subject) {
        if (parsedData.subject.includes('En utbetalning på') || parsedData.subject.includes('payout')) {
          emailType = 'payout';
        } else if (parsedData.subject.includes('påminnelse') || parsedData.subject.includes('reminder')) {
          emailType = 'reminder';
        } else if (parsedData.subject.includes('bekräftad') || parsedData.subject.includes('confirmed')) {
          emailType = 'confirmation';
        } else if (parsedData.subject.toLowerCase().includes('avbokad') || 
                   parsedData.subject.toLowerCase().includes('cancelled') ||
                   parsedData.subject.toLowerCase().includes('annullerad') ||
                   parsedData.subject.toLowerCase().includes('inställd')) {
          emailType = 'cancellation';
          console.log(`     🚫 DETECTED CANCELLATION from subject: "${parsedData.subject}"`);
        }
      }
      
      // Try to extract subject and date from headers if available
      const subject = parsedData.subject || `${emailType} email`;
      const emailDate = parsedData.emailDate ? new Date(parsedData.emailDate) : new Date();

      await EmailLinkManager.addEmailLink({
        bookingId,
        emailType,
        gmailId,
        gmailThreadId: threadId,
        subject,
        emailDate
      });
      
    } catch (error) {
      console.warn(`⚠️ Failed to save email link for booking ${bookingId}: ${error}`);
    }
  }

  /**
   * Kontrollera om data förbättrades efter enrichment
   */
  private hasDataImproved(before: any, after: any): boolean {
    if (!before || !after) return false;

    const beforeScore = this.calculateCompletenessScore(before);
    const afterScore = this.calculateCompletenessScore(after);

    return afterScore > beforeScore;
  }

  /**
   * Phase 2: Detect and process booking changes using already fetched emails
   */
  private async detectAndProcessChanges(bookingCode: string): Promise<{ changeDetected: boolean; error?: string }> {
    try {
      // Sök efter redan sparade emails för denna bokning
      const booking = await prisma.booking.findUnique({
        where: { 
          userId_bookingCode: { 
            userId: this.userId, 
            bookingCode 
          } 
        },
        include: {
          emailLinks: {
            orderBy: { emailDate: 'asc' }
          }
        }
      });

      if (!booking || !booking.emailLinks.length) {
        return { changeDetected: false };
      }

      // Leta efter change_request och modification email-sekvenser  
      const changeRequests = booking.emailLinks.filter((link: any) => 
        link.subject?.toLowerCase().includes('vill ändra') ||
        link.subject?.toLowerCase().includes('change request')
      );

      const modifications = booking.emailLinks.filter((link: any) =>
        link.subject?.toLowerCase().includes('uppdaterad') ||
        link.subject?.toLowerCase().includes('updated') ||
        link.subject?.toLowerCase().includes('godkänts') ||
        link.subject?.toLowerCase().includes('modified')
      );

      if (changeRequests.length === 0) {
        return { changeDetected: false };
      }

      console.log(`     🔄 Found ${changeRequests.length} change requests and ${modifications.length} modifications`);

      // Om vi har ändringssekvens, parsa om mejlen för att få korrekta datum
      for (const changeRequest of changeRequests) {
        try {
          // Hämta mejlet och parsa för originaldata och nya datum
          const email = await this.gmailClient.getEmail(changeRequest.gmailId);
          const rawContent = this.extractRawContent(email);
          const headers = this.extractEmailHeaders(email);
          
          if (!rawContent) continue;

          const parsedChange = await parseEmailWithML(
            headers?.subject || '',
            headers?.from || '',
            rawContent,
            this.userId,
            headers?.date
          );

          if (parsedChange?.emailType === 'change_request') {
            console.log(`     🔄 Processing change request with original dates`);
            
            // Spara originaldata om vi inte redan har det
            const updateData: any = {};
            if (parsedChange.originalCheckInDate && !booking.originalCheckInDate) {
              updateData.originalCheckInDate = new Date(parsedChange.originalCheckInDate);
            }
            if (parsedChange.originalCheckOutDate && !booking.originalCheckOutDate) {
              updateData.originalCheckOutDate = new Date(parsedChange.originalCheckOutDate);
            }
            if (parsedChange.checkInDate) {
              updateData.checkInDate = new Date(parsedChange.checkInDate);
            }
            if (parsedChange.checkOutDate) {
              updateData.checkOutDate = new Date(parsedChange.checkOutDate);
            }
            
            if (Object.keys(updateData).length > 0) {
              updateData.hasChanges = true;
              updateData.changeCount = { increment: 1 };
              updateData.lastChangeDate = new Date();
              
              await prisma.booking.update({
                where: { 
                  userId_bookingCode: { 
                    userId: this.userId, 
                    bookingCode 
                  } 
                },
                data: updateData
              });
              
              return { changeDetected: true };
            }
          }
        } catch (error) {
          console.log(`     ⚠️ Error processing change request: ${error}`);
        }
      }

      return { changeDetected: false };
    } catch (error: any) {
      return { changeDetected: false, error: error.message };
    }
  }

  /**
   * Phase 3: Correct dates using payout emails as authoritative source (using already fetched emails)
   */
  private async correctDatesFromPayout(bookingCode: string): Promise<{ corrected: boolean; error?: string }> {
    try {
      // Hitta payout-emails för denna bokning från redan sparade emails
      const booking = await prisma.booking.findUnique({
        where: { 
          userId_bookingCode: { 
            userId: this.userId, 
            bookingCode 
          } 
        },
        include: {
          emailLinks: {
            where: {
              emailType: 'payout'
            },
            orderBy: { emailDate: 'desc' }
          }
        }
      });

      if (!booking || !booking.emailLinks.length) {
        return { corrected: false };
      }

      console.log(`     💰 Found ${booking.emailLinks.length} payout emails to check for date corrections`);

      // Use ML parser to extract dates from payout emails (more reliable than regex)
      for (const payoutLink of booking.emailLinks) {
        try {
          const email = await this.gmailClient.getEmail(payoutLink.gmailId);
          const rawContent = this.extractRawContent(email);
          
          if (!rawContent) continue;

          // Extract headers from Gmail API
          const headers = this.extractEmailHeaders(email);
          console.log(`     💰 Re-parsing payout email ${payoutLink.gmailId} with enhanced ML`);

          // Parse payout email with ML (now supports date extraction)
          const { parseEmailWithML } = await import('../parsers/ml-parser');
          const parsedPayoutData = await parseEmailWithML(
            headers?.subject || '',
            headers?.from || '',
            rawContent,
            this.userId,
            headers?.date
          );
          
          if (parsedPayoutData?.checkInDate && parsedPayoutData?.checkOutDate && 
              parsedPayoutData.bookingCode === bookingCode) {
            
            console.log(`     💰 Found authoritative dates in payout: ${parsedPayoutData.checkInDate} → ${parsedPayoutData.checkOutDate}`);
            
            const payoutCheckIn = new Date(parsedPayoutData.checkInDate);
            const payoutCheckOut = new Date(parsedPayoutData.checkOutDate);
            
            // Jämför med nuvarande datum i bokning
            const currentCheckIn = booking.checkInDate;
            const currentCheckOut = booking.checkOutDate;
            
            const needsUpdate = (
              !currentCheckIn || currentCheckIn.getTime() !== payoutCheckIn.getTime() ||
              !currentCheckOut || currentCheckOut.getTime() !== payoutCheckOut.getTime()
            );
            
            if (needsUpdate) {
              console.log(`     💰 Date conflict detected! Correcting dates from payout: ${parsedPayoutData.checkInDate} - ${parsedPayoutData.checkOutDate}`);
              
              // If dates are different from what we have, save originals and mark as changed
              const updateData: any = {
                checkInDate: payoutCheckIn,
                checkOutDate: payoutCheckOut,
                nights: Math.round((payoutCheckOut.getTime() - payoutCheckIn.getTime()) / (1000 * 60 * 60 * 24)),
                updatedAt: new Date()
              };

              // If this is a real date correction (not just initial population), mark as change
              if (currentCheckIn && currentCheckOut) {
                console.log(`     🔄 Marking as booking change due to date conflict with payout`);
                updateData.originalCheckInDate = currentCheckIn;
                updateData.originalCheckOutDate = currentCheckOut;
                updateData.hasChanges = true;
                updateData.changeCount = { increment: 1 };
                updateData.lastChangeDate = new Date();
              }

              await prisma.booking.update({
                where: { 
                  userId_bookingCode: { 
                    userId: this.userId, 
                    bookingCode 
                  } 
                },
                data: updateData
              });
              
              console.log(`     ✅ Updated booking ${bookingCode}: ${parsedPayoutData.checkInDate} → ${parsedPayoutData.checkOutDate} (${updateData.nights} nights)`);
              return { corrected: true };
            } else {
              console.log(`     ✅ Dates already correct from payout verification`);
              return { corrected: false };
            }
          }
        } catch (error) {
          console.log(`     ⚠️ Error processing payout email: ${error}`);
        }
      }

      return { corrected: false };
    } catch (error: any) {
      return { corrected: false, error: error.message };
    }
  }

  /**
   * Beräkna fullständighetspoäng för bokning (0-100)
   */
  private calculateCompletenessScore(booking: any): number {
    if (!booking) return 0;

    const fields = [
      booking.guestName,
      booking.checkInDate,
      booking.checkOutDate,
      booking.nights,
      booking.hostEarningsEur || booking.hostEarningsSek,
      booking.guestTotalEur || booking.guestTotalSek,
      booking.cleaningFeeEur || booking.cleaningFeeSek
    ];

    const filledFields = fields.filter(field => field !== null && field !== undefined).length;
    return Math.round((filledFields / fields.length) * 100);
  }
}