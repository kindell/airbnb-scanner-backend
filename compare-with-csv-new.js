#!/usr/bin/env node

/**
 * Compare New System Results with CSV
 * ===================================
 * 
 * Compares the results from our new "old system approach" scan 
 * with the CSV truth data to see if we get better accuracy.
 */

const { PrismaClient } = require('@prisma/client');
const fs = require('fs');

async function compareWithCSV() {
  const prisma = new PrismaClient();
  
  try {
    console.log('📊 NEW SYSTEM (Old Approach) vs CSV COMPARISON');
    console.log('='.repeat(50));
    
    // Get all bookings from database (from latest scan)
    const dbBookings = await prisma.booking.findMany({
      where: {
        userId: 1
      },
      orderBy: {
        bookingCode: 'asc'
      },
      select: {
        bookingCode: true,
        status: true,
        checkInDate: true,
        checkOutDate: true,
        hostEarningsEur: true,
        guestName: true,
        enrichmentStatus: true
      }
    });
    
    console.log(`🔍 Found ${dbBookings.length} bookings in database from new scan`);
    
    // Read CSV file
    const csvPath = '/Users/jon/Projects/airbnb-old/airbnb-scanner-saas/data/2025_bookings_truth.csv';
    if (!fs.existsSync(csvPath)) {
      console.log(`❌ CSV file not found: ${csvPath}`);
      return;
    }
    
    const csvContent = fs.readFileSync(csvPath, 'utf-8');
    const csvLines = csvContent.split('\n').filter(line => line.trim());
    const csvBookings = [];
    
    // Parse CSV (skip header)
    for (let i = 1; i < csvLines.length; i++) {
      const line = csvLines[i];
      if (!line.trim()) continue;
      
      const parts = line.split(',').map(part => part.replace(/"/g, '').trim());
      if (parts.length >= 6) {
        csvBookings.push({
          bookingCode: parts[0],
          checkInDate: parts[1],
          checkOutDate: parts[2], 
          guestName: parts[3],
          status: parts[4],
          hostEarningsEur: parseFloat(parts[5]) || 0
        });
      }
    }
    
    console.log(`📋 Found ${csvBookings.length} bookings in CSV truth data\n`);
    
    // Create lookup maps
    const dbMap = new Map();
    dbBookings.forEach(booking => {
      dbMap.set(booking.bookingCode, booking);
    });
    
    const csvMap = new Map();
    csvBookings.forEach(booking => {
      csvMap.set(booking.bookingCode, booking);
    });
    
    // Analysis
    let totalInCSV = csvBookings.length;
    let foundInDB = 0;
    let correctStatus = 0;
    let correctEarnings = 0;
    let correctGuest = 0;
    
    const missing = [];
    const statusMismatches = [];
    const earningsMismatches = [];
    const guestMismatches = [];
    
    console.log('📈 DETAILED COMPARISON');
    console.log('-'.repeat(50));
    
    csvBookings.forEach(csvBooking => {
      const dbBooking = dbMap.get(csvBooking.bookingCode);
      
      if (dbBooking) {
        foundInDB++;
        
        // Status comparison
        const csvStatus = csvBooking.status.toLowerCase();
        const dbStatus = (dbBooking.status || 'confirmed').toLowerCase();
        
        if (csvStatus === dbStatus) {
          correctStatus++;
        } else {
          statusMismatches.push({
            code: csvBooking.bookingCode,
            csv: csvStatus,
            db: dbStatus,
            enrichment: dbBooking.enrichmentStatus
          });
        }
        
        // Earnings comparison (within 5 EUR tolerance)
        const csvEarnings = csvBooking.hostEarningsEur || 0;
        const dbEarnings = dbBooking.hostEarningsEur || 0;
        
        if (Math.abs(csvEarnings - dbEarnings) <= 5) {
          correctEarnings++;
        } else {
          earningsMismatches.push({
            code: csvBooking.bookingCode,
            csv: csvEarnings,
            db: dbEarnings
          });
        }
        
        // Guest name comparison
        const csvGuest = (csvBooking.guestName || '').toLowerCase().trim();
        const dbGuest = (dbBooking.guestName || '').toLowerCase().trim();
        
        if (csvGuest && dbGuest && csvGuest === dbGuest) {
          correctGuest++;
        } else if (!csvGuest && !dbGuest) {
          correctGuest++; // Both empty
        } else if (csvGuest && dbGuest) {
          guestMismatches.push({
            code: csvBooking.bookingCode,
            csv: csvGuest,
            db: dbGuest
          });
        }
        
      } else {
        missing.push(csvBooking.bookingCode);
      }
    });
    
    // Calculate percentages
    const bookingCodeAccuracy = (foundInDB / totalInCSV * 100).toFixed(1);
    const statusAccuracy = (correctStatus / foundInDB * 100).toFixed(1);
    const earningsAccuracy = (correctEarnings / foundInDB * 100).toFixed(1);
    const guestAccuracy = (correctGuest / foundInDB * 100).toFixed(1);
    
    console.log('📊 RESULTS SUMMARY');
    console.log('='.repeat(50));
    console.log(`📋 Total bookings in CSV: ${totalInCSV}`);
    console.log(`✅ Found in database: ${foundInDB} (${bookingCodeAccuracy}%)`);
    console.log(`🎯 Correct status: ${correctStatus}/${foundInDB} (${statusAccuracy}%)`);
    console.log(`💰 Correct earnings: ${correctEarnings}/${foundInDB} (${earningsAccuracy}%)`);
    console.log(`👤 Correct guest: ${correctGuest}/${foundInDB} (${guestAccuracy}%)`);
    
    if (missing.length > 0) {
      console.log(`\n❌ MISSING BOOKINGS (${missing.length}):`);
      missing.forEach(code => console.log(`   ${code}`));
    }
    
    if (statusMismatches.length > 0) {
      console.log(`\n🔄 STATUS MISMATCHES (${statusMismatches.length}):`);
      statusMismatches.forEach(m => {
        console.log(`   ${m.code}: CSV="${m.csv}" DB="${m.db}" (enrichment: ${m.enrichment})`);
      });
    }
    
    if (earningsMismatches.length > 5) {
      console.log(`\n💰 EARNINGS MISMATCHES (showing first 5 of ${earningsMismatches.length}):`);
      earningsMismatches.slice(0, 5).forEach(m => {
        console.log(`   ${m.code}: CSV=€${m.csv} DB=€${m.db}`);
      });
    } else if (earningsMismatches.length > 0) {
      console.log(`\n💰 EARNINGS MISMATCHES (${earningsMismatches.length}):`);
      earningsMismatches.forEach(m => {
        console.log(`   ${m.code}: CSV=€${m.csv} DB=€${m.db}`);
      });
    }
    
    console.log('\n🚀 NEW SYSTEM PERFORMANCE:');
    console.log(`   🎯 Status Accuracy: ${statusAccuracy}% (was 62% before)`);
    console.log(`   📧 Booking Detection: ${bookingCodeAccuracy}% (was 100% before)`);
    
    if (parseFloat(statusAccuracy) > 62) {
      console.log(`   ✅ IMPROVEMENT: +${(parseFloat(statusAccuracy) - 62).toFixed(1)}% status accuracy!`);
    } else {
      console.log(`   📉 Status accuracy: ${statusAccuracy}% vs 62% before`);
    }
    
    // Extra bookings in DB
    const extraBookings = [];
    dbBookings.forEach(dbBooking => {
      if (!csvMap.has(dbBooking.bookingCode)) {
        extraBookings.push(dbBooking.bookingCode);
      }
    });
    
    if (extraBookings.length > 0) {
      console.log(`\n➕ EXTRA BOOKINGS IN DB (${extraBookings.length}):`);
      extraBookings.forEach(code => console.log(`   ${code}`));
    }
    
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

compareWithCSV().catch(console.error);