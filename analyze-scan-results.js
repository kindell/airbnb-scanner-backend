#!/usr/bin/env node
/**
 * Compare 2024 scan results with CSV truth data
 */
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');

const prisma = new PrismaClient();

function parseCSV(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.replace(/"/g, ''));
  
  return lines.slice(1).map(line => {
    const values = line.split(',').map(v => v.replace(/"/g, ''));
    const row = {};
    headers.forEach((header, i) => {
      row[header] = values[i] || '';
    });
    return row;
  });
}

function parseDate(dateStr) {
  // Handle format like "7/13/2026" or "2025-08-11"
  if (dateStr.includes('/')) {
    const [month, day, year] = dateStr.split('/');
    return new Date(year, month - 1, day);
  } else if (dateStr.includes('-')) {
    return new Date(dateStr);
  }
  return null;
}

function parseEarnings(earningsStr) {
  // Handle format like "€ 3,542.50"
  if (!earningsStr || earningsStr === '') return null;
  const cleaned = earningsStr.replace(/[€,\s]/g, '');
  return parseFloat(cleaned);
}

async function analyzeResults() {
  try {
    console.log('🔍 COMPARING 2024 SCAN RESULTS WITH CSV TRUTH DATA');
    console.log('='.repeat(60));
    
    // Get scan results from database
    const scanBookings = await prisma.booking.findMany({
      orderBy: { bookingCode: 'asc' }
    });
    
    console.log(`📊 Database contains ${scanBookings.length} bookings from scan`);
    
    // Read all CSV files
    const csvFiles = fs.readdirSync('./csv').filter(f => f.endsWith('.csv'));
    let allCsvBookings = [];
    
    for (const file of csvFiles) {
      const filePath = path.join('./csv', file);
      const bookings = parseCSV(filePath);
      allCsvBookings = allCsvBookings.concat(bookings);
      console.log(`📄 ${file}: ${bookings.length} bookings`);
    }
    
    console.log(`📊 CSV files contain ${allCsvBookings.length} total bookings`);
    console.log('');
    
    // Create lookup maps
    const scanMap = new Map();
    scanBookings.forEach(booking => {
      scanMap.set(booking.bookingCode, booking);
    });
    
    const csvMap = new Map();
    allCsvBookings.forEach(booking => {
      csvMap.set(booking['Confirmation code'], booking);
    });
    
    // Find matches and misses
    const matches = [];
    const scanOnlyBookings = [];
    const csvOnlyBookings = [];
    
    // Check scan results against CSV
    for (const [code, scanBooking] of scanMap) {
      if (csvMap.has(code)) {
        const csvBooking = csvMap.get(code);
        matches.push({ 
          code, 
          scan: scanBooking, 
          csv: csvBooking 
        });
      } else {
        scanOnlyBookings.push({ code, booking: scanBooking });
      }
    }
    
    // Check CSV against scan results
    for (const [code, csvBooking] of csvMap) {
      if (!scanMap.has(code)) {
        csvOnlyBookings.push({ code, booking: csvBooking });
      }
    }
    
    console.log('🎯 MATCHING ANALYSIS:');
    console.log(`✅ Found in both scan and CSV: ${matches.length}`);
    console.log(`📧 Found in scan only: ${scanOnlyBookings.length}`);
    console.log(`📄 Found in CSV only: ${csvOnlyBookings.length}`);
    console.log('');
    
    // Calculate accuracy
    const totalInCsv = allCsvBookings.length;
    const totalFound = matches.length;
    const accuracy = totalInCsv > 0 ? (totalFound / totalInCsv * 100).toFixed(1) : 0;
    
    console.log(`📈 ACCURACY: ${accuracy}% (${totalFound}/${totalInCsv})`);
    console.log('');
    
    // Analyze matches in detail
    if (matches.length > 0) {
      console.log('🔍 DETAILED MATCH ANALYSIS:');
      console.log('-'.repeat(40));
      
      let guestNameMatches = 0;
      let checkInDateMatches = 0;
      let earningsMatches = 0;
      let statusMatches = 0;
      
      matches.slice(0, 10).forEach((match, i) => {
        const { scan, csv } = match;
        console.log(`\n${i+1}. ${match.code}:`);
        
        // Guest name comparison
        const csvGuestName = csv['Guest name'];
        const scanGuestName = scan.guestName;
        const guestNameMatch = csvGuestName && scanGuestName && 
          csvGuestName.toLowerCase().includes(scanGuestName.toLowerCase());
        console.log(`   Guest: CSV="${csvGuestName}" | Scan="${scanGuestName}" ${guestNameMatch ? '✅' : '❌'}`);
        if (guestNameMatch) guestNameMatches++;
        
        // Check-in date comparison
        const csvCheckIn = parseDate(csv['Start date']);
        const scanCheckIn = scan.checkInDate ? new Date(scan.checkInDate) : null;
        const dateMatch = csvCheckIn && scanCheckIn && 
          csvCheckIn.toDateString() === scanCheckIn.toDateString();
        console.log(`   Check-in: CSV="${csv['Start date']}" | Scan="${scanCheckIn ? scanCheckIn.toISOString().split('T')[0] : 'null'}" ${dateMatch ? '✅' : '❌'}`);
        if (dateMatch) checkInDateMatches++;
        
        // Earnings comparison (if available)
        const csvEarnings = parseEarnings(csv['Earnings']);
        const scanEarnings = scan.hostEarningsEur;
        if (csvEarnings && scanEarnings) {
          const earningsMatch = Math.abs(csvEarnings - scanEarnings) < 1; // Allow 1 EUR tolerance
          console.log(`   Earnings: CSV="€${csvEarnings}" | Scan="€${scanEarnings}" ${earningsMatch ? '✅' : '❌'}`);
          if (earningsMatch) earningsMatches++;
        }
        
        // Status comparison
        const csvStatus = csv['Status'];
        const scanStatus = scan.enrichmentStatus;
        console.log(`   Status: CSV="${csvStatus}" | Scan="${scanStatus}"`);
        if (csvStatus === 'Confirmed' && (scanStatus === 'upcoming' || scanStatus === 'completed')) {
          statusMatches++;
        }
      });
      
      const sampleSize = Math.min(matches.length, 10);
      console.log(`\n📊 FIELD ACCURACY (sample of ${sampleSize}):`);
      console.log(`   Guest names: ${(guestNameMatches/sampleSize*100).toFixed(1)}% (${guestNameMatches}/${sampleSize})`);
      console.log(`   Check-in dates: ${(checkInDateMatches/sampleSize*100).toFixed(1)}% (${checkInDateMatches}/${sampleSize})`);
      console.log(`   Earnings: ${earningsMatches > 0 ? (earningsMatches/sampleSize*100).toFixed(1) : 'N/A'}%`);
      console.log(`   Status enrichment needed: ${scanBookings.filter(b => b.enrichmentStatus === 'scanning').length}/${scanBookings.length}`);
    }
    
    // Show some missed bookings
    if (csvOnlyBookings.length > 0) {
      console.log('\n❌ EXAMPLES OF MISSED BOOKINGS (in CSV but not found in scan):');
      csvOnlyBookings.slice(0, 5).forEach((missed, i) => {
        const booking = missed.booking;
        console.log(`${i+1}. ${missed.code} - ${booking['Guest name']} - ${booking['Start date']} to ${booking['End date']}`);
      });
    }
    
    // Show extra bookings found
    if (scanOnlyBookings.length > 0) {
      console.log('\n➕ EXAMPLES OF EXTRA BOOKINGS (found in scan but not in CSV):');
      scanOnlyBookings.slice(0, 5).forEach((extra, i) => {
        const booking = extra.booking;
        console.log(`${i+1}. ${extra.code} - ${booking.guestName} - ${booking.checkInDate ? new Date(booking.checkInDate).toISOString().split('T')[0] : 'No date'}`);
      });
    }
    
    console.log('\n🎯 SUMMARY:');
    console.log(`   Total accuracy: ${accuracy}%`);
    console.log(`   Scan found ${scanBookings.length} bookings`);
    console.log(`   CSV truth data has ${allCsvBookings.length} bookings`);
    console.log(`   ${matches.length} booking codes match between scan and CSV`);
    console.log(`   ${csvOnlyBookings.length} bookings were missed by the scan`);
    console.log(`   ${scanOnlyBookings.length} extra bookings found by scan`);
    console.log(`   All ${scanBookings.length} scan results need enrichment (status: "scanning")`);
    
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

// Run if called directly
if (require.main === module) {
  analyzeResults();
}

module.exports = { analyzeResults };