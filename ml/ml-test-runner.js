/**
 * ML Test Runner - Automated Testing för ML Email Parsing
 * =====================================================
 * 
 * Testar ML-parsing mot riktiga Gmail-emails utan OpenRouter fallback
 * Jämför resultat mot förväntade värden från test-cases.json
 */

const fs = require('fs');
const path = require('path');

// Load test cases
const testCasesPath = path.join(__dirname, 'test-cases.json');
const testCases = JSON.parse(fs.readFileSync(testCasesPath, 'utf8'));

// Mock user för Gmail API
const MOCK_USER = {
  id: 1,
  email: 'jon@kindell.se',
  gmailAccessToken: process.env.GMAIL_ACCESS_TOKEN || 'mock-token',
  gmailRefreshToken: process.env.GMAIL_REFRESH_TOKEN || 'mock-refresh'
};

class MLTestRunner {
  constructor() {
    this.results = {
      total: 0,
      passed: 0,
      failed: 0,
      errors: 0,
      details: []
    };
  }

  async runAllTests() {
    console.log('🧪 Starting ML Test Suite');
    console.log('=' .repeat(50));
    console.log(`📧 Testing ${testCases.test_cases.length} Gmail emails`);
    console.log(`🚫 OpenRouter disabled (ML only)`);
    console.log(`⚡ No database writes (testing only)`);
    console.log();

    for (const testCase of testCases.test_cases) {
      await this.runSingleTest(testCase);
    }

    this.printSummary();
    return this.results;
  }

  async runSingleTest(testCase) {
    const { name, description, gmailId, expected, knownIssue } = testCase;
    this.results.total++;

    console.log(`🔍 Testing: ${name}`);
    console.log(`   Description: ${description}`);
    if (knownIssue) {
      console.log(`   ⚠️  Known Issue: ${knownIssue}`);
    }

    try {
      // 1. Hämta email från Gmail API
      const emailData = await this.fetchEmailFromGmail(gmailId);
      if (!emailData) {
        throw new Error('Failed to fetch email from Gmail API');
      }

      // 2. Parsa med ML (NO OpenRouter fallback)
      const parsedData = await this.parseWithMLOnly(emailData);
      
      // 3. Validera resultat
      const validation = this.validateResult(parsedData, expected);
      
      // 4. Logga resultat
      this.logTestResult(testCase, parsedData, validation);

      if (validation.passed) {
        this.results.passed++;
      } else {
        this.results.failed++;
      }

      this.results.details.push({
        testCase: name,
        passed: validation.passed,
        parsedData,
        expected,
        issues: validation.issues
      });

    } catch (error) {
      console.log(`   ❌ ERROR: ${error.message}`);
      this.results.errors++;
      this.results.details.push({
        testCase: name,
        error: error.message
      });
    }

    console.log();
  }

  async fetchEmailFromGmail(gmailId) {
    try {
      console.log(`   📧 Fetching real Gmail data for ${gmailId}...`);
      
      // First try to get authenticated user from running server
      const authenticatedUser = await this.getAuthenticatedUser();
      if (!authenticatedUser) {
        throw new Error('No authenticated user available');
      }

      // Use Gmail client directly with authenticated user
      const { GmailClient } = await import('../dist/utils/gmail-client.js');
      const gmailClient = new GmailClient(authenticatedUser);
      
      const email = await gmailClient.getEmail(gmailId);
      
      if (!email || !email.payload) {
        throw new Error('Invalid email data from Gmail API');
      }

      // Extract content samma som scanner gör
      const rawContent = this.extractRawContent(email);
      const headers = this.extractEmailHeaders(email);

      console.log(`   ✅ Extracted ${rawContent.length} chars from Gmail API`);
      console.log(`   📧 Subject: "${headers.subject}"`);

      return {
        emailId: gmailId,
        gmailId: gmailId,
        gmailThreadId: email.threadId,
        rawEmailContent: rawContent,
        headers: headers
      };

    } catch (error) {
      console.log(`   ❌ Gmail API Error: ${error.message}`);
      
      // Fallback to saved content if available
      const savedEmailPath = `/tmp/gmail-content-2025-09-03T13-12-26-493Z.txt`;
      if (fs.existsSync(savedEmailPath)) {
        console.log(`   🔄 Using saved content as fallback...`);
        const rawContent = fs.readFileSync(savedEmailPath, 'utf8');
        return {
          emailId: gmailId,
          gmailId: gmailId, 
          gmailThreadId: 'saved-thread',
          rawEmailContent: rawContent,
          headers: this.extractHeadersFromSavedContent(rawContent, gmailId)
        };
      }
      
      return null;
    }
  }

  async getAuthenticatedUser() {
    try {
      // Import Prisma to get authenticated user from database
      const { prisma } = await import('../dist/database/client.js');
      
      const user = await prisma.user.findFirst({
        where: {
          gmailAccessToken: { not: null },
          gmailRefreshToken: { not: null }
        },
        select: {
          id: true,
          email: true,
          gmailAccessToken: true,
          gmailRefreshToken: true,
          gmailTokenExpiry: true
        }
      });

      if (!user) {
        console.log(`   ⚠️ No authenticated user found in database`);
        return null;
      }

      console.log(`   ✅ Found authenticated user: ${user.email}`);
      return user;

    } catch (error) {
      console.log(`   ⚠️ Error getting authenticated user: ${error.message}`);
      return null;
    }
  }

  extractHeadersFromSavedContent(rawContent, gmailId) {
    // Extract basic headers from known emails for testing
    const emailSubjects = {
      '198fb420715324ac': 'Bokningspåminnelse: Matthias anländer snart!',
      '198f78bbd1f1d56b': 'Bokning bekräftad - Dorothée Pelissou anländer 22 okt.',
      '198acf71d43f2c8f': 'Bokning bekräftad - Lisa GrÜTzenbach anländer 23 sep.',
      '19897bdd45c23d25': 'Bokning bekräftad - Cecilia Bejdén anländer 13 juli',
      '19884a906e36b9f7': 'Bokningspåminnelse: Michael anländer snart!'
    };

    return {
      subject: emailSubjects[gmailId] || 'Test Email Subject',
      from: 'Airbnb <automated@airbnb.com>',
      to: 'jon@kindell.se',
      date: new Date().toISOString(),
      messageId: `test-${gmailId}@gmail.com`
    };
  }

  createMockEmailData(gmailId) {
    // Create realistic mock email data for testing ML patterns
    const mockEmails = {
      '198fb420715324ac': {
        content: `
Bokningspåminnelse: Matthias anländer snart!

Hej Jon,

Matthias har bokat din bostad och kommer snart:

Bokningskod: HMFH9A8E35
Gäst: Matthias
Incheckning: fre 1 sep 2025
Utcheckning: sön 3 sep 2025
Antal nätter: 2

Vi ser fram emot ditt värdskap!

Hälsningar,
Airbnb-teamet
        `,
        emailType: 'booking_reminder'
      },
      
      '198f78bbd1f1d56b': {
        content: `
Bokning bekräftad - Dorothée Pelissou anländer 22 okt.

Hej Jon,

Vi bekräftar att Dorothée Pelissou har bokat din bostad:

Bokningskod: HMXQHZHRAW
Gäst: Dorothée Pelissou
Incheckning: tis 22 okt 2025
Utcheckning: tor 24 okt 2025
Antal nätter: 2

Betalningsöversikt:
Du tjänar: €722,67

Hälsningar,
Airbnb-teamet
        `,
        emailType: 'booking_confirmation'
      },

      '198acf71d43f2c8f': {
        content: `
Bokning bekräftad - Lisa GrÜTzenbach anländer 23 sep.

Hej Jon,

Vi bekräftar att Lisa GrÜTzenbach har bokat din bostad:

Bokningskod: HMFWZYKPXY
Gäst: Lisa GrÜTzenbach
Incheckning: mån 23 sep 2025
Utcheckning: ons 25 sep 2025
Antal nätter: 2

Betalningsöversikt:
Du tjänar: €785,89

Hälsningar,
Airbnb-teamet
        `,
        emailType: 'booking_confirmation'
      },

      '19897bdd45c23d25': {
        content: `
Bokning bekräftad - Cecilia Bejdén anländer 13 juli

Hej Jon,

Vi bekräftar att Cecilia Bejdén har bokat din bostad:

Bokningskod: HMF4MBHP35
Gäst: Cecilia Bejdén
Incheckning: sön 13 juli 2025
Utcheckning: tis 15 juli 2025
Antal nätter: 2

Betalningsöversikt:
Du tjänar: €3,00

Hälsningar,
Airbnb-teamet
        `,
        emailType: 'booking_confirmation'
      },

      '19884a906e36b9f7': {
        content: `
Bokningspåminnelse: Michael anländer snart!

Hej Jon,

Michael har bokat din bostad och kommer snart:

Bokningskod: HMBETK4KBD
Gäst: Michael
Incheckning: lör 12 okt 2025
Utcheckning: mån 14 okt 2025
Antal nätter: 2

Vi ser fram emot ditt värdskap!

Hälsningar,
Airbnb-teamet
        `,
        emailType: 'booking_reminder'
      }
    };

    const mockEmail = mockEmails[gmailId] || mockEmails['198fb420715324ac'];

    return {
      emailId: gmailId,
      gmailId: gmailId,
      gmailThreadId: 'test-thread',
      rawEmailContent: mockEmail.content,
      headers: this.extractHeadersFromSavedContent('', gmailId)
    };
  }

  extractRawContent(message) {
    try {
      // Same logic as main scanner
      const extractTextFromPart = (part) => {
        let text = '';
        
        if (part.body && part.body.data) {
          const decoded = Buffer.from(part.body.data, 'base64').toString('utf-8');
          text += decoded;
        }
        
        if (part.parts && part.parts.length > 0) {
          for (const subPart of part.parts) {
            text += extractTextFromPart(subPart);
          }
        }
        
        return text;
      };

      let content = extractTextFromPart(message.payload);
      
      if (!content && message.raw) {
        content = Buffer.from(message.raw, 'base64').toString('utf-8');
      }
      
      return content || '';
    } catch (error) {
      console.log(`   ⚠️ Error extracting content: ${error.message}`);
      return '';
    }
  }

  extractEmailHeaders(message) {
    try {
      const headers = message.payload?.headers || [];
      const headerMap = {};
      
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
      console.log(`   ⚠️ Error extracting headers: ${error.message}`);
      return {};
    }
  }

  async parseWithMLOnly(emailData) {
    try {
      console.log(`   🤖 Parsing with ML only (subject: "${emailData.headers?.subject}")...`);
      
      // Import ML parser directly (NO hybrid, NO OpenRouter)
      const { MLEmailParser } = await import('../dist/parsers/MLEmailParser.js');
      const mlParser = new MLEmailParser();
      
      // Try parsing as booking email first
      let result = await mlParser.parseBookingEmail(emailData);
      
      if (!result) {
        // Try payout parsing
        result = await mlParser.parsePayoutEmail(emailData);
      }

      if (!result) {
        // Try payout notification for booking
        result = await mlParser.parsePayoutNotificationForBooking(emailData);
      }
      
      return result;

    } catch (error) {
      console.log(`   ❌ ML Parsing Error: ${error.message}`);
      return null;
    }
  }

  validateResult(parsed, expected) {
    const issues = [];
    let passed = true;

    if (!parsed) {
      issues.push('ML returned null/undefined');
      return { passed: false, issues };
    }

    // Check required fields
    for (const field of testCases.validation_rules.required_fields) {
      if (!parsed[field] && expected[field]) {
        issues.push(`Missing required field: ${field}`);
        passed = false;
      }
    }

    // Check specific field matches
    for (const [key, expectedValue] of Object.entries(expected)) {
      const actualValue = parsed[key];
      
      if (expectedValue !== null && actualValue !== expectedValue) {
        issues.push(`${key}: expected '${expectedValue}', got '${actualValue}'`);
        passed = false;
      }
    }

    // Check booking code format
    if (parsed.bookingCode && !parsed.bookingCode.match(/^HM[A-Z0-9]{8}$/)) {
      issues.push(`Invalid booking code format: ${parsed.bookingCode}`);
      passed = false;
    }

    return { passed, issues };
  }

  logTestResult(testCase, parsed, validation) {
    // Quick summary mode
    console.log(`   📊 RESULTS:`);
    console.log(`      🎯 Booking: ${parsed?.bookingCode || 'MISSING'} - ${parsed?.guestName || 'MISSING'}`);
    console.log(`      📅 Dates: ${parsed?.checkInDate || 'NULL'} → ${parsed?.checkOutDate || 'NULL'}`);
    console.log(`      💰 Earnings: €${parsed?.hostEarningsEur || 'NULL'} / kr ${parsed?.hostEarningsSek || 'NULL'}`);
    
    if (validation.passed) {
      console.log(`   ✅ PASS - All expected data extracted correctly`);
    } else {
      console.log(`   ❌ ISSUES:`);
      for (const issue of validation.issues.slice(0, 3)) { // Limit to 3 main issues
        console.log(`         - ${issue}`);
      }
    }

    // Show raw content sample for analysis
    if (parsed?.rawEmailContent) {
      const content = parsed.rawEmailContent;
      console.log(`   📧 Content sample (${content.length} chars):`);
      
      // Extract key parts for pattern analysis
      const bookingCodeMatch = content.match(/HM[A-Z0-9]{8}/g);
      const guestNameMatch = content.match(/\b[A-ZÅÄÖ][a-zåäö]+ [A-ZÅÄÖ][a-zåäö]+/g);
      const dateMatches = content.match(/\b\d{1,2}\s+(jan|feb|mar|apr|maj|jun|jul|aug|sep|okt|nov|dec|januari|februari|mars|april|maj|juni|juli|augusti|september|oktober|november|december)\b/gi);
      const amountMatches = content.match(/€\s*\d+[,.]?\d*/g);
      
      console.log(`      🔍 Booking codes found: ${bookingCodeMatch?.slice(0, 2).join(', ') || 'NONE'}`);
      console.log(`      👤 Names found: ${guestNameMatch?.slice(0, 2).join(', ') || 'NONE'}`);
      console.log(`      📅 Dates found: ${dateMatches?.slice(0, 4).join(', ') || 'NONE'}`);
      console.log(`      💰 Amounts found: ${amountMatches?.slice(0, 3).join(', ') || 'NONE'}`);
    }
  }

  printSummary() {
    console.log('📊 TEST SUMMARY');
    console.log('=' .repeat(50));
    console.log(`Total Tests: ${this.results.total}`);
    console.log(`✅ Passed: ${this.results.passed}`);
    console.log(`❌ Failed: ${this.results.failed}`);
    console.log(`💥 Errors: ${this.results.errors}`);
    
    const successRate = this.results.total > 0 ? 
      ((this.results.passed / this.results.total) * 100).toFixed(1) : 0;
    
    console.log(`📈 Success Rate: ${successRate}%`);
    
    if (this.results.failed > 0 || this.results.errors > 0) {
      console.log('\n🚨 ISSUES TO FIX:');
      for (const detail of this.results.details) {
        if (!detail.passed) {
          console.log(`   ${detail.testCase}: ${detail.issues?.join(', ') || detail.error}`);
        }
      }
    }
    
    if (successRate === 100) {
      console.log('\n🎉 ALL TESTS PASSING! ML patterns are working correctly!');
    } else {
      console.log('\n🔧 Some tests failing. Update ML patterns and run again.');
    }
  }
}

// Main execution
async function main() {
  // Ensure we have environment setup
  require('dotenv').config();
  
  const runner = new MLTestRunner();
  const results = await runner.runAllTests();
  
  // Exit with error code if tests failed
  process.exit(results.failed > 0 || results.errors > 0 ? 1 : 0);
}

// Run if called directly
if (require.main === module) {
  main().catch(console.error);
}

module.exports = { MLTestRunner };