#!/usr/bin/env node
/**
 * Rescan a specific booking via API - adapted from old system
 */
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const http = require('http');

const prisma = new PrismaClient();

async function rescanBooking(bookingCode) {
  if (!bookingCode) {
    console.error('❌ Please provide a booking code as argument');
    console.log('Usage: node rescan-booking.js HM88YSNWWE');
    process.exit(1);
  }
  
  console.log(`🔄 Starting rescan for booking: ${bookingCode}`);
  
  try {
    // Get user data
    const user = await prisma.user.findFirst({
      where: { email: 'jon@kindell.se' }
    });
    
    if (!user) {
      console.error('❌ User not found!');
      return;
    }
    
    console.log(`✅ Found user: ${user.email}`);
    
    // Generate JWT token
    const token = jwt.sign(
      { 
        userId: user.id,
        email: user.email 
      },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    
    console.log('🔑 Generated JWT token');
    
    // API call to trigger rescan
    const postData = JSON.stringify({
      bookingCode: bookingCode,
      forceRescan: true
    });
    
    const options = {
      hostname: 'localhost',
      port: 3000,
      path: '/api/rescan-booking',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Content-Length': Buffer.byteLength(postData)
      }
    };
    
    console.log(`📡 Calling API: POST ${options.hostname}:${options.port}${options.path}`);
    
    const req = http.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          
          if (res.statusCode === 200) {
            console.log('✅ Rescan completed successfully!');
            console.log('📊 Results:', response);
          } else {
            console.error(`❌ API Error (${res.statusCode}):`, response);
          }
        } catch (e) {
          console.log(`📄 Raw response (${res.statusCode}):`, data);
        }
        
        process.exit(res.statusCode === 200 ? 0 : 1);
      });
    });
    
    req.on('error', (error) => {
      console.error('❌ Request error:', error.message);
      process.exit(1);
    });
    
    req.write(postData);
    req.end();
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Parse command line argument
const bookingCode = process.argv[2];
rescanBooking(bookingCode);