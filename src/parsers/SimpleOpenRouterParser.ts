import axios, { AxiosResponse } from 'axios';
import { GmailEmailData, BookingData, PayoutData } from '../types';

interface OpenRouterRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature: number;
  max_tokens: number;
}

interface OpenRouterResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

/**
 * Simplified OpenRouter AI parser for Airbnb booking and payout emails
 * Uses DeepSeek model for intelligent email parsing with Swedish support
 */
export class SimpleOpenRouterParser {
  private readonly baseUrl = 'https://openrouter.ai/api/v1';
  private readonly model = 'deepseek/deepseek-chat-v3.1';
  private readonly apiKey: string;
  
  // Rate limiting config
  private readonly maxRetries = 3;
  private readonly baseDelay = 1000; // 1 second base delay

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Parse payout notification email for booking information  
   */
  async parsePayoutNotificationForBooking(emailData: GmailEmailData): Promise<BookingData | null> {
    try {
      const plainText = emailData.rawEmailContent;
      
      if (!this.isPayoutNotificationWithBooking(plainText)) {
        return null;
      }

      console.log(`💳 Parsing payout notification for booking data: ${emailData.emailId}`);

      // Extract booking code using regex - more precise pattern for Airbnb booking codes
      // Try multiple patterns to find the actual booking code
      const bookingPatterns = [
        /HM[A-Z0-9]{8}\b/g,         // Exact 10 character codes (HM + 8 chars), word boundary
        /HM[A-Z0-9]{6,10}\b/g,      // Variable length with word boundary  
        /bekräftelsekod[:\s]*HM[A-Z0-9]{6,10}/gi,  // After "bekräftelsekod"
        /booking[:\s]+code[:\s]*HM[A-Z0-9]{6,10}/gi, // After "booking code"
      ];
      
      let bookingCode = null;
      
      // Try each pattern and prefer shorter, more specific matches
      for (const pattern of bookingPatterns) {
        const matches = Array.from(plainText.matchAll(pattern));
        if (matches.length > 0) {
          // Get all potential codes and pick the shortest valid one
          const codes = matches.map(match => {
            if (match[0].includes('HM')) {
              // Extract just the HM code part
              const codeMatch = match[0].match(/HM[A-Z0-9]{6,10}/i);
              return codeMatch ? codeMatch[0] : null;
            }
            return null;
          }).filter(Boolean);
          
          if (codes.length > 0) {
            // Prefer the shortest code (most likely to be correct)
            bookingCode = codes.sort((a, b) => a!.length - b!.length)[0];
            break;
          }
        }
      }
      
      if (!bookingCode) {
        console.log(`❌ No booking code found in payout notification`);
        return null;
      }
      console.log(`💳 Found booking code in payout: ${bookingCode}`);

      // For payout notifications, we only have limited info
      // Mark status as completed since it got a payout
      return {
        emailId: emailData.emailId,
        rawEmailContent: emailData.rawEmailContent,
        gmailId: emailData.gmailId,
        gmailThreadId: emailData.gmailThreadId,
        bookingCode: bookingCode,
        status: 'completed_from_payout'
      } as BookingData;
      
    } catch (error) {
      console.error('❌ Error parsing payout notification for booking:', error);
      return null;
    }
  }

  /**
   * Parse booking email using AI
   */
  async parseBookingEmail(emailData: GmailEmailData): Promise<BookingData | null> {
    try {
      const plainText = emailData.rawEmailContent;
      
      // Simple validation - check if it looks like a booking confirmation, modification, or reminder
      if (!this.isBookingConfirmation(plainText) && !this.isBookingModificationEmail(plainText) && !this.isBookingReminder(plainText)) {
        return null;
      }

      // Handle cancellation emails properly
      if (this.isCancellationEmail(plainText)) {
        console.log(`❌ Cancellation email detected - parsing but marking as cancelled`);
        // Continue processing but ensure it gets marked as cancelled
      }

      if (this.isGuestBookingEmail(plainText)) {
        console.log(`👤 Guest booking email detected - skipping AI parsing`);
        return null;
      }

      const bookingData = await this.extractBookingWithAI(plainText, emailData.emailId);
      
      if (bookingData?.bookingCode) {
        // Check if this was a cancellation email and mark accordingly
        const isCancelled = this.isCancellationEmail(plainText);
        const isModification = this.isBookingModificationEmail(plainText);
        
        if (isCancelled) {
          // Check if host still gets paid despite cancellation
          const hasEarnings = bookingData.hostEarningsEur && bookingData.hostEarningsEur > 0;
          (bookingData as any).status = hasEarnings ? 'cancelled_with_payout' : 'cancelled';
          
          if (hasEarnings) {
            console.log(`🚫💰 OpenRouter parsed CANCELLED WITH PAYOUT booking: ${bookingData.bookingCode} - €${bookingData.hostEarningsEur}`);
          } else {
            console.log(`❌ OpenRouter parsed CANCELLED booking: ${bookingData.bookingCode}`);
          }
        } else if (isModification) {
          (bookingData as any).status = 'modified';
          console.log(`🔄 OpenRouter parsed MODIFIED booking: ${bookingData.bookingCode} - €${bookingData.guestTotalEur || bookingData.hostEarningsEur}`);
        } else {
          console.log(`🌐 OpenRouter parsed booking: ${bookingData.bookingCode} - €${bookingData.guestTotalEur || bookingData.hostEarningsEur}`);
        }
        
        return {
          emailId: emailData.emailId,
          rawEmailContent: emailData.rawEmailContent,
          gmailId: emailData.gmailId,
          gmailThreadId: emailData.gmailThreadId,
          bookingCode: bookingData.bookingCode, // We know this exists because of the if check
          guestName: bookingData.guestName,
          checkInDate: bookingData.checkInDate,
          checkOutDate: bookingData.checkOutDate,
          nights: bookingData.nights,
          guestTotalEur: bookingData.guestTotalEur,
          guestTotalSek: bookingData.guestTotalSek,
          hostEarningsEur: bookingData.hostEarningsEur,
          hostEarningsSek: bookingData.hostEarningsSek,
          cleaningFeeEur: bookingData.cleaningFeeEur,
          cleaningFeeSek: bookingData.cleaningFeeSek,
          propertyName: bookingData.propertyName,
          hasTaxes: bookingData.hasTaxes,
          hostEarningsBeforeTaxEur: bookingData.hostEarningsBeforeTaxEur,
          hostEarningsAfterTaxEur: bookingData.hostEarningsAfterTaxEur,
          cleaningFeeBeforeTaxEur: bookingData.cleaningFeeBeforeTaxEur,
          cleaningFeeAfterTaxEur: bookingData.cleaningFeeAfterTaxEur,
          vatRate: bookingData.vatRate,
          taxDetails: bookingData.taxDetails,
          status: (bookingData as any).status || 'processed' // Use the determined status
        } as BookingData;
      }
      
      return null;
      
    } catch (error) {
      console.error('❌ Error in OpenRouter booking parsing:', error);
      return null;
    }
  }

  /**
   * Parse payout email using AI
   */
  async parsePayoutEmail(emailData: GmailEmailData): Promise<PayoutData | null> {
    try {
      const plainText = emailData.rawEmailContent;
      
      if (!this.isPayoutEmail(plainText)) {
        return null;
      }

      const payoutData = await this.extractPayoutWithAI(plainText, emailData.emailId);
      
      if (payoutData && payoutData.amount) {
        console.log(`💰 OpenRouter parsed payout: ${payoutData.amountSek} SEK`);
        return {
          emailId: emailData.emailId,
          rawEmailContent: emailData.rawEmailContent,
          gmailId: emailData.gmailId,
          gmailThreadId: emailData.gmailThreadId,
          amount: payoutData.amount,
          currency: payoutData.currency || 'EUR',
          amountSek: payoutData.amountSek,
          exchangeRate: payoutData.exchangeRate,
          payoutDate: payoutData.payoutDate || new Date().toISOString(),
          payoutId: payoutData.payoutId
        };
      }
      
      return null;
      
    } catch (error) {
      console.error('❌ Error in OpenRouter payout parsing:', error);
      return null;
    }
  }

  /**
   * Simple validation methods
   */
  private isBookingConfirmation(plainText: string): boolean {
    const textLower = plainText.toLowerCase();
    return textLower.includes('booking confirmed') || 
           textLower.includes('bokning bekräftad') || 
           textLower.includes('reservation confirmed');
  }

  private isBookingReminder(plainText: string): boolean {
    const textLower = plainText.toLowerCase();
    return textLower.includes('bokningspåminnelse') || 
           textLower.includes('booking reminder') ||
           textLower.includes('anländer snart');
  }

  private isCancellationEmail(plainText: string): boolean {
    const textLower = plainText.toLowerCase();
    // Very specific patterns - only actual cancellation notifications
    return textLower.includes('booking cancelled') ||
           textLower.includes('booking canceled') ||
           textLower.includes('bokning avbokad') ||
           textLower.includes('cancellation confirmed') ||
           textLower.includes('avbokning bekräftad') ||
           textLower.includes('has been cancelled') ||
           textLower.includes('has been canceled') ||
           textLower.includes('har avbokats') ||
           (textLower.includes('cancelled by') && textLower.includes('guest')) ||
           (textLower.includes('canceled by') && textLower.includes('guest'));
  }

  private isGuestBookingEmail(plainText: string): boolean {
    const textLower = plainText.toLowerCase();
    return textLower.includes('you booked') || 
           textLower.includes('du har bokat') || 
           textLower.includes('your booking');
  }

  private isBookingModificationEmail(plainText: string): boolean {
    const textLower = plainText.toLowerCase();
    return textLower.includes('booking modified') ||
           textLower.includes('booking updated') ||
           textLower.includes('bokning ändrad') ||
           textLower.includes('bokning uppdaterad') ||
           textLower.includes('reservation modified') ||
           textLower.includes('reservation updated') ||
           textLower.includes('ändrade sin bokning') ||
           textLower.includes('updated their booking') ||
           textLower.includes('modified their booking') ||
           textLower.includes('reservation change') ||
           textLower.includes('bokningsändring');
  }

  private isPayoutEmail(plainText: string): boolean {
    const textLower = plainText.toLowerCase();
    return textLower.includes('payout') || 
           textLower.includes('utbetalning') || 
           textLower.includes('payment sent') || 
           textLower.includes('betalning skickad') ||
           textLower.includes('kr skickades');
  }

  private isPayoutNotificationWithBooking(plainText: string): boolean {
    const textLower = plainText.toLowerCase();
    // Check if it's a payout notification that might contain booking codes
    return textLower.includes('utbetalning på') && 
           textLower.includes('kr skickades') &&
           /HM[A-Z0-9]{8,}/i.test(plainText); // Contains booking code pattern
  }

  /**
   * Extract booking data using AI
   */
  private async extractBookingWithAI(plainText: string, emailId: string): Promise<Partial<BookingData> | null> {
    const prompt = this.buildBookingPrompt(plainText);
    
    try {
      const response = await this.makeOpenRouterRequest({
        model: this.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens: 1000
      }, `booking parsing (${emailId})`);

      const parsed = this.parseAIResponse(response.data.choices[0].message.content);
      
      if (!parsed) return null;
      
      return parsed;
      
    } catch (error) {
      console.error('❌ AI booking extraction failed:', error);
      return null;
    }
  }

  /**
   * Extract payout data using AI
   */
  private async extractPayoutWithAI(plainText: string, emailId: string): Promise<Partial<PayoutData> | null> {
    const prompt = this.buildPayoutPrompt(plainText);
    
    try {
      const response = await this.makeOpenRouterRequest({
        model: this.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens: 800
      }, `payout parsing (${emailId})`);

      const parsed = this.parseAIResponse(response.data.choices[0].message.content);
      
      return parsed;
      
    } catch (error) {
      console.error('❌ AI payout extraction failed:', error);
      return null;
    }
  }

  /**
   * Build AI prompt for booking email parsing
   */
  private buildBookingPrompt(plainText: string): string {
    const currentDate = new Date().toISOString().split('T')[0];
    
    return `Extract booking information from this Airbnb host email (confirmation, modification, or reminder). Return ONLY a JSON object with these exact fields:

{
  "bookingCode": "confirmation code (like HM123ABC45)",
  "guestName": "guest full name", 
  "checkInDate": "YYYY-MM-DD format",
  "checkOutDate": "YYYY-MM-DD format",
  "nights": number,
  "guestTotalEur": number or null,
  "guestTotalSek": number or null,
  "hostEarningsEur": number or null,  
  "hostEarningsSek": number or null,
  "cleaningFeeEur": number or null,
  "cleaningFeeSek": number or null
}

Important rules:
- If amount has € symbol, put in EUR fields
- If amount has kr/SEK, put in SEK fields  
- Parse Swedish dates: "15 oktober 2023" = "2023-10-15"
- Parse Swedish months: jan, feb, mar, apr, maj, jun, jul, aug, sep, okt, nov, dec
- Today is ${currentDate} - use for date context
- Return null for missing values
- ONLY return the JSON, no other text

Email content:
${plainText}`;
  }

  /**
   * Build AI prompt for payout email parsing
   */
  private buildPayoutPrompt(plainText: string): string {
    return `Extract payout information from this Airbnb payout email. Return ONLY a JSON object:

{
  "payoutId": "payout ID if found",
  "amount": number,
  "currency": "EUR or SEK", 
  "amountSek": number or null,
  "exchangeRate": number or null,
  "payoutDate": "YYYY-MM-DD format"
}

Rules:
- Parse Swedish dates and amounts
- Return null for missing values
- ONLY return JSON, no other text

Email content:
${plainText}`;
  }

  /**
   * Parse AI response JSON
   */
  private parseAIResponse(content: string): any | null {
    try {
      console.log('🔍 AI Response received:', content.substring(0, 200) + '...');
      
      // Try multiple JSON extraction patterns
      let jsonMatch = content.match(/\{[\s\S]*\}/);
      
      if (!jsonMatch) {
        // Try without escaping
        jsonMatch = content.match(/\{[\s\S]*\}/);
      }
      
      if (!jsonMatch) {
        // Try to find JSON in code blocks
        jsonMatch = content.match(/```json\n([\s\S]*?)\n```/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[1]);
          console.log('✅ Parsed JSON from code block:', parsed);
          return parsed;
        }
      }
      
      if (!jsonMatch) {
        // Try to find any object-like structure
        jsonMatch = content.match(/\\{[^{}]*(?:\\{[^{}]*\\}[^{}]*)*\\}/);
      }
      
      if (!jsonMatch) {
        console.log('❌ No JSON pattern found in AI response. Full response:', content);
        return null;
      }
      
      const parsed = JSON.parse(jsonMatch[0]);
      console.log('✅ Parsed JSON:', parsed);
      return parsed;
      
    } catch (error) {
      console.error('❌ Failed to parse AI response JSON:', error);
      console.error('Raw content:', content);
      return null;
    }
  }

  /**
   * Make OpenRouter API request with retry logic
   */
  private async makeOpenRouterRequest(request: OpenRouterRequest, context: string): Promise<AxiosResponse<OpenRouterResponse>> {
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        console.log(`🌐 OpenRouter ${context} (attempt ${attempt}/${this.maxRetries})`);
        
        const response = await axios.post<OpenRouterResponse>(
          `${this.baseUrl}/chat/completions`,
          request,
          {
            headers: {
              'Authorization': `Bearer ${this.apiKey}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': 'https://airbnb-scanner-saas',
              'X-Title': 'Airbnb Scanner SaaS'
            },
            timeout: 30000
          }
        );

        console.log(`✅ OpenRouter ${context} successful`);
        return response;

      } catch (error: any) {
        const isRateLimitError = error.response?.status === 429;
        const isServerError = error.response?.status >= 500;
        
        if ((isRateLimitError || isServerError) && attempt < this.maxRetries) {
          const delay = this.baseDelay * Math.pow(2, attempt - 1);
          console.log(`⏳ OpenRouter ${context} rate limited, waiting ${delay}ms before retry ${attempt + 1}/${this.maxRetries}`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        
        console.error(`❌ OpenRouter ${context} failed:`, error.response?.data || error.message);
        throw error;
      }
    }
    
    throw new Error(`OpenRouter request failed after ${this.maxRetries} attempts`);
  }
}