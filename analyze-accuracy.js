const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');

const prisma = new PrismaClient();

async function loadCSVTruthData() {
  const csvDir = path.join(__dirname, 'csv');
  const csvFiles = fs.readdirSync(csvDir).filter(f => f.endsWith('.csv'));
  
  console.log(`📊 Loading truth data from ${csvFiles.length} CSV files...`);
  
  const truthData = [];
  
  for (const file of csvFiles) {
    const filePath = path.join(csvDir, file);
    console.log(`📄 Reading ${file}...`);
    
    await new Promise((resolve, reject) => {
      fs.createReadStream(filePath)
        .pipe(csv())
        .on('data', (row) => {
          // Clean and normalize the data
          const booking = {
            confirmationCode: row['Confirmation code']?.trim(),
            status: row['Status']?.trim(),
            guestName: row['Guest name']?.trim(),
            contact: row['Contact']?.trim(),
            adults: parseInt(row['# of adults']) || 0,
            children: parseInt(row['# of children']) || 0,
            infants: parseInt(row['# of infants']) || 0,
            startDate: row['Start date']?.trim(),
            endDate: row['End date']?.trim(),
            nights: parseInt(row['# of nights']) || 0,
            booked: row['Booked']?.trim(),
            listing: row['Listing']?.trim(),
            earnings: row['Earnings']?.trim(),
            source: file
          };
          
          if (booking.confirmationCode) {
            truthData.push(booking);
          }
        })
        .on('end', resolve)
        .on('error', reject);
    });
  }
  
  console.log(`✅ Loaded ${truthData.length} bookings from CSV files`);
  return truthData;
}

async function getScanResults(year = 2025) {
  console.log(`🔍 Fetching scan results for ${year}...`);
  
  const startDate = new Date(`${year}-01-01`);
  const endDate = new Date(`${year + 1}-01-01`);
  
  const bookings = await prisma.booking.findMany({
    where: {
      OR: [
        {
          checkInDate: {
            gte: startDate,
            lt: endDate
          }
        },
        {
          checkOutDate: {
            gte: startDate,
            lt: endDate
          }
        },
        {
          createdAt: {
            gte: startDate,
            lt: endDate
          }
        }
      ]
    },
    include: {
      payouts: true
    }
  });
  
  console.log(`✅ Found ${bookings.length} bookings in database for ${year}`);
  return bookings;
}

function normalizeDate(dateStr) {
  if (!dateStr) return null;
  
  // Handle different date formats
  // CSV: "7/13/2026" or "2025-08-11" 
  // DB: ISO string
  
  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return null;
    return date.toISOString().split('T')[0]; // YYYY-MM-DD format
  } catch (e) {
    return null;
  }
}

function compareBookings(truthData, scanResults) {
  console.log(`\n🔄 Comparing ${truthData.length} truth bookings vs ${scanResults.length} scan results...\n`);
  
  const analysis = {
    matched: [],
    missed: [], // In CSV but not in scan
    extra: [], // In scan but not in CSV  
    partial: [] // Found but with incorrect data
  };
  
  // Create lookup maps
  const truthByCode = new Map();
  truthData.forEach(booking => {
    if (booking.confirmationCode) {
      truthByCode.set(booking.confirmationCode.toUpperCase(), booking);
    }
  });
  
  const scanByCode = new Map();
  scanResults.forEach(booking => {
    if (booking.confirmationCode) {
      scanByCode.set(booking.confirmationCode.toUpperCase(), booking);
    }
  });
  
  // Find matches and misses
  for (const [code, truthBooking] of truthByCode) {
    const scanBooking = scanByCode.get(code);
    
    if (!scanBooking) {
      analysis.missed.push(truthBooking);
    } else {
      // Compare data quality
      const comparison = {
        code,
        truth: truthBooking,
        scan: scanBooking,
        issues: []
      };
      
      // Check guest name
      if (truthBooking.guestName && scanBooking.guestName) {
        const truthName = truthBooking.guestName.toLowerCase().trim();
        const scanName = scanBooking.guestName.toLowerCase().trim();
        if (truthName !== scanName) {
          comparison.issues.push(`Name mismatch: "${truthBooking.guestName}" vs "${scanBooking.guestName}"`);
        }
      }
      
      // Check dates
      const truthStart = normalizeDate(truthBooking.startDate);
      const scanStart = normalizeDate(scanBooking.checkInDate);
      if (truthStart && scanStart && truthStart !== scanStart) {
        comparison.issues.push(`Start date mismatch: ${truthBooking.startDate} vs ${scanBooking.checkInDate}`);
      }
      
      const truthEnd = normalizeDate(truthBooking.endDate);
      const scanEnd = normalizeDate(scanBooking.checkOutDate);
      if (truthEnd && scanEnd && truthEnd !== scanEnd) {
        comparison.issues.push(`End date mismatch: ${truthBooking.endDate} vs ${scanBooking.checkOutDate}`);
      }
      
      if (comparison.issues.length > 0) {
        analysis.partial.push(comparison);
      } else {
        analysis.matched.push(comparison);
      }
      
      scanByCode.delete(code); // Remove to track extras
    }
  }
  
  // Remaining scan results are "extra"
  for (const [code, scanBooking] of scanByCode) {
    analysis.extra.push(scanBooking);
  }
  
  return analysis;
}

function printAnalysis(analysis) {
  console.log('='.repeat(60));
  console.log('📊 BOOKING ACCURACY ANALYSIS');
  console.log('='.repeat(60));
  
  const total = analysis.matched.length + analysis.missed.length + analysis.partial.length;
  const accuracy = total > 0 ? ((analysis.matched.length / total) * 100).toFixed(1) : 0;
  
  console.log(`\n✅ PERFECTLY MATCHED: ${analysis.matched.length}`);
  console.log(`⚠️  PARTIAL MATCHES:   ${analysis.partial.length}`);
  console.log(`❌ MISSED BOOKINGS:   ${analysis.missed.length}`);
  console.log(`➕ EXTRA BOOKINGS:    ${analysis.extra.length}`);
  console.log(`\n🎯 ACCURACY RATE: ${accuracy}%\n`);
  
  if (analysis.missed.length > 0) {
    console.log('❌ MISSED BOOKINGS:');
    analysis.missed.forEach((booking, i) => {
      console.log(`${i+1}. ${booking.confirmationCode} - ${booking.guestName} (${booking.startDate} to ${booking.endDate})`);
    });
    console.log('');
  }
  
  if (analysis.partial.length > 0) {
    console.log('⚠️  PARTIAL MATCHES (with issues):');
    analysis.partial.forEach((comp, i) => {
      console.log(`${i+1}. ${comp.code} - ${comp.truth.guestName}`);
      comp.issues.forEach(issue => console.log(`   • ${issue}`));
    });
    console.log('');
  }
  
  if (analysis.extra.length > 0) {
    console.log('➕ EXTRA BOOKINGS (not in CSV):');
    analysis.extra.forEach((booking, i) => {
      console.log(`${i+1}. ${booking.confirmationCode} - ${booking.guestName || 'Unknown'}`);
    });
    console.log('');
  }
}

async function main() {
  try {
    console.log('🚀 Starting booking accuracy analysis...\n');
    
    const truthData = await loadCSVTruthData();
    const scanResults = await getScanResults(2025);
    
    const analysis = compareBookings(truthData, scanResults);
    printAnalysis(analysis);
    
    console.log('✅ Analysis complete!');
    
  } catch (error) {
    console.error('❌ Error during analysis:', error);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main();
}

module.exports = { loadCSVTruthData, getScanResults, compareBookings };