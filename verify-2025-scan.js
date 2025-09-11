#!/usr/bin/env node
/**
 * Verify 2025 scan results against CSV data
 */

const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');

async function verify2025Scan() {
    const prisma = new PrismaClient();
    
    try {
        console.log('🔍 Verifying 2025 scan results against CSV data...');
        console.log('=' .repeat(60));
        
        // Get all bookings from database for 2025
        const dbBookings = await prisma.booking.findMany({
            where: {
                checkInDate: {
                    gte: new Date('2025-01-01'),
                    lt: new Date('2026-01-01')
                }
            },
            orderBy: { checkInDate: 'desc' }
        });
        
        console.log(`📊 Found ${dbBookings.length} bookings in database for 2025`);
        console.log('');
        
        // Check status distribution
        const statusCounts = {};
        dbBookings.forEach(booking => {
            const status = booking.status || 'unknown';
            statusCounts[status] = (statusCounts[status] || 0) + 1;
        });
        
        console.log('📈 Status distribution:');
        Object.entries(statusCounts).forEach(([status, count]) => {
            console.log(`   ${status}: ${count}`);
        });
        console.log('');
        
        // Try to read CSV files
        const csvDir = '/Users/jon/Projects/airbnb-old/airbnb-scanner-saas/csv';
        let csvBookings = [];
        
        if (fs.existsSync(csvDir)) {
            console.log('📄 Reading CSV files from old project...');
            const csvFiles = fs.readdirSync(csvDir).filter(file => file.endsWith('.csv'));
            console.log(`Found ${csvFiles.length} CSV files`);
            
            for (const file of csvFiles) {
                console.log(`   Reading ${file}...`);
                const content = fs.readFileSync(path.join(csvDir, file), 'utf-8');
                const lines = content.split('\n').filter(line => line.trim());
                
                // Skip header
                for (let i = 1; i < lines.length; i++) {
                    const line = lines[i];
                    if (!line.trim()) continue;
                    
                    // Parse CSV line (handling quoted values)
                    const values = [];
                    let current = '';
                    let inQuotes = false;
                    
                    for (let j = 0; j < line.length; j++) {
                        const char = line[j];
                        if (char === '"') {
                            inQuotes = !inQuotes;
                        } else if (char === ',' && !inQuotes) {
                            values.push(current.trim().replace(/^"|"$/g, ''));
                            current = '';
                        } else {
                            current += char;
                        }
                    }
                    values.push(current.trim().replace(/^"|"$/g, ''));
                    
                    if (values.length >= 9) {
                        const bookingCode = values[0];
                        const status = values[1];
                        const guestName = values[2];
                        const startDate = values[7];
                        const endDate = values[8];
                        
                        // Check if it's a 2025 booking
                        if (startDate && (startDate.includes('2025') || endDate.includes('2025'))) {
                            csvBookings.push({
                                code: bookingCode,
                                status,
                                guestName,
                                startDate,
                                endDate,
                                source: file
                            });
                        }
                    }
                }
            }
            
            console.log(`📊 Found ${csvBookings.length} 2025 bookings in CSV files`);
            console.log('');
            
            // Check CSV status distribution
            const csvStatusCounts = {};
            csvBookings.forEach(booking => {
                const status = booking.status || 'unknown';
                csvStatusCounts[status] = (csvStatusCounts[status] || 0) + 1;
            });
            
            console.log('📈 CSV status distribution:');
            Object.entries(csvStatusCounts).forEach(([status, count]) => {
                console.log(`   ${status}: ${count}`);
            });
            console.log('');
            
            // Compare specific statuses
            console.log('🔍 Status comparison:');
            const allStatuses = new Set([...Object.keys(statusCounts), ...Object.keys(csvStatusCounts)]);
            allStatuses.forEach(status => {
                const dbCount = statusCounts[status] || 0;
                const csvCount = csvStatusCounts[status] || 0;
                const diff = dbCount - csvCount;
                console.log(`   ${status}: DB=${dbCount}, CSV=${csvCount}, Diff=${diff > 0 ? '+' : ''}${diff}`);
            });
            console.log('');
            
            // Find missing bookings
            const dbCodes = new Set(dbBookings.map(b => b.bookingCode));
            const csvCodes = new Set(csvBookings.map(b => b.code));
            
            const missingInDb = csvBookings.filter(b => !dbCodes.has(b.code));
            const missingInCsv = dbBookings.filter(b => !csvCodes.has(b.bookingCode));
            
            console.log('❌ MISSING BOOKINGS:');
            console.log(`   Missing in DB (found in CSV): ${missingInDb.length}`);
            if (missingInDb.length > 0 && missingInDb.length <= 10) {
                missingInDb.forEach(booking => {
                    console.log(`      ${booking.code} - ${booking.guestName} (${booking.status})`);
                });
            } else if (missingInDb.length > 10) {
                console.log(`      [Too many to list - showing first 5]`);
                missingInDb.slice(0, 5).forEach(booking => {
                    console.log(`      ${booking.code} - ${booking.guestName} (${booking.status})`);
                });
            }
            
            console.log(`   Missing in CSV (found in DB): ${missingInCsv.length}`);
            if (missingInCsv.length > 0 && missingInCsv.length <= 10) {
                missingInCsv.forEach(booking => {
                    console.log(`      ${booking.bookingCode} - ${booking.guestName} (${booking.status})`);
                });
            }
            console.log('');
            
            // Check for cancelled bookings specifically
            const cancelledInCsv = csvBookings.filter(b => 
                b.status && (b.status.toLowerCase().includes('cancel') || b.status.toLowerCase().includes('avbok'))
            );
            const cancelledInDb = dbBookings.filter(b => 
                b.status && (b.status.toLowerCase().includes('cancel') || b.status.toLowerCase().includes('avbok'))
            );
            
            console.log('🚫 CANCELLATION ANALYSIS:');
            console.log(`   Cancelled in CSV: ${cancelledInCsv.length}`);
            console.log(`   Cancelled in DB: ${cancelledInDb.length}`);
            
            if (cancelledInCsv.length > 0) {
                console.log('   📋 Cancelled bookings in CSV:');
                cancelledInCsv.slice(0, 5).forEach(booking => {
                    console.log(`      ${booking.code} - ${booking.guestName} (${booking.status})`);
                });
                if (cancelledInCsv.length > 5) {
                    console.log(`      ... and ${cancelledInCsv.length - 5} more`);
                }
            }
            
        } else {
            console.log('❌ CSV directory not found at /Users/jon/Projects/airbnb-old/airbnb-scanner-saas/csv');
            console.log('   Cannot compare with CSV data');
        }
        
        // Show some sample bookings from DB
        console.log('📋 Sample DB bookings (first 10):');
        dbBookings.slice(0, 10).forEach((booking, i) => {
            console.log(`${i+1}. ${booking.bookingCode} - ${booking.guestName}`);
            console.log(`   Status: ${booking.status}`);
            console.log(`   Dates: ${booking.checkInDate.toISOString().split('T')[0]} → ${booking.checkOutDate.toISOString().split('T')[0]}`);
            console.log(`   Enrichment: ${booking.enrichmentStatus}`);
            console.log('');
        });
        
    } catch (error) {
        console.error('❌ Error:', error);
    } finally {
        await prisma.$disconnect();
    }
}

verify2025Scan();