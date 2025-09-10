/**
 * Change Request Matcher
 * ======================
 * 
 * Smart matching system that connects change request emails to bookings
 * based on guest names and dates instead of booking codes.
 */

import { prisma } from '../database/client';

export interface ChangeRequestEmail {
  emailId: string;
  subject: string;
  guestName: string;
  originalCheckInDate?: string;
  originalCheckOutDate?: string;
  newCheckInDate?: string;
  newCheckOutDate?: string;
  confidence: number;
}

export interface BookingMatchCandidate {
  id: number;
  bookingCode: string;
  guestName: string;
  checkInDate: Date;
  checkOutDate: Date;
  originalCheckInDate?: Date;
  originalCheckOutDate?: Date;
  matchScore: number;
}

export class ChangeRequestMatcher {
  private userId: number;

  constructor(userId: number) {
    this.userId = userId;
  }

  /**
   * Match change request email to booking using smart algorithms
   */
  async matchChangeRequestToBooking(changeRequest: ChangeRequestEmail): Promise<string | null> {
    console.log(`🎯 Matching change request for ${changeRequest.guestName} with dates ${changeRequest.originalCheckInDate}-${changeRequest.originalCheckOutDate}`);

    // Get potential booking matches
    const candidates = await this.findBookingCandidates(changeRequest);
    
    if (candidates.length === 0) {
      console.log(`⚠️ No booking candidates found for ${changeRequest.guestName}`);
      return null;
    }

    // Score and rank candidates
    const scoredCandidates = candidates.map(candidate => {
      const score = this.calculateMatchScore(changeRequest, candidate);
      return { ...candidate, matchScore: score };
    }).sort((a, b) => b.matchScore - a.matchScore);

    console.log(`📊 Found ${scoredCandidates.length} candidates:`);
    scoredCandidates.forEach((candidate, index) => {
      console.log(`   ${index + 1}. ${candidate.bookingCode} (${candidate.guestName}) - Score: ${candidate.matchScore.toFixed(3)}`);
    });

    // Return best match if score is above threshold
    const bestMatch = scoredCandidates[0];
    const MATCH_THRESHOLD = 0.7; // 70% confidence required

    if (bestMatch.matchScore >= MATCH_THRESHOLD) {
      console.log(`✅ High confidence match: ${bestMatch.bookingCode} (score: ${bestMatch.matchScore.toFixed(3)})`);
      return bestMatch.bookingCode;
    } else {
      console.log(`❌ No confident match found (best score: ${bestMatch.matchScore.toFixed(3)} < ${MATCH_THRESHOLD})`);
      return null;
    }
  }

  /**
   * Find potential booking candidates based on guest name
   */
  private async findBookingCandidates(changeRequest: ChangeRequestEmail): Promise<BookingMatchCandidate[]> {
    const firstName = changeRequest.guestName.split(' ')[0];
    
    // Find bookings with matching first name
    const bookings = await prisma.booking.findMany({
      where: {
        userId: this.userId,
        guestName: {
          contains: firstName
        },
        // Look for bookings from last 2 years (change requests can be old)
        createdAt: {
          gte: new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000)
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    return bookings.map(booking => ({
      id: booking.id,
      bookingCode: booking.bookingCode,
      guestName: booking.guestName || '',
      checkInDate: booking.checkInDate || new Date(),
      checkOutDate: booking.checkOutDate || new Date(),
      originalCheckInDate: booking.originalCheckInDate || undefined,
      originalCheckOutDate: booking.originalCheckOutDate || undefined,
      matchScore: 0 // Will be calculated later
    }));
  }

  /**
   * Calculate match score between change request and booking
   */
  private calculateMatchScore(changeRequest: ChangeRequestEmail, booking: BookingMatchCandidate): number {
    let score = 0;

    // 1. Name similarity (40% of score)
    const nameScore = this.calculateNameSimilarity(changeRequest.guestName, booking.guestName);
    score += nameScore * 0.4;

    // 2. Date matching (50% of score)
    const dateScore = this.calculateDateSimilarity(changeRequest, booking);
    score += dateScore * 0.5;

    // 3. Booking recency bonus (10% of score)
    const recencyScore = this.calculateRecencyBonus(booking.checkInDate);
    score += recencyScore * 0.1;

    console.log(`   📊 ${booking.bookingCode}: name=${nameScore.toFixed(2)} date=${dateScore.toFixed(2)} recency=${recencyScore.toFixed(2)} total=${score.toFixed(3)}`);

    return score;
  }

  /**
   * Calculate name similarity using fuzzy matching
   */
  private calculateNameSimilarity(name1: string, name2: string): number {
    if (!name1 || !name2) return 0;

    const normalize = (str: string) => str.toLowerCase().trim();
    const n1 = normalize(name1);
    const n2 = normalize(name2);

    // Exact match
    if (n1 === n2) return 1.0;

    // First name exact match
    const firstName1 = n1.split(' ')[0];
    const firstName2 = n2.split(' ')[0];
    if (firstName1 === firstName2) return 0.8;

    // Contains check
    if (n1.includes(firstName2) || n2.includes(firstName1)) return 0.6;

    // Simple similarity based on common characters
    const commonChars = [...new Set(n1)].filter(char => n2.includes(char)).length;
    const totalChars = Math.max(n1.length, n2.length);
    return Math.min(commonChars / totalChars, 0.5);
  }

  /**
   * Calculate date similarity between change request and booking
   */
  private calculateDateSimilarity(changeRequest: ChangeRequestEmail, booking: BookingMatchCandidate): number {
    // If change request has original dates, compare with booking dates
    if (changeRequest.originalCheckInDate && changeRequest.originalCheckOutDate) {
      const reqCheckIn = new Date(changeRequest.originalCheckInDate);
      const reqCheckOut = new Date(changeRequest.originalCheckOutDate);
      
      const bookingCheckIn = booking.checkInDate;
      const bookingCheckOut = booking.checkOutDate;

      // Check if dates match exactly
      if (this.datesEqual(reqCheckIn, bookingCheckIn) && this.datesEqual(reqCheckOut, bookingCheckOut)) {
        return 1.0; // Perfect match
      }

      // Check if dates are close (within 7 days)
      const checkInDiff = Math.abs(reqCheckIn.getTime() - bookingCheckIn.getTime()) / (24 * 60 * 60 * 1000);
      const checkOutDiff = Math.abs(reqCheckOut.getTime() - bookingCheckOut.getTime()) / (24 * 60 * 60 * 1000);

      if (checkInDiff <= 7 && checkOutDiff <= 7) {
        // Score based on how close the dates are
        const avgDiff = (checkInDiff + checkOutDiff) / 2;
        return Math.max(0.3, 1.0 - (avgDiff / 7) * 0.7); // 0.3 to 1.0 score
      }

      // Check if this could be the "new" dates after a change
      if (booking.originalCheckInDate && booking.originalCheckOutDate) {
        if (this.datesEqual(reqCheckIn, booking.originalCheckInDate) && 
            this.datesEqual(reqCheckOut, booking.originalCheckOutDate)) {
          return 0.9; // High match - this was the original booking before change
        }
      }
    }

    // If no original dates in change request, try to match current booking dates
    if (changeRequest.newCheckInDate && changeRequest.newCheckOutDate) {
      const reqNewCheckIn = new Date(changeRequest.newCheckInDate);
      const reqNewCheckOut = new Date(changeRequest.newCheckOutDate);
      
      if (this.datesEqual(reqNewCheckIn, booking.checkInDate) && 
          this.datesEqual(reqNewCheckOut, booking.checkOutDate)) {
        return 0.8; // Good match - these are the new dates
      }
    }

    return 0.1; // Very low score if no date matching
  }

  /**
   * Calculate recency bonus - prefer more recent bookings
   */
  private calculateRecencyBonus(checkInDate: Date): number {
    const now = new Date();
    const daysSince = (now.getTime() - checkInDate.getTime()) / (24 * 60 * 60 * 1000);
    
    // Bonus decreases with age
    if (daysSince < 30) return 1.0;      // Within 30 days
    if (daysSince < 90) return 0.8;      // Within 3 months
    if (daysSince < 365) return 0.6;     // Within 1 year
    if (daysSince < 730) return 0.4;     // Within 2 years
    return 0.2;                          // Older than 2 years
  }

  /**
   * Check if two dates are equal (same day)
   */
  private datesEqual(date1: Date, date2: Date): boolean {
    return date1.toISOString().split('T')[0] === date2.toISOString().split('T')[0];
  }

  /**
   * Apply change request to booking
   */
  async applyChangeRequestToBooking(
    bookingCode: string, 
    changeRequest: ChangeRequestEmail
  ): Promise<boolean> {
    try {
      const updateData: any = {
        hasChanges: true,
        changeCount: { increment: 1 },
        lastChangeDate: new Date()
      };

      // Set original dates if we have them and booking doesn't
      if (changeRequest.originalCheckInDate && changeRequest.originalCheckOutDate) {
        const booking = await prisma.booking.findFirst({
          where: { userId: this.userId, bookingCode }
        });

        if (booking && !booking.originalCheckInDate) {
          updateData.originalCheckInDate = new Date(changeRequest.originalCheckInDate);
          updateData.originalCheckOutDate = new Date(changeRequest.originalCheckOutDate);
        }
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

      console.log(`✅ Applied change request to booking ${bookingCode}`);
      return true;

    } catch (error) {
      console.error(`❌ Failed to apply change request to booking ${bookingCode}:`, error);
      return false;
    }
  }

  /**
   * Batch process multiple change requests
   */
  async batchMatchChangeRequests(changeRequests: ChangeRequestEmail[]): Promise<{
    totalProcessed: number;
    successfulMatches: number;
    failedMatches: number;
    results: Array<{
      emailId: string;
      guestName: string;
      matchedBookingCode?: string;
      success: boolean;
    }>;
  }> {
    const results: Array<{
      emailId: string;
      guestName: string;
      matchedBookingCode?: string;
      success: boolean;
    }> = [];

    let successfulMatches = 0;

    for (const changeRequest of changeRequests) {
      try {
        const matchedBookingCode = await this.matchChangeRequestToBooking(changeRequest);
        
        if (matchedBookingCode) {
          const applied = await this.applyChangeRequestToBooking(matchedBookingCode, changeRequest);
          
          if (applied) {
            successfulMatches++;
            results.push({
              emailId: changeRequest.emailId,
              guestName: changeRequest.guestName,
              matchedBookingCode,
              success: true
            });
          } else {
            results.push({
              emailId: changeRequest.emailId,
              guestName: changeRequest.guestName,
              success: false
            });
          }
        } else {
          results.push({
            emailId: changeRequest.emailId,
            guestName: changeRequest.guestName,
            success: false
          });
        }
      } catch (error) {
        console.error(`❌ Error processing change request ${changeRequest.emailId}:`, error);
        results.push({
          emailId: changeRequest.emailId,
          guestName: changeRequest.guestName,
          success: false
        });
      }
    }

    return {
      totalProcessed: changeRequests.length,
      successfulMatches,
      failedMatches: changeRequests.length - successfulMatches,
      results
    };
  }
}