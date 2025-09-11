#!/usr/bin/env node
/**
 * Test to reproduce the date conversion bug between ML parser and database
 */

console.log('🔍 Testing Date Conversion Bug');
console.log('=' .repeat(50));

// Test different date inputs that might come from ML parser
const testDates = [
    '2024-04-16',
    '2024-04-16T00:00:00.000Z',
    '2024-04-16T00:00:00Z',
    'Tue, 16 Apr 2024 00:00:00 GMT',
    'April 16, 2024',
    '04/16/2024',
    '16/04/2024'
];

console.log('Testing various date string formats:');
console.log('');

testDates.forEach((dateStr, i) => {
    console.log(`${i+1}. Input: "${dateStr}" (type: ${typeof dateStr})`);
    
    try {
        const dateObj = new Date(dateStr);
        console.log(`   Result: ${dateObj.toISOString()}`);
        console.log(`   Local: ${dateObj.toLocaleDateString('sv-SE')}`);
        console.log(`   Valid: ${!isNaN(dateObj.getTime())}`);
        
        // Check if the year is wrong
        if (dateObj.getFullYear() !== 2024) {
            console.log(`   ❌ WRONG YEAR: Expected 2024, got ${dateObj.getFullYear()}`);
        } else {
            console.log(`   ✅ Correct year: ${dateObj.getFullYear()}`);
        }
        
    } catch (error) {
        console.log(`   ❌ Error: ${error.message}`);
    }
    console.log('');
});

// Test the exact filterBookingData logic
console.log('Testing filterBookingData conversion logic:');
console.log('-'.repeat(50));

function testFilterBookingData(inputData) {
    console.log(`Input data: ${JSON.stringify(inputData, null, 2)}`);
    
    const filtered = { ...inputData };
    
    // This is the exact logic from EmailProcessor.filterBookingData
    if (filtered.checkInDate && typeof filtered.checkInDate === 'string') {
        console.log(`   Converting checkInDate: "${filtered.checkInDate}" (${typeof filtered.checkInDate})`);
        const originalDate = filtered.checkInDate;
        filtered.checkInDate = new Date(filtered.checkInDate);
        console.log(`   Result: ${filtered.checkInDate} (${filtered.checkInDate.toISOString()})`);
        console.log(`   Year: ${filtered.checkInDate.getFullYear()}`);
    }
    
    if (filtered.checkOutDate && typeof filtered.checkOutDate === 'string') {
        console.log(`   Converting checkOutDate: "${filtered.checkOutDate}" (${typeof filtered.checkOutDate})`);
        const originalDate = filtered.checkOutDate;
        filtered.checkOutDate = new Date(filtered.checkOutDate);
        console.log(`   Result: ${filtered.checkOutDate} (${filtered.checkOutDate.toISOString()})`);
        console.log(`   Year: ${filtered.checkOutDate.getFullYear()}`);
    }
    
    return filtered;
}

// Test with typical ML parser output
console.log('\n1. Testing typical ML parser output:');
const mlOutput = {
    bookingCode: 'HM2DRY9WAA',
    checkInDate: '2024-04-16',
    checkOutDate: '2024-04-18',
    guestName: 'Test Guest'
};

const result1 = testFilterBookingData(mlOutput);

console.log('\n2. Testing with different date format:');
const mlOutput2 = {
    bookingCode: 'HM2DRY9WAA',
    checkInDate: '2024-04-16T00:00:00.000Z',
    checkOutDate: '2024-04-18T00:00:00.000Z',
    guestName: 'Test Guest'
};

const result2 = testFilterBookingData(mlOutput2);

// Check system locale and timezone
console.log('\n📍 System Information:');
console.log(`Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
console.log(`Locale: ${Intl.DateTimeFormat().resolvedOptions().locale}`);
console.log(`Current time: ${new Date().toISOString()}`);
console.log(`Today (local): ${new Date().toLocaleDateString('sv-SE')}`);