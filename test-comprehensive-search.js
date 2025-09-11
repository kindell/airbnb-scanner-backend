#!/usr/bin/env node

/**
 * Test Comprehensive Gmail Search
 * ===============================
 * 
 * Tests the new comprehensive Gmail search functionality to verify
 * we're finding significantly more emails than the restrictive search
 */

const { GmailClient } = require('./dist/utils/gmail-client');
const { prisma } = require('./dist/database/client');

async function testComprehensiveSearch() {
  console.log('🎯 Testing Comprehensive Gmail Search Implementation\n');
  
  try {
    // Get user and Gmail client (assuming user ID 1)
    const userId = 1;
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });
    
    if (!user || !user.gmailAccessToken) {
      console.error('❌ No user found or Gmail access token missing');
      console.log('💡 Make sure to login first via the web interface');
      return;
    }

    // Initialize Gmail client with user data
    const gmailClient = new GmailClient(user);
    
    console.log(`🔍 Testing comprehensive search for user: ${user.email}\n`);
    
    // Test comprehensive search
    console.log('🎯 Running comprehensive search (all strategies)...\n');
    const comprehensiveResults = await gmailClient.searchAirbnbEmailsComprehensive(2024);
    
    console.log('📊 COMPREHENSIVE SEARCH RESULTS:');
    console.log(`   Total unique emails found: ${comprehensiveResults.totalEmails.length}\n`);
    
    console.log('📈 Strategy Breakdown:');
    comprehensiveResults.searchResults.forEach((strategy, index) => {
      console.log(`   ${index + 1}. ${strategy.strategy}: ${strategy.count} emails`);
      if (strategy.query.length < 100) {
        console.log(`      Query: ${strategy.query}`);
      }
      console.log('');
    });
    
    // Compare with restrictive search
    console.log('🔍 Running restrictive search (original) for comparison...\n');
    const restrictiveResults = await gmailClient.searchAirbnbBookingEmails(2024);
    
    console.log('📊 COMPARISON RESULTS:');
    console.log(`   Restrictive search: ${restrictiveResults.length} emails`);
    console.log(`   Comprehensive search: ${comprehensiveResults.totalEmails.length} emails`);
    console.log(`   Improvement: +${comprehensiveResults.totalEmails.length - restrictiveResults.length} additional emails`);
    const improvement = ((comprehensiveResults.totalEmails.length - restrictiveResults.length) / restrictiveResults.length * 100).toFixed(1);
    console.log(`   Percentage improvement: +${improvement}%\n`);
    
    // Show some example emails from each strategy
    console.log('📧 Sample emails from each strategy:');
    for (const strategy of comprehensiveResults.searchResults) {
      if (strategy.emailIds.length > 0) {
        console.log(`\n   📬 ${strategy.strategy} (showing first 3):`);
        const sampleEmails = strategy.emailIds.slice(0, 3);
        
        for (const emailId of sampleEmails) {
          try {
            const email = await gmailClient.getEmail(emailId);
            const subject = email.payload?.headers?.find(h => h.name === 'Subject')?.value || 'No subject';
            const from = email.payload?.headers?.find(h => h.name === 'From')?.value || 'Unknown sender';
            const date = email.payload?.headers?.find(h => h.name === 'Date')?.value || 'Unknown date';
            
            console.log(`      • ${emailId.substring(0, 10)}... - "${subject}" (${from})`);
          } catch (error) {
            console.log(`      • ${emailId.substring(0, 10)}... - Error reading email: ${error.message}`);
          }
        }
      }
    }
    
    // Summary and impact assessment
    console.log('\n🎯 IMPLEMENTATION ASSESSMENT:');
    if (comprehensiveResults.totalEmails.length <= restrictiveResults.length) {
      console.log('❌ No improvement detected - comprehensive search may have issues');
    } else if (comprehensiveResults.totalEmails.length > restrictiveResults.length * 2) {
      console.log('✅ EXCELLENT: Comprehensive search found 2x+ more emails!');
      console.log('   This should significantly improve booking status accuracy');
    } else {
      console.log('✅ GOOD: Comprehensive search found more emails');
      console.log('   Moderate improvement in email coverage');
    }
    
    console.log('\n💡 Next steps:');
    console.log('   - Run a full scan with the new comprehensive search');
    console.log('   - Compare booking status accuracy (should improve from 62% to 90%+)');
    console.log('   - Verify that enrichment process detects email types correctly');
    
  } catch (error) {
    console.error('❌ Error during comprehensive search test:', error);
  } finally {
    await prisma.$disconnect();
  }
}

// Run the test
testComprehensiveSearch().catch(console.error);