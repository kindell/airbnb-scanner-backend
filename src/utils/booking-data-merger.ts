/**
 * Centralized Booking Data Merger
 * 
 * This class contains ALL logic for deciding how to merge booking data
 * from different sources (booking confirmations, payouts, reminders, etc.)
 * 
 * Used by BOTH:
 * - Initial scan (api.ts)  
 * - Enrichment process (booking-enricher.ts)
 * 
 * DRY Principle: ONE place for merge decisions
 */

export interface BookingData {
  bookingCode: string;
  emailType?: 'booking_confirmation' | 'booking_reminder' | 'payout' | 'cancellation' | 'change_request' | 'modification';
  guestName?: string | null;
  checkInDate?: string | null;
  checkOutDate?: string | null;
  nights?: number | null;
  guestTotalEur?: number | null;
  hostEarningsEur?: number | null;
  cleaningFeeEur?: number | null;
  serviceFeeEur?: number | null;
  occupancyTaxEur?: number | null;
  guestTotalSek?: number | null;
  hostEarningsSek?: number | null;
  cleaningFeeSek?: number | null;
  serviceFeeSek?: number | null;
  occupancyTaxSek?: number | null;
  status?: string | null;
  gmailId?: string | null;
  gmailThreadId?: string | null;
}

export class BookingDataMerger {
  
  /**
   * Smart merge booking data with priority-based logic
   * 
   * Priority Order:
   * 1. booking_confirmation (most detailed, most reliable)
   * 2. payout (reliable for amounts, but might overwrite details)
   * 3. booking_reminder (least reliable, often incomplete)
   * 
   * Rules:
   * - Never overwrite detailed data with null/undefined
   * - Booking confirmation always wins for economic details
   * - Only update if new data is actually "better"
   */
  static smartMerge(existing: Partial<BookingData> | null, incoming: BookingData): Partial<BookingData> {
    // Start with existing data as base
    let merged: Partial<BookingData> = existing ? { ...existing } : {};
    
    console.log(`📊 BookingDataMerger: Merging ${incoming.emailType || 'unknown'} data for ${incoming.bookingCode}`);
    
    // CRITICAL DEBUG for HMSPX39W44
    if (incoming.bookingCode === 'HMSPX39W44') {
      console.log(`🔍 HMSPX39W44 DEBUG - INCOMING DATA:`);
      console.log(`   emailType: ${incoming.emailType}`);
      console.log(`   hostEarningsSek: ${incoming.hostEarningsSek}`);
      console.log(`   hostEarningsEur: ${incoming.hostEarningsEur}`);
      console.log(`   guestTotalSek: ${incoming.guestTotalSek}`);
      console.log(`   guestTotalEur: ${incoming.guestTotalEur}`);
      console.log(`🔍 HMSPX39W44 DEBUG - EXISTING DATA:`);
      if (existing) {
        console.log(`   hostEarningsSek: ${existing.hostEarningsSek}`);
        console.log(`   hostEarningsEur: ${existing.hostEarningsEur}`);
        console.log(`   guestTotalSek: ${existing.guestTotalSek}`);
        console.log(`   guestTotalEur: ${existing.guestTotalEur}`);
      } else {
        console.log(`   NO EXISTING DATA`);
      }
    }
    
    // Always update basic fields if incoming has values
    if (incoming.bookingCode) merged.bookingCode = incoming.bookingCode;
    if (incoming.gmailId) merged.gmailId = incoming.gmailId;
    if (incoming.gmailThreadId) merged.gmailThreadId = incoming.gmailThreadId;
    
    // Guest name: Update if we don't have one or incoming is more complete
    if (incoming.guestName && (!existing?.guestName || incoming.guestName.length > existing.guestName.length)) {
      merged.guestName = incoming.guestName;
    }
    
    // Dates: Update if we don't have them or incoming is from booking_confirmation
    if (incoming.checkInDate && (!existing?.checkInDate || incoming.emailType === 'booking_confirmation')) {
      merged.checkInDate = incoming.checkInDate;
    }
    if (incoming.checkOutDate && (!existing?.checkOutDate || incoming.emailType === 'booking_confirmation')) {
      merged.checkOutDate = incoming.checkOutDate;
    }
    if (incoming.nights && (!existing?.nights || incoming.emailType === 'booking_confirmation')) {
      merged.nights = incoming.nights;
    }
    
    // Status: Update based on email type priority
    // CRITICAL: Cancellation ALWAYS wins - if booking is cancelled, that's final
    if (incoming.status) {
      const shouldUpdateStatus = !existing?.status || 
        incoming.emailType === 'cancellation' ||  // Cancellation always wins
        (incoming.emailType === 'booking_confirmation' && existing?.status !== 'cancelled');
      
      if (shouldUpdateStatus) {
        merged.status = incoming.status;
        console.log(`     📄 Status: ${existing?.status || 'none'} → ${incoming.status} (${incoming.emailType})`);
      }
    }
    
    // CRITICAL: Economic data with smart priority logic
    merged.guestTotalEur = this.mergeEconomicField(
      'guestTotalEur', existing?.guestTotalEur, incoming.guestTotalEur, incoming.emailType
    );
    merged.hostEarningsEur = this.mergeEconomicField(
      'hostEarningsEur', existing?.hostEarningsEur, incoming.hostEarningsEur, incoming.emailType
    );
    merged.cleaningFeeEur = this.mergeEconomicField(
      'cleaningFeeEur', existing?.cleaningFeeEur, incoming.cleaningFeeEur, incoming.emailType
    );
    merged.serviceFeeEur = this.mergeEconomicField(
      'serviceFeeEur', existing?.serviceFeeEur, incoming.serviceFeeEur, incoming.emailType
    );
    merged.guestTotalSek = this.mergeEconomicField(
      'guestTotalSek', existing?.guestTotalSek, incoming.guestTotalSek, incoming.emailType
    );
    merged.hostEarningsSek = this.mergeEconomicField(
      'hostEarningsSek', existing?.hostEarningsSek, incoming.hostEarningsSek, incoming.emailType
    );
    merged.cleaningFeeSek = this.mergeEconomicField(
      'cleaningFeeSek', existing?.cleaningFeeSek, incoming.cleaningFeeSek, incoming.emailType
    );
    merged.serviceFeeSek = this.mergeEconomicField(
      'serviceFeeSek', existing?.serviceFeeSek, incoming.serviceFeeSek, incoming.emailType
    );
    
    // 🧮 Smart service fee calculation when not parsed directly
    // Logic: serviceFee = guestTotal - hostEarnings - cleaningFee
    merged = this.calculateMissingServiceFees(merged);
    
    // 🛡️ CRITICAL: Ensure all economic fields are numbers, not null
    // This prevents "Okänt belopp" in UI by setting null/undefined to 0
    merged = this.ensureEconomicFieldsAreNumbers(merged);
    
    // CRITICAL DEBUG for HMSPX39W44 - log final merged result
    if (incoming.bookingCode === 'HMSPX39W44') {
      console.log(`🔍 HMSPX39W44 DEBUG - FINAL MERGED RESULT:`);
      console.log(`   hostEarningsSek: ${merged.hostEarningsSek}`);
      console.log(`   hostEarningsEur: ${merged.hostEarningsEur}`);
      console.log(`   guestTotalSek: ${merged.guestTotalSek}`);
      console.log(`   guestTotalEur: ${merged.guestTotalEur}`);
      console.log(`   ABOUT TO RETURN:`, JSON.stringify({
        hostEarningsSek: merged.hostEarningsSek,
        hostEarningsEur: merged.hostEarningsEur,
        guestTotalSek: merged.guestTotalSek,
        guestTotalEur: merged.guestTotalEur
      }));
    }
    
    return merged;
  }
  
  /**
   * Smart economic field merging logic
   * 
   * Rules:
   * 1. booking_confirmation ALWAYS wins (most detailed)
   * 2. If no existing value, accept any valid incoming value  
   * 3. payout can only overwrite if existing seems unreasonable
   * 4. reminder NEVER overwrites existing detailed data
   */
  private static mergeEconomicField(
    fieldName: string,
    existingValue: number | null | undefined,
    incomingValue: number | null | undefined,
    emailType?: string
  ): number | null | undefined {
    
    // If no incoming value, keep existing
    if (incomingValue === null || incomingValue === undefined) {
      return existingValue;
    }
    
    // If no existing value, accept incoming
    if (existingValue === null || existingValue === undefined) {
      console.log(`     ✅ ${fieldName}: Setting ${incomingValue} from ${emailType} (no existing value)`);
      return incomingValue;
    }
    
    // PAYOUT WINS: Payout emails have the most accurate financial data
    if (emailType === 'payout') {
      console.log(`     💰 ${fieldName}: Updating ${existingValue} → ${incomingValue} from ${emailType} (payout priority - most accurate)`);
      return incomingValue;
    }
    
    // Booking confirmation wins if no payout data exists
    if (emailType === 'booking_confirmation') {
      console.log(`     ✅ ${fieldName}: Updating ${existingValue} → ${incomingValue} from ${emailType} (booking confirmation priority)`);
      return incomingValue;
    }
    
    // CRITICAL: Never let reminder overwrite payout data
    if (emailType === 'booking_reminder') {
      console.log(`     🔒 ${fieldName}: Keeping existing ${existingValue} over ${incomingValue} from ${emailType} (reminder never overwrites)`);
      return existingValue;
    }
    
    // Other types: only update if significantly larger (more complete data)
    if (incomingValue > existingValue * 1.1) {
      console.log(`     ✅ ${fieldName}: Updating ${existingValue} → ${incomingValue} from ${emailType} (significantly larger)`);
      return incomingValue;
    } else {
      console.log(`     🔒 ${fieldName}: Keeping existing ${existingValue} over ${incomingValue} from ${emailType} (not significantly better)`);
      return existingValue;
    }
  }

  /**
   * Calculate missing service fees using smart logic
   * Formula: serviceFee = guestTotal - hostEarnings - cleaningFee
   * 
   * This addresses the common issue where service fees are rarely parsed correctly
   * from emails, but can be calculated from the difference between what guest pays
   * and what host receives (minus cleaning fee).
   */
  private static calculateMissingServiceFees(booking: Partial<BookingData>): Partial<BookingData> {
    // Calculate EUR service fee if missing
    if (!booking.serviceFeeEur && booking.guestTotalEur && booking.hostEarningsEur) {
      const cleaningFee = booking.cleaningFeeEur || 0;
      const calculatedServiceFee = booking.guestTotalEur - booking.hostEarningsEur - cleaningFee;
      
      // Only set if calculation results in positive, reasonable fee (2-25% of guest total)
      if (calculatedServiceFee > 0 && calculatedServiceFee <= booking.guestTotalEur * 0.25) {
        booking.serviceFeeEur = Math.round(calculatedServiceFee * 100) / 100; // Round to 2 decimals
        console.log(`     🧮 Calculated EUR service fee: €${booking.serviceFeeEur} (${Math.round((booking.serviceFeeEur / booking.guestTotalEur) * 100)}%)`);
      }
    }

    // Calculate SEK service fee if missing
    if (!booking.serviceFeeSek && booking.guestTotalSek && booking.hostEarningsSek) {
      const cleaningFee = booking.cleaningFeeSek || 0;
      const calculatedServiceFee = booking.guestTotalSek - booking.hostEarningsSek - cleaningFee;
      
      // Only set if calculation results in positive, reasonable fee (2-25% of guest total)
      if (calculatedServiceFee > 0 && calculatedServiceFee <= booking.guestTotalSek * 0.25) {
        booking.serviceFeeSek = Math.round(calculatedServiceFee * 100) / 100; // Round to 2 decimals
        console.log(`     🧮 Calculated SEK service fee: ${booking.serviceFeeSek} kr (${Math.round((booking.serviceFeeSek / booking.guestTotalSek) * 100)}%)`);
      }
    }

    return booking;
  }

  /**
   * Ensure all economic fields are numbers (0) instead of null/undefined
   * This prevents "Okänt belopp" in the UI
   */
  private static ensureEconomicFieldsAreNumbers(booking: Partial<BookingData>): Partial<BookingData> {
    const economicFields = [
      'guestTotalEur', 'hostEarningsEur', 'cleaningFeeEur', 'serviceFeeEur', 'occupancyTaxEur',
      'guestTotalSek', 'hostEarningsSek', 'cleaningFeeSek', 'serviceFeeSek', 'occupancyTaxSek'
    ] as const;

    const result = { ...booking };
    
    economicFields.forEach(field => {
      if (result[field] === null || result[field] === undefined) {
        (result as any)[field] = 0;
        console.log(`     🛡️ Fixed null ${field} → 0 (prevents "Okänt belopp")`);
      }
    });

    return result;
  }
}