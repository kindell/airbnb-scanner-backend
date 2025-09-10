/**
 * Payout Matcher
 * ==============
 * 
 * Matchar utbetalningar med bokningar när bokningskoden saknas
 * i utbetalnings-emailet genom smart tids- och beloppsbaserad matchning.
 */

import { prisma } from '../database/client';

interface PayoutData {
  emailId: string;
  gmailId: string;
  gmailThreadId: string;
  amount: number; // SEK
  amountEur: number; // EUR
  payoutDate: Date;
  subject: string;
}

interface BookingMatchCandidate {
  id: number;
  bookingCode: string;
  guestName?: string;
  checkInDate?: Date;
  checkOutDate?: Date;
  hostEarningsEur?: number;
  hostEarningsSek?: number;
  status: string;
  daysFromCheckout: number;
  amountSimilarity: number;
  matchScore: number;
}

export class PayoutMatcher {
  constructor(private userId: number) {}

  /**
   * Matcha en utbetalning med mest sannolika bokningen
   */
  async matchPayoutToBooking(payoutData: PayoutData): Promise<string | null> {
    console.log(`💰 Trying to match payout of ${payoutData.amount} kr...`);

    // Hitta kandidatbokningar (confirmed bookings utan payout-koppling)
    const candidateBookings = await this.findCandidateBookings(payoutData);
    
    if (candidateBookings.length === 0) {
      console.log(`   ⚠️ No candidate bookings found for payout`);
      return null;
    }

    // Sortera efter matchningsscore
    candidateBookings.sort((a, b) => b.matchScore - a.matchScore);
    
    console.log(`   🎯 Found ${candidateBookings.length} candidates:`);
    candidateBookings.slice(0, 3).forEach((candidate, i) => {
      console.log(`     ${i+1}. ${candidate.bookingCode} - ${candidate.guestName} (score: ${candidate.matchScore.toFixed(2)})`);
      console.log(`        Amount similarity: ${candidate.amountSimilarity.toFixed(2)}, Days from checkout: ${candidate.daysFromCheckout}`);
    });

    // Returnera bästa matchen om score > tröskelvärde
    const bestMatch = candidateBookings[0];
    const MINIMUM_SCORE = 0.6; // 60% säkerhet krävs

    if (bestMatch.matchScore >= MINIMUM_SCORE) {
      console.log(`   ✅ Best match: ${bestMatch.bookingCode} (score: ${bestMatch.matchScore.toFixed(2)})`);
      return bestMatch.bookingCode;
    } else {
      console.log(`   ❌ No confident match found (best score: ${bestMatch.matchScore.toFixed(2)} < ${MINIMUM_SCORE})`);
      return null;
    }
  }

  /**
   * Hitta kandidatbokningar för matchning
   */
  private async findCandidateBookings(payoutData: PayoutData): Promise<BookingMatchCandidate[]> {
    // Sök bokningar från senaste 6 månader som kan matcha
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    const bookings = await prisma.booking.findMany({
      where: {
        userId: this.userId,
        status: 'confirmed',
        createdAt: {
          gte: sixMonthsAgo
        },
        // Bara bokningar som inte redan har kopplad utbetalning
        AND: [
          {
            OR: [
              { hostEarningsEur: null },
              { hostEarningsEur: { lt: 10 } } // Mycket låga belopp = troligen inte riktiga
            ]
          }
        ]
      },
      select: {
        id: true,
        bookingCode: true,
        guestName: true,
        checkInDate: true,
        checkOutDate: true,
        hostEarningsEur: true,
        hostEarningsSek: true,
        status: true
      }
    });

    const candidates: BookingMatchCandidate[] = [];

    for (const booking of bookings) {
      // Tidsbaserad matchning
      let daysFromCheckout = 999; // Default: mycket långt bort
      if (booking.checkOutDate) {
        const timeDiff = payoutData.payoutDate.getTime() - booking.checkOutDate.getTime();
        daysFromCheckout = Math.floor(timeDiff / (1000 * 60 * 60 * 24));
        
        // Bara bokningar där utbetalning kommer EFTER checkout (0-60 dagar)
        if (daysFromCheckout < 0 || daysFromCheckout > 60) {
          continue;
        }
      }

      // Beloppsbaserad matchning
      let amountSimilarity = 0;
      if (booking.hostEarningsEur && booking.hostEarningsEur > 0) {
        const expectedSek = booking.hostEarningsEur * 11.0; // Ungefärlig SEK-kurs
        const diff = Math.abs(payoutData.amount - expectedSek);
        const avgAmount = (payoutData.amount + expectedSek) / 2;
        amountSimilarity = Math.max(0, 1 - (diff / avgAmount));
      } else {
        // Uppskatta rimligt belopp baserat på genomsnittlig intjäning
        const estimatedEarnings = this.estimateEarningsFromPayout(payoutData.amount);
        const diff = Math.abs(payoutData.amountEur - estimatedEarnings);
        amountSimilarity = Math.max(0, 1 - (diff / payoutData.amountEur));
      }

      // Beräkna total matchningsscore
      const timeScore = Math.max(0, 1 - (daysFromCheckout / 30)); // 30 dagar = 0 poäng
      const matchScore = (amountSimilarity * 0.7) + (timeScore * 0.3); // 70% belopp, 30% tid

      candidates.push({
        id: booking.id,
        bookingCode: booking.bookingCode,
        guestName: booking.guestName || undefined,
        checkInDate: booking.checkInDate || undefined,
        checkOutDate: booking.checkOutDate || undefined,
        hostEarningsEur: booking.hostEarningsEur || undefined,
        hostEarningsSek: booking.hostEarningsSek || undefined,
        status: booking.status || 'unknown',
        daysFromCheckout,
        amountSimilarity,
        matchScore
      });
    }

    return candidates;
  }

  /**
   * Uppskatta host earnings från utbetalningsbelopp (SEK)
   */
  private estimateEarningsFromPayout(payoutSek: number): number {
    // Utbetalning är vanligtvis ~80% av gästens totala betalning
    // Host earnings är vanligtvis ~70-85% av gästens betalning (minus Airbnb-avgifter)
    return payoutSek / 11.0; // Ungefärlig SEK->EUR konvertering
  }

  /**
   * Applicera matchad utbetalning på bokning
   */
  async applyPayoutToBooking(bookingCode: string, payoutData: PayoutData): Promise<void> {
    console.log(`   💾 Applying payout to booking ${bookingCode}`);

    await prisma.booking.update({
      where: {
        userId_bookingCode: {
          userId: this.userId,
          bookingCode: bookingCode
        }
      },
      data: {
        hostEarningsEur: payoutData.amountEur,
        hostEarningsSek: payoutData.amount,
        status: 'completed_with_payout',
        updatedAt: new Date()
      }
    });

    console.log(`     ✅ Updated ${bookingCode} with earnings: €${payoutData.amountEur} / ${payoutData.amount} kr`);
  }
}