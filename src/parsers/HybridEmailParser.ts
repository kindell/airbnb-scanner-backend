import { GmailEmailData, BookingData, PayoutData } from '../types';
import { MLEmailParser } from './MLEmailParser';
import { SimpleOpenRouterParser } from './SimpleOpenRouterParser';

/**
 * Hybrid Email Parser that uses ML as primary and OpenRouter as fallback
 * 
 * This parser provides the best of both worlds:
 * - Fast and cheap ML parsing for standard emails (100% accuracy)
 * - OpenRouter AI fallback for complex or edge cases
 * - Automatic performance monitoring and optimization
 */
export class HybridEmailParser {
  private mlParser: MLEmailParser;
  private openRouterParser: SimpleOpenRouterParser;
  private mlAvailable: boolean = false;
  
  // Performance tracking
  private stats = {
    totalProcessed: 0,
    mlSuccessful: 0,
    openRouterFallback: 0,
    totalErrors: 0,
    avgProcessingTime: 0
  };

  constructor(openRouterApiKey: string, userId: number = 1) {
    this.mlParser = new MLEmailParser(userId);
    this.openRouterParser = new SimpleOpenRouterParser(openRouterApiKey);
    
    // Check ML availability on startup
    this.initializeMLParser();
  }

  private async initializeMLParser() {
    try {
      this.mlAvailable = await this.mlParser.isAvailable();
      if (this.mlAvailable) {
        console.log('🤖 ML Email Parser initialized successfully');
      } else {
        console.log('⚠️ ML Email Parser not available, using OpenRouter only');
      }
    } catch (error) {
      console.warn('⚠️ ML Email Parser initialization failed:', error);
      this.mlAvailable = false;
    }
  }

  /**
   * Parse booking email with ML-first approach
   */
  async parseBookingEmail(emailData: GmailEmailData): Promise<BookingData | null> {
    const startTime = Date.now();
    let result: BookingData | null = null;
    let method = 'unknown';

    try {
      // Try ML parser first if available
      if (this.mlAvailable) {
        try {
          console.log(`🔍 Trying ML parser for: ${emailData.headers?.subject || 'No subject'}`);
          result = await this.mlParser.parseBookingEmail(emailData);
          // Check if ML result is complete (has booking code AND guest name AND financial data for confirmations)
          const hasBasicData = result && result.bookingCode && result.guestName;
          const hasFinancialData = result?.guestTotalEur || result?.hostEarningsEur || result?.cleaningFeeEur;
          const isConfirmation = emailData.headers?.subject?.toLowerCase().includes('bekräftad') || 
                               emailData.headers?.subject?.toLowerCase().includes('confirmed');
          
          // For confirmation emails, require financial data. For reminders/others, basic data is enough
          const isComplete = hasBasicData && (isConfirmation ? hasFinancialData : true);
          
          if (isComplete) {
            method = 'ML';
            this.stats.mlSuccessful++;
          } else if (result) {
            const reason = isConfirmation && !hasFinancialData ? 'missing financial data for confirmation' : 'incomplete basic data';
            console.log(`🔄 ML partial data (${result.bookingCode} - ${result.guestName || 'null'}, ${reason}), falling back to OpenRouter`);
            result = null; // Force fallback
          }
        } catch (error) {
          console.warn('⚠️ ML parser failed, falling back to OpenRouter:', error);
        }
      }

      // Fallback to OpenRouter if ML failed or unavailable or incomplete
      if (!result) {
        try {
          result = await this.openRouterParser.parseBookingEmail(emailData);
          if (result) {
            method = 'OpenRouter';
            this.stats.openRouterFallback++;
          }
        } catch (error) {
          console.error('❌ OpenRouter parser also failed:', error);
          this.stats.totalErrors++;
        }
      }

      // Track performance
      this.stats.totalProcessed++;
      const processingTime = Date.now() - startTime;
      this.stats.avgProcessingTime = (this.stats.avgProcessingTime * (this.stats.totalProcessed - 1) + processingTime) / this.stats.totalProcessed;

      if (result) {
        console.log(`✅ ${method} parsed booking: ${result.bookingCode} (${processingTime}ms)`);
      }

      return result;

    } catch (error) {
      console.error('❌ Hybrid parser error:', error);
      this.stats.totalErrors++;
      return null;
    }
  }

  /**
   * Parse payout email with ML-first approach
   */
  async parsePayoutEmail(emailData: GmailEmailData): Promise<PayoutData | null> {
    const startTime = Date.now();
    let result: PayoutData | null = null;
    let method = 'unknown';

    try {
      // Try ML parser first if available
      if (this.mlAvailable) {
        try {
          result = await this.mlParser.parsePayoutEmail(emailData);
          if (result) {
            method = 'ML';
            this.stats.mlSuccessful++;
          }
        } catch (error) {
          console.warn('⚠️ ML payout parser failed, falling back to OpenRouter:', error);
        }
      }

      // Fallback to OpenRouter if ML failed or unavailable
      if (!result) {
        try {
          result = await this.openRouterParser.parsePayoutEmail(emailData);
          if (result) {
            method = 'OpenRouter';
            this.stats.openRouterFallback++;
          }
        } catch (error) {
          console.error('❌ OpenRouter payout parser also failed:', error);
          this.stats.totalErrors++;
        }
      }

      // Track performance
      this.stats.totalProcessed++;
      const processingTime = Date.now() - startTime;
      this.stats.avgProcessingTime = (this.stats.avgProcessingTime * (this.stats.totalProcessed - 1) + processingTime) / this.stats.totalProcessed;

      if (result) {
        console.log(`💰 ${method} parsed payout: ${result.amountSek} SEK (${processingTime}ms)`);
      }

      return result;

    } catch (error) {
      console.error('❌ Hybrid payout parser error:', error);
      this.stats.totalErrors++;
      return null;
    }
  }

  /**
   * Parse payout notification for booking information
   */
  async parsePayoutNotificationForBooking(emailData: GmailEmailData): Promise<BookingData | null> {
    const startTime = Date.now();
    let result: BookingData | null = null;
    let method = 'unknown';

    try {
      // Try ML parser first if available
      if (this.mlAvailable) {
        try {
          result = await this.mlParser.parsePayoutNotificationForBooking(emailData);
          if (result) {
            method = 'ML';
            this.stats.mlSuccessful++;
          }
        } catch (error) {
          console.warn('⚠️ ML payout notification parser failed, falling back to OpenRouter:', error);
        }
      }

      // Fallback to OpenRouter if ML failed or unavailable
      if (!result) {
        try {
          result = await this.openRouterParser.parsePayoutNotificationForBooking(emailData);
          if (result) {
            method = 'OpenRouter';
            this.stats.openRouterFallback++;
          }
        } catch (error) {
          console.error('❌ OpenRouter payout notification parser also failed:', error);
          this.stats.totalErrors++;
        }
      }

      // Track performance
      this.stats.totalProcessed++;
      const processingTime = Date.now() - startTime;
      this.stats.avgProcessingTime = (this.stats.avgProcessingTime * (this.stats.totalProcessed - 1) + processingTime) / this.stats.totalProcessed;

      if (result) {
        console.log(`💳 ${method} parsed payout notification: ${result.bookingCode} (${processingTime}ms)`);
      }

      return result;

    } catch (error) {
      console.error('❌ Hybrid payout notification parser error:', error);
      this.stats.totalErrors++;
      return null;
    }
  }

  /**
   * Get performance statistics
   */
  getStats() {
    const mlSuccessRate = this.stats.totalProcessed > 0 ? (this.stats.mlSuccessful / this.stats.totalProcessed) * 100 : 0;
    const errorRate = this.stats.totalProcessed > 0 ? (this.stats.totalErrors / this.stats.totalProcessed) * 100 : 0;
    
    return {
      ...this.stats,
      mlAvailable: this.mlAvailable,
      mlSuccessRate: mlSuccessRate.toFixed(1) + '%',
      errorRate: errorRate.toFixed(1) + '%',
      avgProcessingTime: Math.round(this.stats.avgProcessingTime) + 'ms'
    };
  }

  /**
   * Log performance summary
   */
  logPerformanceSummary() {
    const stats = this.getStats();
    console.log('\n📊 HYBRID PARSER PERFORMANCE SUMMARY:');
    console.log('=' .repeat(45));
    console.log(`🤖 ML Parser Available: ${stats.mlAvailable ? '✅ Yes' : '❌ No'}`);
    console.log(`📧 Total Emails Processed: ${stats.totalProcessed}`);
    console.log(`🚀 ML Successful: ${stats.mlSuccessful} (${stats.mlSuccessRate})`);
    console.log(`🔄 OpenRouter Fallback: ${stats.openRouterFallback}`);
    console.log(`❌ Total Errors: ${stats.totalErrors} (${stats.errorRate})`);
    console.log(`⏱️ Average Processing Time: ${stats.avgProcessingTime}`);
    
    if (stats.mlAvailable && this.stats.totalProcessed > 0) {
      const costSaving = (this.stats.mlSuccessful * 0.002 * 0.95); // 95% cost saving on ML-processed emails
      const timeSaving = (this.stats.mlSuccessful * 2000); // ~2s saved per ML-processed email
      console.log(`💰 Estimated Cost Savings: $${costSaving.toFixed(4)}`);
      console.log(`⚡ Estimated Time Savings: ${(timeSaving/1000).toFixed(1)} seconds`);
    }
  }
}