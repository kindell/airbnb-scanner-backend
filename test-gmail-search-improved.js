#!/usr/bin/env node
/**
 * Test broader Gmail search to find missing emails - adapted from old system
 */
const { PrismaClient } = require('@prisma/client');
const { google } = require('googleapis');
require('dotenv').config();

const prisma = new PrismaClient();

async function testBroadGmailSearch() {
  try {
    console.log('🔍 TESTING BROAD GMAIL SEARCH');
    console.log('=' .repeat(50));
    
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
    
    console.log('\\n📊 TESTING DIFFERENT SEARCH QUERIES:');
    console.log('-'.repeat(50));
    
    // Query 1: Current restrictive search
    console.log('\\n1️⃣ CURRENT RESTRICTIVE SEARCH:');
    const query1 = 'from:automated@airbnb.com (subject:"bokning bekräftad" OR subject:"booking confirmed" OR subject:"reservation confirmed") after:2025/1/1 before:2025/12/31';
    console.log(`Query: ${query1}`);
    
    const result1 = await gmail.users.messages.list({
      userId: 'me',
      q: query1,
      maxResults: 500
    });
    
    console.log(`📧 Found: ${result1.data.messages?.length || 0} emails`);
    
    // Query 2: All Airbnb emails from 2025
    console.log('\\n2️⃣ ALL AIRBNB EMAILS FROM 2025:');
    const query2 = 'from:automated@airbnb.com after:2025/1/1 before:2025/12/31';
    console.log(`Query: ${query2}`);
    
    const result2 = await gmail.users.messages.list({
      userId: 'me',
      q: query2,
      maxResults: 500
    });
    
    console.log(`📧 Found: ${result2.data.messages?.length || 0} emails`);
    
    // Query 3: Search for specific missed booking
    console.log('\\n3️⃣ SEARCH FOR SPECIFIC MISSED BOOKING (HM88YSNWWE):');
    const query3 = 'HM88YSNWWE';
    console.log(`Query: ${query3}`);
    
    const result3 = await gmail.users.messages.list({
      userId: 'me',
      q: query3,
      maxResults: 10
    });
    
    console.log(`📧 Found: ${result3.data.messages?.length || 0} emails with HM88YSNWWE`);
    
    // Analyze the missed emails
    if (result3.data.messages?.length > 0) {
      console.log('\\n📩 ANALYZING MISSED BOOKING EMAILS:');
      for (let i = 0; i < Math.min(result3.data.messages.length, 3); i++) {
        const message = result3.data.messages[i];
        try {
          const email = await gmail.users.messages.get({
            userId: 'me',
            id: message.id,
            format: 'metadata',
            metadataHeaders: ['subject', 'from', 'date']
          });
          
          const headers = email.data.payload.headers;
          const subject = headers.find(h => h.name === 'Subject')?.value || 'No subject';
          const from = headers.find(h => h.name === 'From')?.value || 'No sender';
          const date = headers.find(h => h.name === 'Date')?.value || 'No date';
          
          console.log(`\\n  📧 Email ${i+1}:`);
          console.log(`     From: ${from}`);
          console.log(`     Subject: ${subject}`);
          console.log(`     Date: ${date}`);
          
          // Check if this email would be caught by current search
          const subjectLower = subject.toLowerCase();
          const isCaughtByCurrent = (
            from.includes('automated@airbnb.com') &&
            (subjectLower.includes('bokning bekräftad') || 
             subjectLower.includes('booking confirmed') || 
             subjectLower.includes('reservation confirmed'))
          );
          
          console.log(`     Caught by current search: ${isCaughtByCurrent ? '✅ YES' : '❌ NO'}`);
          
        } catch (error) {
          console.error(`     Error fetching email: ${error.message}`);
        }
      }
    }
    
    console.log('\\n📊 SUMMARY:');
    console.log(`Current restrictive search: ${result1.data.messages?.length || 0} emails`);
    console.log(`All Airbnb emails (2025): ${result2.data.messages?.length || 0} emails`);
    console.log(`Missed emails: ${(result2.data.messages?.length || 0) - (result1.data.messages?.length || 0)}`);
    console.log(`HM88YSNWWE specific: ${result3.data.messages?.length || 0} emails`);
    
    const missedPercentage = result2.data.messages?.length > 0 ? 
      Math.round(((result2.data.messages.length - (result1.data.messages?.length || 0)) / result2.data.messages.length) * 100) : 0;
    console.log(`📈 We are missing ~${missedPercentage}% of Airbnb emails!`);
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.response) {
      console.error('Response:', error.response.data);
    }
  } finally {
    await prisma.$disconnect();
  }
}

// Run if called directly
if (require.main === module) {
  testBroadGmailSearch();
}

module.exports = { testBroadGmailSearch };