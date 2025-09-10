/**
 * Debug script to extract specific email content for analysis
 */

const fs = require('fs');
const path = require('path');

// Test case we want to debug
const CECILIA_GMAIL_ID = '19897bdd45c23d25';

async function debugCeciliaEmail() {
  try {
    console.log('🔍 Debugging Cecilia email content...');
    
    // Import Gmail service
    const { PrismaClient } = require('@prisma/client');
    const { google } = require('googleapis');
    
    const prisma = new PrismaClient();
    
    // Get authenticated user
    const user = await prisma.user.findFirst({
      where: {
        gmailAccessToken: { not: null },
        gmailRefreshToken: { not: null }
      }
    });
    
    if (!user) {
      console.log('❌ No authenticated user found');
      return;
    }
    
    console.log(`✅ Found user: ${user.email}`);
    
    // Set up Gmail API
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
    
    oauth2Client.setCredentials({
      access_token: user.gmailAccessToken,
      refresh_token: user.gmailRefreshToken
    });
    
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    
    // Get the specific email
    console.log(`📧 Fetching email ${CECILIA_GMAIL_ID}...`);
    
    const response = await gmail.users.messages.get({
      userId: 'me',
      id: CECILIA_GMAIL_ID,
      format: 'full'
    });
    
    const message = response.data;
    
    // Extract content
    const extractTextFromPart = (part) => {
      let text = '';
      
      if (part.mimeType === 'text/plain' && part.body?.data) {
        text += Buffer.from(part.body.data, 'base64').toString('utf-8');
      } else if (part.mimeType === 'text/html' && part.body?.data) {
        text += Buffer.from(part.body.data, 'base64').toString('utf-8');
      }
      
      if (part.parts && part.parts.length > 0) {
        for (const subPart of part.parts) {
          text += extractTextFromPart(subPart);
        }
      }
      
      return text;
    };
    
    let content = extractTextFromPart(message.payload);
    
    console.log(`📝 Raw content length: ${content.length} chars`);
    
    // Save to file for analysis
    const outputFile = path.join(__dirname, 'cecilia-email-raw.txt');
    fs.writeFileSync(outputFile, content, 'utf8');
    console.log(`💾 Raw content saved to: ${outputFile}`);
    
    // Clean HTML content like the ML parser does
    const { cleanEmailContent } = await import('../dist/utils/html-cleaner.js');
    const cleanedContent = cleanEmailContent(content);
    
    console.log(`🧹 Cleaned content length: ${cleanedContent.length} chars`);
    
    const cleanedFile = path.join(__dirname, 'cecilia-email-cleaned.txt');
    fs.writeFileSync(cleanedFile, cleanedContent, 'utf8');
    console.log(`💾 Cleaned content saved to: ${cleanedFile}`);
    
    // Extract headers
    const headers = message.payload?.headers || [];
    const headerMap = {};
    
    for (const header of headers) {
      headerMap[header.name.toLowerCase()] = header.value;
    }
    
    console.log(`📧 Subject: "${headerMap.subject}"`);
    console.log(`📧 From: "${headerMap.from}"`);
    
    // Run ML classification on this specific email
    console.log('\n🤖 Running ML classification...');
    
    const { spawn } = require('child_process');
    const classifyScript = path.join(__dirname, 'classify_email.py');
    
    const python = spawn('python3', [classifyScript], {
      cwd: __dirname,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    let output = '';
    let errorOutput = '';
    
    const emailData = {
      subject: headerMap.subject,
      sender: headerMap.from,
      body: cleanedContent
    };
    
    python.stdin.write(JSON.stringify(emailData));
    python.stdin.end();
    
    python.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    python.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });
    
    python.on('close', (code) => {
      if (code !== 0) {
        console.error('❌ Python script error:', errorOutput);
        return;
      }
      
      try {
        const result = JSON.parse(output.trim());
        console.log('\n📊 ML RESULT:');
        console.log(`   Email Type: ${result.emailType} (confidence: ${result.confidence})`);
        console.log(`   Booking Code: ${result.bookingCode}`);
        console.log(`   Guest Name: ${result.guestName}`);
        console.log(`   Check-in: ${result.checkInDate}`);
        console.log(`   Check-out: ${result.checkOutDate}`);
        console.log(`   Nights: ${result.nights}`);
        console.log(`   Host Earnings EUR: ${result.hostEarningsEur}`);
        
        console.log('\n🎯 EXPECTED vs ACTUAL:');
        console.log(`   Check-in: Expected 2025-07-13, Got ${result.checkInDate}`);
        console.log(`   Check-out: Expected 2025-07-15, Got ${result.checkOutDate}`);
        console.log(`   Host Earnings: Expected 3.0, Got ${result.hostEarningsEur}`);
        
      } catch (error) {
        console.error('❌ Failed to parse result:', error.message);
        console.log('Raw output:', output);
      }
      
      process.exit(0);
    });
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

debugCeciliaEmail();