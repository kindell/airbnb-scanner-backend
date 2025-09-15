const { PrismaClient } = require('@prisma/client');

async function main() {
  const prisma = new PrismaClient();
  
  try {
    const bookingsCount = await prisma.booking.count();
    console.log(`Total bookings: ${bookingsCount}`);
    
    if (bookingsCount > 0) {
      const bookings = await prisma.booking.findMany({
        select: {
          bookingCode: true,
          guestName: true,
          status: true,
          enrichmentStatus: true
        },
        take: 5
      });
      console.log('First 5 bookings:', bookings);
      
      // Check specifically for HMSFBXYYD2
      const targetBooking = await prisma.booking.findFirst({
        where: { bookingCode: 'HMSFBXYYD2' }
      });
      if (targetBooking) {
        console.log('HMSFBXYYD2 found:', {
          bookingCode: targetBooking.bookingCode,
          guestName: targetBooking.guestName,
          status: targetBooking.status,
          enrichmentStatus: targetBooking.enrichmentStatus
        });
      } else {
        console.log('HMSFBXYYD2 NOT found');
      }
    }
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

main();