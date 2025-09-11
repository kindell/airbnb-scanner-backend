const { GmailClient } = require('./dist/utils/gmail-client');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function searchSpecificBooking() {
  try {
    console.log('🔍 Testing Gmail search for specific booking: HM88YSNWWE');
    console.log('Expected: Esther Lauritsen, booked 2025-01-13, staying 3/22-3/28/2025');
    console.log('');

    // Get user
    const user = await prisma.user.findFirst();
    if (!user) {
      console.error('No user found');
      return;
    }

    const gmailClient = new GmailClient();
    await gmailClient.initialize(user);

    console.log('📧 Searching for booking code HM88YSNWWE...');
    
    // Search directly for the booking code
    const searchQuery = 'HM88YSNWWE';
    const messages = await gmailClient.searchEmails(searchQuery);
    
    console.log(`Found ${messages.length} emails containing "HM88YSNWWE"`);
    console.log('');
    
    for (let i = 0; i < Math.min(messages.length, 5); i++) {
      const message = messages[i];
      try {
        const email = await gmailClient.getEmail(message.id);
        
        console.log(`📩 Email ${i+1}:`);
        console.log(`  ID: ${message.id}`);
        console.log(`  Date: ${email.date}`);
        console.log(`  From: ${email.from}`);
        console.log(`  Subject: ${email.subject}`);
        console.log(`  Snippet: ${email.body?.substring(0, 200)}...`);
        console.log('');
      } catch (error) {
        console.error(`Error fetching email ${message.id}:`, error.message);
      }
    }

    console.log('🔍 Now testing our original search query...');
    const originalQuery = 'from:automated@airbnb.com (subject:"bokning bekräftad" OR subject:"booking confirmed" OR subject:"reservation confirmed") after:2025/1/1 before:2025/12/31';
    const originalMessages = await gmailClient.searchEmails(originalQuery);
    
    console.log(`Original query found ${originalMessages.length} emails total`);
    
    // Check if any of the HM88YSNWWE emails are in the original results
    const originalIds = new Set(originalMessages.map(m => m.id));
    const missedEmails = messages.filter(m => !originalIds.has(m.id));
    
    console.log(`Emails with HM88YSNWWE missed by original query: ${missedEmails.length}`);
    
    if (missedEmails.length > 0) {
      console.log('');
      console.log('❌ MISSED EMAILS:');
      for (const missed of missedEmails.slice(0, 3)) {
        try {
          const email = await gmailClient.getEmail(missed.id);
          console.log(`  - From: ${email.from}`);
          console.log(`    Subject: ${email.subject}`);
          console.log(`    Date: ${email.date}`);
          console.log('');
        } catch (error) {
          console.error(`Error fetching missed email:`, error.message);
        }
      }
    }

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

searchSpecificBooking();