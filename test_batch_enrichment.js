#!/usr/bin/env node

/**
 * Batch Enrichment POC
 * ====================
 *
 * Testar olika strategier för att göra batch Gmail-sökningar
 * istället för individuella enrichment-sökningar.
 *
 * Test scenarios:
 * 1. Individual searches (current approach)
 * 2. OR-based batch search
 * 3. Parenthesized OR search
 * 4. Multiple batch searches
 */

const { GmailClient } = require('./dist/utils/gmail-client');
const { gmailRateLimiter } = require('./dist/utils/gmail-rate-limiter');
const { prisma } = require('./dist/database/client');

// Test booking codes from recent 2024 scan
const TEST_BOOKING_CODES = [
  'HMFY3MNX5W', // Annelore - confirmed booking
  'HMEZYZQCTK', // Julie - confirmed booking
  'HMKFAWFHEE'  // Christopher - cancellation
];

async function main() {
  console.log('📧 Batch Gmail Enrichment POC');
  console.log('============================');

  // Initialize Gmail client with a real user from database
  console.log('📋 Fetching user from database...');
  const user = await prisma.user.findFirst({
    where: {
      gmailAccessToken: { not: null },
      gmailRefreshToken: { not: null }
    }
  });

  if (!user) {
    console.error('❌ No user with Gmail tokens found in database');
    process.exit(1);
  }

  console.log(`✅ Using user: ${user.email}`);
  const gmailClient = new GmailClient(user);

  const results = {
    individual: {},
    orBatch: {},
    parenthesizedOr: {},
    multiBatch: {}
  };

  console.log(`\n🧪 Testing with booking codes: ${TEST_BOOKING_CODES.join(', ')}`);

  // TEST 1: Individual searches (current approach)
  console.log('\n📊 TEST 1: Individual Searches (Current Approach)');
  console.log('=================================================');

  const individualStartTime = Date.now();

  for (const code of TEST_BOOKING_CODES) {
    const query = `${code} (from:automated@airbnb.com OR from:noreply@airbnb.com OR from:express@airbnb.com)`;
    console.log(`   🔍 Searching: ${query}`);

    try {
      const emailIds = await gmailRateLimiter.queueRequest(() =>
        gmailClient.searchEmails(query, 20)
      );
      results.individual[code] = emailIds;
      console.log(`   ✅ Found ${emailIds.length} emails for ${code}`);

      // Log first few email IDs for comparison
      if (emailIds.length > 0) {
        console.log(`      📧 Sample IDs: ${emailIds.slice(0, 3).join(', ')}${emailIds.length > 3 ? '...' : ''}`);
      }
    } catch (error) {
      console.log(`   ❌ Error for ${code}: ${error.message}`);
      results.individual[code] = [];
    }
  }

  const individualTime = Date.now() - individualStartTime;
  console.log(`   ⏱️  Individual searches took: ${individualTime}ms`);

  // TEST 2: OR-based batch search
  console.log('\n📊 TEST 2: OR-Based Batch Search');
  console.log('================================');

  const orBatchStartTime = Date.now();

  // Create a single query with all booking codes OR'd together
  const orQuery = `(${TEST_BOOKING_CODES.join(' OR ')}) (from:automated@airbnb.com OR from:noreply@airbnb.com OR from:express@airbnb.com)`;
  console.log(`   🔍 Batch query: ${orQuery}`);

  try {
    const allEmailIds = await gmailRateLimiter.queueRequest(() =>
      gmailClient.searchEmails(orQuery, 50) // Increase limit for batch
    );

    console.log(`   ✅ Found ${allEmailIds.length} total emails in batch search`);

    // Now fetch each email to determine which booking code it belongs to
    const batchResults = {};
    TEST_BOOKING_CODES.forEach(code => {
      batchResults[code] = [];
    });

    for (const emailId of allEmailIds.slice(0, Math.min(10, allEmailIds.length))) { // Test first 10 emails
      try {
        const email = await gmailRateLimiter.queueRequest(() =>
          gmailClient.getEmail(emailId)
        );

        // Extract email content to find booking codes
        const subject = email.payload?.headers?.find(h => h.name.toLowerCase() === 'subject')?.value || '';
        const snippet = email.snippet || '';
        const content = subject + ' ' + snippet;

        // Check which booking code(s) this email contains
        for (const code of TEST_BOOKING_CODES) {
          if (content.includes(code)) {
            batchResults[code].push(emailId);
            console.log(`   📧 Email ${emailId} → ${code}`);
            break; // Assume one email belongs to one booking
          }
        }
      } catch (error) {
        console.log(`   ⚠️ Could not fetch email ${emailId}: ${error.message}`);
      }
    }

    results.orBatch = batchResults;

  } catch (error) {
    console.log(`   ❌ Batch search failed: ${error.message}`);
    results.orBatch = {};
  }

  const orBatchTime = Date.now() - orBatchStartTime;
  console.log(`   ⏱️  OR batch search took: ${orBatchTime}ms`);

  // TEST 3: Parenthesized OR search (alternative syntax)
  console.log('\n📊 TEST 3: Parenthesized OR Search');
  console.log('==================================');

  const parenthesizedStartTime = Date.now();

  const parenthesizedQuery = `(${TEST_BOOKING_CODES.map(code => `"${code}"`).join(' OR ')}) AND (from:automated@airbnb.com OR from:noreply@airbnb.com OR from:express@airbnb.com)`;
  console.log(`   🔍 Parenthesized query: ${parenthesizedQuery}`);

  try {
    const emailIds = await gmailRateLimiter.queueRequest(() =>
      gmailClient.searchEmails(parenthesizedQuery, 50)
    );
    console.log(`   ✅ Found ${emailIds.length} emails with parenthesized OR`);
    results.parenthesizedOr = { combined: emailIds };
  } catch (error) {
    console.log(`   ❌ Parenthesized search failed: ${error.message}`);
    results.parenthesizedOr = {};
  }

  const parenthesizedTime = Date.now() - parenthesizedStartTime;
  console.log(`   ⏱️  Parenthesized search took: ${parenthesizedTime}ms`);

  // TEST 4: Multiple smaller batch searches
  console.log('\n📊 TEST 4: Multiple Smaller Batches');
  console.log('===================================');

  const multiBatchStartTime = Date.now();

  // Split booking codes into smaller batches (2 codes each for this test)
  const batches = [
    TEST_BOOKING_CODES.slice(0, 2),
    TEST_BOOKING_CODES.slice(2)
  ].filter(batch => batch.length > 0);

  const multiBatchResults = {};

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const batchQuery = `(${batch.join(' OR ')}) (from:automated@airbnb.com OR from:noreply@airbnb.com OR from:express@airbnb.com)`;
    console.log(`   🔍 Batch ${i + 1} query: ${batchQuery}`);

    try {
      const emailIds = await gmailRateLimiter.queueRequest(() =>
        gmailClient.searchEmails(batchQuery, 30)
      );
      console.log(`   ✅ Batch ${i + 1} found ${emailIds.length} emails`);
      multiBatchResults[`batch_${i + 1}`] = { codes: batch, emails: emailIds };
    } catch (error) {
      console.log(`   ❌ Batch ${i + 1} failed: ${error.message}`);
      multiBatchResults[`batch_${i + 1}`] = { codes: batch, emails: [] };
    }
  }

  results.multiBatch = multiBatchResults;

  const multiBatchTime = Date.now() - multiBatchStartTime;
  console.log(`   ⏱️  Multi-batch search took: ${multiBatchTime}ms`);

  // RESULTS COMPARISON
  console.log('\n📊 RESULTS COMPARISON');
  console.log('=====================');

  console.log('\n📈 Email counts per booking code:');
  console.log('Individual searches:');
  for (const [code, emails] of Object.entries(results.individual)) {
    console.log(`   ${code}: ${emails.length} emails`);
  }

  console.log('\nOR batch (after parsing):');
  for (const [code, emails] of Object.entries(results.orBatch)) {
    console.log(`   ${code}: ${emails.length} emails`);
  }

  console.log('\n⏱️  Performance comparison:');
  console.log(`   Individual searches: ${individualTime}ms (${TEST_BOOKING_CODES.length} requests)`);
  console.log(`   OR batch: ${orBatchTime}ms (1 search + email parsing)`);
  console.log(`   Parenthesized OR: ${parenthesizedTime}ms (1 request)`);
  console.log(`   Multi-batch: ${multiBatchTime}ms (${batches.length} requests)`);

  const individualAvg = individualTime / TEST_BOOKING_CODES.length;
  console.log(`   \n💡 Average time per booking (individual): ${individualAvg.toFixed(0)}ms`);

  // RECOMMENDATIONS
  console.log('\n🎯 RECOMMENDATIONS');
  console.log('==================');

  if (orBatchTime < individualTime * 0.8) {
    console.log('✅ OR batch search is significantly faster and could be viable');
    console.log('   - Requires parsing emails to determine booking ownership');
    console.log('   - May be worth implementing if parsing is efficient');
  } else {
    console.log('⚠️  Batch searching doesn\'t provide significant speed improvement');
    console.log('   - Individual searches may be more reliable');
    console.log('   - Consider sequential processing instead of parallel');
  }

  // Check accuracy
  const individualTotal = Object.values(results.individual).reduce((sum, emails) => sum + emails.length, 0);
  const batchTotal = results.orBatch ? Object.values(results.orBatch).reduce((sum, emails) => sum + emails.length, 0) : 0;

  console.log(`\n📊 Accuracy check:`);
  console.log(`   Individual total: ${individualTotal} emails`);
  console.log(`   Batch parsed total: ${batchTotal} emails`);

  if (Math.abs(individualTotal - batchTotal) <= 1) {
    console.log('✅ Batch results match individual results (within 1 email)');
  } else {
    console.log('⚠️  Batch results differ from individual - needs investigation');
  }

  console.log('\n🏁 POC Complete!');
}

main().catch(console.error);