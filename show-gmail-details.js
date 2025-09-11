#!/usr/bin/env node
/**
 * Show detailed Gmail search results with specific booking codes and email IDs
 */
const { PrismaClient } = require('@prisma/client');
const { google } = require('googleapis');
require('dotenv').config();

const prisma = new PrismaClient();

async function showGmailDetails() {
  try {
    console.log('🔍 DETAILED GMAIL SEARCH RESULTS');
    console.log('=' .repeat(60));
    
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
    
    // Search for booking confirmation emails from 2025
    console.log('\n📧 SEARCHING FOR BOOKING CONFIRMATIONS (2025):');
    console.log('-'.repeat(60));
    
    const query = 'from:automated@airbnb.com (subject:"bokning bekräftad" OR subject:"booking confirmed" OR subject:"reservation confirmed") after:2025/1/1 before:2025/12/31';
    console.log(`Query: ${query}`);
    
    const result = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 10
    });
    
    console.log(`\n📊 Found: ${result.data.messages?.length || 0} emails`);
    
    if (result.data.messages?.length > 0) {
      console.log('\n📩 EMAIL DETAILS:');
      console.log('='.repeat(60));
      
      for (let i = 0; i < Math.min(result.data.messages.length, 10); i++) {
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
          
          console.log(`\n📧 EMAIL ${i+1}:`);
          console.log(`   Gmail ID: ${message.id}`);
          console.log(`   Gmail Link: https://mail.google.com/mail/u/0/#inbox/${message.id}`);
          console.log(`   From: ${from}`);
          console.log(`   Subject: ${subject}`);
          console.log(`   Date: ${date}`);
          
          // Try to extract booking code from subject and body
          const bodyData = email.data.payload.body?.data || 
                          email.data.payload.parts?.[0]?.body?.data ||
                          email.data.payload.parts?.[1]?.body?.data;
                          
          if (bodyData) {
            const body = Buffer.from(bodyData, 'base64').toString();
            const bookingCodeMatch = body.match(/HM[A-Z0-9]{8}/g);
            if (bookingCodeMatch) {
              console.log(`   🎯 BOOKING CODES FOUND: ${bookingCodeMatch.join(', ')}`);
            } else {
              console.log(`   ❌ No booking codes found in email body`);
            }
          }
          
        } catch (error) {
          console.error(`   ❌ Error fetching email: ${error.message}`);
        }
      }
    }
    
    // Now search for ANY Airbnb email from 2025
    console.log('\n\n📧 SEARCHING FOR ANY AIRBNB EMAIL FROM 2025:');
    console.log('-'.repeat(60));
    
    const broadQuery = 'from:airbnb.com after:2025/1/1 before:2025/12/31';
    console.log(`Query: ${broadQuery}`);
    
    const broadResult = await gmail.users.messages.list({
      userId: 'me',
      q: broadQuery,
      maxResults: 5
    });
    
    console.log(`\n📊 Found: ${broadResult.data.messages?.length || 0} emails`);
    
    if (broadResult.data.messages?.length > 0) {
      console.log('\n📩 SAMPLE EMAILS:');
      console.log('='.repeat(60));
      
      for (let i = 0; i < Math.min(broadResult.data.messages.length, 5); i++) {
        const message = broadResult.data.messages[i];
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
          
          console.log(`\n📧 EMAIL ${i+1}:`);
          console.log(`   Gmail ID: ${message.id}`);
          console.log(`   Gmail Link: https://mail.google.com/mail/u/0/#inbox/${message.id}`);
          console.log(`   From: ${from}`);
          console.log(`   Subject: ${subject}`);
          console.log(`   Date: ${date}`);
          
        } catch (error) {
          console.error(`   ❌ Error fetching email: ${error.message}`);
        }
      }
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

showGmailDetails();