#!/usr/bin/env node
/**
 * Debug specific booking to see what's in the Gmail email vs our database
 */
const { PrismaClient } = require('@prisma/client');
const { google } = require('googleapis');
require('dotenv').config();

const prisma = new PrismaClient();

async function debugBookingEmail() {
  const bookingCode = process.argv[2] || 'HM2DRY9WAA'; // Default to one we know
  
  try {
    console.log('🔍 DEBUGGING BOOKING EMAIL CONTENT');
    console.log('='.repeat(60));
    console.log(`Target booking: ${bookingCode}`);
    console.log('');
    
    // Get what we have in database
    const dbBooking = await prisma.booking.findFirst({
      where: { bookingCode }
    });
    
    if (!dbBooking) {
      console.error(`❌ Booking ${bookingCode} not found in database`);
      return;
    }
    
    console.log('📊 DATABASE DATA:');
    console.log(`  Guest: ${dbBooking.guestName}`);
    console.log(`  Check-in: ${dbBooking.checkInDate ? new Date(dbBooking.checkInDate).toISOString().split('T')[0] : 'null'}`);
    console.log(`  Check-out: ${dbBooking.checkOutDate ? new Date(dbBooking.checkOutDate).toISOString().split('T')[0] : 'null'}`);
    console.log(`  Host earnings: €${dbBooking.hostEarningsEur || 'N/A'}`);
    console.log(`  Gmail ID: ${dbBooking.gmailId}`);
    console.log('');
    
    // Get user credentials  
    const user = await prisma.user.findFirst({
      where: { gmailAccessToken: { not: null } }
    });
    
    if (!user) {
      console.log('❌ No Gmail credentials found');
      return;
    }
    
    console.log(`✅ Found user: ${user.email}`);
    
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_CALLBACK_URL
    );
    
    oauth2Client.setCredentials({
      access_token: user.gmailAccessToken,
      refresh_token: user.gmailRefreshToken
    });
    
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    
    // Search for this specific booking code
    console.log('📧 SEARCHING GMAIL FOR THIS BOOKING:');
    const query = `from:automated@airbnb.com OR from:noreply@airbnb.com OR from:express@airbnb.com "${bookingCode}"`;
    console.log(`Query: ${query}`);
    
    const result = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 10
    });
    
    console.log(`Found: ${result.data.messages?.length || 0} emails`);
    console.log('');
    
    if (result.data.messages?.length > 0) {
      console.log('📩 EMAIL ANALYSIS:');
      console.log('='.repeat(60));
      
      for (let i = 0; i < Math.min(result.data.messages.length, 3); i++) {
        const message = result.data.messages[i];
        try {
          const email = await gmail.users.messages.get({
            userId: 'me',
            id: message.id,
            format: 'full'
          });
          
          const headers = email.data.payload.headers;
          const subject = headers.find(h => h.name === 'Subject')?.value || 'No subject';
          const from = headers.find(h => h.name === 'From')?.value || 'No sender';
          const date = headers.find(h => h.name === 'Date')?.value || 'No date';
          
          console.log(`📧 EMAIL ${i+1}:`);
          console.log(`   Gmail ID: ${message.id}`);
          console.log(`   From: ${from}`);
          console.log(`   Subject: ${subject}`);
          console.log(`   Date: ${date}`);
          
          // Get email body
          let bodyText = '';
          const extractBody = (part) => {
            if (part.body?.data) {
              const decoded = Buffer.from(part.body.data, 'base64').toString();
              return decoded;
            }
            if (part.parts) {
              for (const subPart of part.parts) {
                const result = extractBody(subPart);
                if (result) return result;
              }
            }
            return null;
          };
          
          bodyText = extractBody(email.data.payload);
          
          if (bodyText) {
            console.log('   📝 EMAIL BODY ANALYSIS:');
            
            // Look for booking code
            const bookingMatches = bodyText.match(/HM[A-Z0-9]{8}/g);
            console.log(`      Booking codes found: ${bookingMatches?.join(', ') || 'None'}`);
            
            // Look for dates in different formats
            const datePatterns = [
              /(\d{1,2}\/\d{1,2}\/\d{4})/g,     // MM/DD/YYYY or DD/MM/YYYY
              /(\d{4}-\d{2}-\d{2})/g,           // YYYY-MM-DD
              /(\d{1,2}\.\d{1,2}\.\d{4})/g,     // DD.MM.YYYY
              /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+\d{4}/gi, // Month DD, YYYY
              /(\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4})/gi   // DD Month YYYY
            ];
            
            console.log('      📅 DATES FOUND IN EMAIL:');
            let foundDates = [];
            for (const pattern of datePatterns) {
              const matches = bodyText.match(pattern);
              if (matches) {
                foundDates.push(...matches);
              }
            }
            
            if (foundDates.length > 0) {
              foundDates.forEach(dateStr => {
                console.log(`         - "${dateStr}"`);
              });
            } else {
              console.log('         No dates found');
            }
            
            // Look for guest name
            const guestNamePatterns = [
              /Guest:\s*([^\\n\\r]+)/i,
              /Gäst:\s*([^\\n\\r]+)/i,
              /Name:\s*([^\\n\\r]+)/i,
              /Namn:\s*([^\\n\\r]+)/i
            ];
            
            console.log('      👤 GUEST NAMES FOUND:');
            let foundNames = [];
            for (const pattern of guestNamePatterns) {
              const match = bodyText.match(pattern);
              if (match) {
                foundNames.push(match[1].trim());
              }
            }
            
            if (foundNames.length > 0) {
              foundNames.forEach(name => {
                console.log(`         - "${name}"`);
              });
            } else {
              console.log('         No guest names found with patterns');
            }
            
            // Look for earnings/amounts
            const amountPatterns = [
              /€\s*[\d,]+\.?\d*/g,
              /SEK\s*[\d,]+\.?\d*/g,
              /\d+\.\d+\s*EUR/g
            ];
            
            console.log('      💰 AMOUNTS FOUND:');
            let foundAmounts = [];
            for (const pattern of amountPatterns) {
              const matches = bodyText.match(pattern);
              if (matches) {
                foundAmounts.push(...matches);
              }
            }
            
            if (foundAmounts.length > 0) {
              foundAmounts.slice(0, 5).forEach(amount => {
                console.log(`         - "${amount}"`);
              });
            } else {
              console.log('         No amounts found');
            }
            
          } else {
            console.log('   ❌ Could not extract email body');
          }
          
          console.log('');
          
        } catch (error) {
          console.error(`   ❌ Error fetching email: ${error.message}`);
        }
      }
      
      console.log('🤔 ANALYSIS:');
      console.log('Look at the dates found in the email vs what we stored in database.');
      console.log('This will help us understand where the date parsing problem occurs.');
      
    } else {
      console.log('❌ No emails found for this booking code');
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.response) {
      console.error('Response:', error.response.data);
    }
  } finally {
    await prisma.$disconnect();
  }
}

// Usage: node debug-booking-email.js [BOOKING_CODE]
debugBookingEmail();