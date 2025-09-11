#!/usr/bin/env node
/**
 * Test EmailProcessor date parsing fix
 */
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function testEmailProcessorDateFix() {
  try {
    console.log('🧪 Testing EmailProcessor date parsing fix...');
    
    // Get user
    const user = await prisma.user.findFirst();
    if (!user) {
      console.error('❌ No user found');
      return;
    }
    
    console.log(`✅ Found user: ${user.email}`);
    
    // Import the fixed EmailProcessor
    const { EmailProcessor } = require('./dist/services/email-processor');
    
    // Create a minimal test to verify date parsing
    const processor = new EmailProcessor({
      prisma,
      userId: user.id,
      user,
      sessionId: null,
      year: 2024,
      onProgress: (data) => console.log('Progress:', data.message),
      onBroadcast: () => {}
    });
    
    // Test the filterBookingData method directly (though it's private, we can test the concept)
    // Create mock booking data with string dates
    const mockBookingData = {
      bookingCode: 'TEST123',
      guestName: 'Test Guest',
      checkInDate: '2024-10-15',  // String format
      checkOutDate: '2024-10-18', // String format
      hostEarningsEur: 123.45,
      aiModel: 'test',
      confidence: 0.9
    };
    
    console.log('📤 Input data:');
    console.log('  checkInDate:', mockBookingData.checkInDate, typeof mockBookingData.checkInDate);
    console.log('  checkOutDate:', mockBookingData.checkOutDate, typeof mockBookingData.checkOutDate);
    
    // Access the private method using prototype (for testing only)
    const filteredData = processor.filterBookingData(mockBookingData);
    
    console.log('📥 Filtered data:');
    console.log('  checkInDate:', filteredData.checkInDate, typeof filteredData.checkInDate);
    console.log('  checkOutDate:', filteredData.checkOutDate, typeof filteredData.checkOutDate);
    
    // Check if dates were converted to Date objects
    const isCheckInDateFixed = filteredData.checkInDate instanceof Date;
    const isCheckOutDateFixed = filteredData.checkOutDate instanceof Date;
    
    console.log('');
    console.log('🔍 Date Conversion Test Results:');
    console.log(`  checkInDate converted to Date object: ${isCheckInDateFixed ? '✅ YES' : '❌ NO'}`);
    console.log(`  checkOutDate converted to Date object: ${isCheckOutDateFixed ? '✅ YES' : '❌ NO'}`);
    
    if (isCheckInDateFixed && isCheckOutDateFixed) {
      console.log('🎉 SUCCESS: EmailProcessor date parsing fix is working!');
      
      // Verify the actual date values
      const expectedCheckIn = new Date('2024-10-15');
      const expectedCheckOut = new Date('2024-10-18');
      
      const checkInMatch = filteredData.checkInDate.getTime() === expectedCheckIn.getTime();
      const checkOutMatch = filteredData.checkOutDate.getTime() === expectedCheckOut.getTime();
      
      console.log(`  Correct check-in date: ${checkInMatch ? '✅' : '❌'} (${filteredData.checkInDate.toISOString().split('T')[0]})`);
      console.log(`  Correct check-out date: ${checkOutMatch ? '✅' : '❌'} (${filteredData.checkOutDate.toISOString().split('T')[0]})`);
      
      if (checkInMatch && checkOutMatch) {
        console.log('🏆 PERFECT: Date values are exactly correct!');
      }
    } else {
      console.log('❌ FAILED: Date parsing fix is not working properly');
    }
    
  } catch (error) {
    console.error('❌ Test error:', error.message);
    console.error('Stack:', error.stack);
  } finally {
    await prisma.$disconnect();
  }
}

// Run the test
testEmailProcessorDateFix();