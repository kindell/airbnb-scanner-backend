#!/usr/bin/env node
/**
 * Debug the exact date conversion used in EmailProcessor
 */

// Simulate the exact ML parser output we saw
const mlParserOutput = {
  emailType: "booking_confirmation",
  bookingCode: "HMZQS53KKE", 
  guestName: "Felix",
  currency: "EUR",
  checkInDate: "2024-02-23",
  checkOutDate: "2024-02-25",
  nights: 2,
  guestTotalEur: 450.8,
  hostEarningsEur: 381.5,
  cleaningFeeEur: 10.5,
  nightlyRateEur: 125.0,
  serviceFeeEur: 58.8,
  propertyTaxEur: 42.0,
  guestCount: 2,
  confidence: 0.94
};

console.log('🧪 Testing EmailProcessor date conversion logic');
console.log('=' .repeat(60));

console.log('Input from ML Parser:');
console.log(`  checkInDate: "${mlParserOutput.checkInDate}" (${typeof mlParserOutput.checkInDate})`);
console.log(`  checkOutDate: "${mlParserOutput.checkOutDate}" (${typeof mlParserOutput.checkOutDate})`);
console.log('');

// Simulate EmailProcessor.filterBookingData method
function emailProcessorFilterBookingData(data) {
    // Filter out undefined/null values and format data for database
    const filtered = {};
    
    // Copy defined fields only
    const fields = [
      'bookingCode', 'guestName', 'checkInDate', 'checkOutDate', 'nights',
      'guestTotalEur', 'hostEarningsEur', 'cleaningFeeEur', 'serviceFeeEur', 'occupancyTaxEur',
      'guestTotalSek', 'hostEarningsSek', 'cleaningFeeSek', 'serviceFeeSek', 'occupancyTaxSek',
      'exchangeRate', 'status', 'aiModel', 'confidence'
    ];

    for (const field of fields) {
      if (data[field] !== undefined && data[field] !== null) {
        filtered[field] = data[field];
      }
    }

    // DEBUG: Log date conversion process
    if (filtered.checkInDate) {
      console.log(`🐛 [EMAIL PROCESSOR] EmailProcessor.filterBookingData for ${filtered.bookingCode}:`);
      console.log(`   Input checkInDate: ${filtered.checkInDate} (type: ${typeof filtered.checkInDate})`);
    }

    // Convert date strings to Date objects for Prisma DateTime fields
    if (filtered.checkInDate && typeof filtered.checkInDate === 'string') {
      const originalDate = filtered.checkInDate;
      filtered.checkInDate = new Date(filtered.checkInDate);
      console.log(`   Converted "${originalDate}" to Date: ${filtered.checkInDate} (${filtered.checkInDate.toISOString()})`);
    }
    if (filtered.checkOutDate && typeof filtered.checkOutDate === 'string') {
      const originalDate = filtered.checkOutDate;
      filtered.checkOutDate = new Date(filtered.checkOutDate);
      console.log(`   Converted "${originalDate}" to Date: ${filtered.checkOutDate} (${filtered.checkOutDate.toISOString()})`);
    }

    // Set defaults for required fields
    filtered.status = filtered.status || 'confirmed';
    filtered.enrichmentStatus = 'scanning';
    filtered.enrichmentProgress = 0;
    filtered.enrichmentTotal = 0;
    filtered.hasChanges = false;
    filtered.changeCount = 0;
    filtered.parseAttempts = 1;

    return filtered;
}

// Simulate api.ts filterBookingData method
function apiFilterBookingData(result) {
  const { 
    rawEmailContent, 
    emailType,
    emailId,
    propertyName,
    hasTaxes,
    hostEarningsBeforeTaxEur,
    hostEarningsAfterTaxEur,
    hostEarningsBeforeTaxSek,
    hostEarningsAfterTaxSek,
    cleaningFeeBeforeTaxEur,
    cleaningFeeAfterTaxEur,
    cleaningFeeBeforeTaxSek,
    cleaningFeeAfterTaxSek,
    vatRate,
    taxDetails,
    ...filteredResult 
  } = result;
  
  console.log(`🐛 [API] api.ts filterBookingData:`);
  console.log(`   Input checkInDate: ${filteredResult.checkInDate} (type: ${typeof filteredResult.checkInDate})`);
  
  // Convert date strings to Date objects for Prisma DateTime fields
  if (filteredResult.checkInDate && typeof filteredResult.checkInDate === 'string') {
    const originalDate = filteredResult.checkInDate;
    filteredResult.checkInDate = new Date(filteredResult.checkInDate);
    console.log(`   Converted "${originalDate}" to Date: ${filteredResult.checkInDate} (${filteredResult.checkInDate.toISOString()})`);
  }
  if (filteredResult.checkOutDate && typeof filteredResult.checkOutDate === 'string') {
    const originalDate = filteredResult.checkOutDate;
    filteredResult.checkOutDate = new Date(filteredResult.checkOutDate);
    console.log(`   Converted "${originalDate}" to Date: ${filteredResult.checkOutDate} (${filteredResult.checkOutDate.toISOString()})`);
  }
  
  return filteredResult;
}

console.log('Testing EmailProcessor.filterBookingData:');
console.log('-'.repeat(40));
const emailProcessorResult = emailProcessorFilterBookingData(mlParserOutput);
console.log('Result:');
console.log(`  checkInDate: ${emailProcessorResult.checkInDate} (year: ${emailProcessorResult.checkInDate.getFullYear()})`);
console.log(`  checkOutDate: ${emailProcessorResult.checkOutDate} (year: ${emailProcessorResult.checkOutDate.getFullYear()})`);
console.log('');

console.log('Testing api.ts filterBookingData:');
console.log('-'.repeat(40));
const apiResult = apiFilterBookingData(mlParserOutput);
console.log('Result:');
console.log(`  checkInDate: ${apiResult.checkInDate} (year: ${apiResult.checkInDate.getFullYear()})`);
console.log(`  checkOutDate: ${apiResult.checkOutDate} (year: ${apiResult.checkOutDate.getFullYear()})`);
console.log('');

// Test if there's a difference in the conversion
console.log('🔍 Comparison:');
console.log(`EmailProcessor year: ${emailProcessorResult.checkInDate.getFullYear()}`);
console.log(`API year: ${apiResult.checkInDate.getFullYear()}`);

if (emailProcessorResult.checkInDate.getFullYear() !== apiResult.checkInDate.getFullYear()) {
    console.log('❌ DIFFERENCE FOUND! The two methods produce different years!');
} else {
    console.log('✅ Both methods produce the same year');
}