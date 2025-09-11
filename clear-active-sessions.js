#!/usr/bin/env node

/**
 * Clear Active Sessions
 * =====================
 * 
 * Quick script to clear stuck scanning sessions that are blocking new scans
 */

const { PrismaClient } = require('@prisma/client');

async function clearActiveSessions() {
  const prisma = new PrismaClient();
  
  try {
    console.log('🔍 Looking for active scanning sessions...');
    
    // Find all active sessions
    const activeSessions = await prisma.scanningSession.findMany({
      where: {
        status: { in: ['running', 'queued'] },
        completedAt: null
      },
      include: {
        user: {
          select: { email: true }
        }
      }
    });
    
    console.log(`📊 Found ${activeSessions.length} active sessions:`);
    activeSessions.forEach(session => {
      console.log(`   Session ${session.id}: User ${session.user.email}, Year ${session.year}, Status ${session.status}`);
    });
    
    if (activeSessions.length === 0) {
      console.log('✅ No active sessions to clear');
      return;
    }
    
    // Update all active sessions to cancelled
    const result = await prisma.scanningSession.updateMany({
      where: {
        status: { in: ['running', 'queued'] },
        completedAt: null
      },
      data: {
        status: 'cancelled',
        currentMessage: '🛑 Session cleared - restarting after code update',
        currentStep: 'cancelled',
        completedAt: new Date(),
        lastUpdateAt: new Date()
      }
    });
    
    console.log(`✅ Cleared ${result.count} active sessions`);
    console.log('💡 You can now start a new scan');
    
  } catch (error) {
    console.error('❌ Error clearing sessions:', error);
  } finally {
    await prisma.$disconnect();
  }
}

clearActiveSessions().catch(console.error);