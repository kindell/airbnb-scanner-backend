#!/usr/bin/env node
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');

const prisma = new PrismaClient();

async function simpleComparison() {
  try {
    console.log('🔍 SIMPLE BOOKING CODE COMPARISON');
    console.log('='.repeat(50));
    
    // Get database booking codes
    const dbBookings = await prisma.booking.findMany({
      select: { bookingCode: true, guestName: true }
    });
    
    console.log(`📊 Database bookings: ${dbBookings.length}`);
    console.log('First 10 database bookings:');
    dbBookings.slice(0, 10).forEach((b, i) => {
      console.log(`  ${i+1}. ${b.bookingCode} - ${b.guestName || 'No name'}`);
    });
    
    // Load first CSV file to see format
    const csvFile = path.join(__dirname, 'csv', 'reservations (0).csv');
    const csvContent = fs.readFileSync(csvFile, 'utf8');
    const lines = csvContent.split('\n').slice(1, 11); // Skip header, get first 10
    
    console.log('\n📄 First 10 CSV entries:');
    lines.forEach((line, i) => {
      if (line.trim()) {
        const parts = line.split(',');
        const bookingCode = parts[0]?.replace(/"/g, '');
        const guestName = parts[1]?.replace(/"/g, '');
        console.log(`  ${i+1}. ${bookingCode} - ${guestName}`);
      }
    });
    
    // Direct booking code comparison
    console.log('\n🎯 EXACT MATCHES:');
    const dbCodes = new Set(dbBookings.map(b => b.bookingCode));
    let matches = 0;
    
    // Read all CSV files and check for matches
    const csvDir = path.join(__dirname, 'csv');
    const csvFiles = fs.readdirSync(csvDir).filter(f => f.endsWith('.csv'));
    
    for (const file of csvFiles) {
      const filePath = path.join(csvDir, file);
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n').slice(1); // Skip header
      
      for (const line of lines) {
        if (line.trim()) {
          const parts = line.split(',');
          const bookingCode = parts[0]?.replace(/"/g, '');
          if (dbCodes.has(bookingCode)) {
            const guestName = parts[1]?.replace(/"/g, '');
            console.log(`  ✅ MATCH: ${bookingCode} - ${guestName}`);
            matches++;
          }
        }
      }
    }
    
    console.log(`\n📊 TOTAL EXACT MATCHES: ${matches}`);
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

simpleComparison();