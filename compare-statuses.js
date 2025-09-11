#!/usr/bin/env node
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');

const prisma = new PrismaClient();

async function compareStatuses() {
  try {
    console.log('🔍 BOOKING STATUS COMPARISON');
    console.log('='.repeat(60));
    
    // Get database bookings with status info
    const dbBookings = await prisma.booking.findMany({
      select: { 
        bookingCode: true, 
        status: true,
        checkInDate: true,
        checkOutDate: true,
        guestName: true
      }
    });
    
    console.log(`📊 Database bookings: ${dbBookings.length}`);
    
    // Load CSV data and build lookup
    const csvBookings = new Map();
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
          const status = parts[1]?.replace(/"/g, ''); // Assuming status is in column 2
          csvBookings.set(bookingCode, {
            status: status,
            rawLine: line
          });
        }
      }
    }
    
    console.log(`📄 CSV bookings loaded: ${csvBookings.size}`);
    
    // Show CSV status types
    const csvStatuses = new Set();
    for (const [code, data] of csvBookings) {
      csvStatuses.add(data.status);
    }
    console.log(`\n📋 CSV Status types: ${Array.from(csvStatuses).join(', ')}`);
    
    // Show DB status types
    const dbStatuses = new Set();
    for (const booking of dbBookings) {
      dbStatuses.add(booking.status || 'null');
    }
    console.log(`🗄️ DB Status types: ${Array.from(dbStatuses).join(', ')}`);
    
    // Compare statuses
    console.log('\n🔍 STATUS COMPARISON:');
    console.log('='.repeat(60));
    
    let correctStatuses = 0;
    let incorrectStatuses = 0;
    let unknownStatuses = 0;
    
    for (const dbBooking of dbBookings) {
      const csvData = csvBookings.get(dbBooking.bookingCode);
      if (csvData) {
        const dbStatus = dbBooking.status || 'null';
        const csvStatus = csvData.status;
        
        console.log(`\n📧 ${dbBooking.bookingCode} - ${dbBooking.guestName || 'No name'}`);
        console.log(`   DB Status:  ${dbStatus}`);
        console.log(`   CSV Status: ${csvStatus}`);
        
        // Map statuses for comparison
        const dbStatusMapped = mapDbStatus(dbStatus);
        const csvStatusMapped = mapCsvStatus(csvStatus);
        
        console.log(`   DB Mapped:  ${dbStatusMapped}`);
        console.log(`   CSV Mapped: ${csvStatusMapped}`);
        
        if (dbStatusMapped === csvStatusMapped) {
          console.log(`   ✅ MATCH`);
          correctStatuses++;
        } else {
          console.log(`   ❌ MISMATCH`);
          incorrectStatuses++;
        }
      } else {
        console.log(`\n📧 ${dbBooking.bookingCode} - NOT FOUND IN CSV`);
        unknownStatuses++;
      }
    }
    
    console.log('\n📊 STATUS ACCURACY SUMMARY:');
    console.log('='.repeat(60));
    console.log(`✅ Correct statuses: ${correctStatuses}`);
    console.log(`❌ Incorrect statuses: ${incorrectStatuses}`);
    console.log(`❓ Unknown statuses: ${unknownStatuses}`);
    console.log(`🎯 Status Accuracy: ${Math.round((correctStatuses / dbBookings.length) * 100)}%`);
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

function mapDbStatus(status) {
  // Map database status to standard categories
  if (!status || status === 'null') return 'unknown';
  
  switch (status.toLowerCase()) {
    case 'confirmed': return 'confirmed';
    case 'cancelled': 
    case 'canceled': return 'cancelled';
    case 'completed': return 'completed';
    case 'past': return 'completed';
    default: return status.toLowerCase();
  }
}

function mapCsvStatus(status) {
  // Map CSV status to standard categories
  if (!status) return 'unknown';
  
  switch (status.toLowerCase()) {
    case 'confirmed': return 'confirmed';
    case 'canceled by guest':
    case 'cancelled by guest':
    case 'canceled by host':
    case 'cancelled by host': return 'cancelled';
    case 'past guest': return 'completed';
    default: return status.toLowerCase();
  }
}

compareStatuses();