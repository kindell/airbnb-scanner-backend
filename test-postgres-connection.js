const { PrismaClient } = require('@prisma/client');

async function testPostgreSQLConnection() {
  console.log('🐘 Testing PostgreSQL connection...');
  
  // Create Prisma client (will use whatever DATABASE_URL is set)
  const prisma = new PrismaClient();
  
  try {
    // Test basic connection
    await prisma.$connect();
    console.log('✅ Successfully connected to database');
    
    // Test simple query
    const userCount = await prisma.user.count();
    console.log(`📊 Users in database: ${userCount}`);
    
    // Test table existence by trying to query each main table
    const bookingCount = await prisma.booking.count();
    console.log(`📋 Bookings in database: ${bookingCount}`);
    
    const payoutCount = await prisma.payout.count();
    console.log(`💰 Payouts in database: ${payoutCount}`);
    
    console.log('🎉 PostgreSQL connection test successful!');
    
  } catch (error) {
    console.error('❌ PostgreSQL connection test failed:');
    console.error('Error:', error.message);
    
    if (error.code) {
      console.error('Error code:', error.code);
    }
    
    // Check if it's a schema issue
    if (error.message.includes('does not exist')) {
      console.log('💡 This might mean the schema hasn\'t been pushed to PostgreSQL yet.');
      console.log('💡 Try running: npm run db:push:postgresql');
    }
    
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Run the test
testPostgreSQLConnection();