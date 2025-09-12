import express from 'express';
import { PrismaClient } from '@prisma/client';
import { GmailClient } from '../utils/gmail-client';
import { authenticateJWT } from '../middleware/auth';

const router = express.Router();
const prisma = new PrismaClient();

// Apply authentication to all routes
router.use(authenticateJWT as express.RequestHandler);

interface YearStats {
  year: number;
  gmailCount: number;
  dbBookings: number;
  dbPayouts: number;
  scanSuggestion: 'recommended' | 'optional' | 'complete';
  lastScanned?: string;
}

interface GmailOverview {
  yearStats: YearStats[];
  totalGmailEmails: number;
  totalDbBookings: number;
  totalDbPayouts: number;
  recommendedYears: number[];
}

// GET /api/gmail/year-overview
router.get('/year-overview', async (req: any, res: any) => {
  try {
    console.log('🔍 Fetching Gmail year overview...');
    
    const gmailClient = new GmailClient(req.user);
    
    // Get years from 2020 to current year
    const currentYear = new Date().getFullYear();
    const years = [];
    for (let year = 2020; year <= currentYear; year++) {
      years.push(year);
    }
    
    console.log(`📅 Checking years: ${years.join(', ')}`);
    
    // Parallel queries for each year
    const yearPromises = years.map(async (year): Promise<YearStats> => {
      // Quick Gmail search for booking confirmations in this year
      const gmailQuery = `from:automated@airbnb.com (subject:"bokning bekräftad" OR subject:"booking confirmed" OR subject:"reservation confirmed") after:${year}/1/1 before:${year}/12/31`;
      
      try {
        const gmailMessages = await gmailClient.searchEmails(gmailQuery, 500);
        const gmailCount = gmailMessages.length;
        
        // Get existing bookings and payouts for this year from DB
        // IMPORTANT: Focus on emailDate (when confirmation was sent) not checkInDate (when booking is)
        const [dbBookings, dbPayouts, lastSession] = await Promise.all([
          prisma.booking.count({
            where: {
              userId: req.user!.id,
              emailDate: {
                gte: new Date(`${year}-01-01`),
                lt: new Date(`${year + 1}-01-01`)
              }
            }
          }),
          prisma.payout.count({
            where: {
              userId: req.user!.id,
              emailDate: {
                gte: new Date(`${year}-01-01`),
                lt: new Date(`${year + 1}-01-01`)
              }
            }
          }),
          prisma.scanningSession.findFirst({
            where: {
              userId: req.user!.id,
              year: year,
              status: { in: ['completed', 'failed'] }
            },
            orderBy: { completedAt: 'desc' }
          })
        ]);
        
        // Determine scan suggestion
        let scanSuggestion: 'recommended' | 'optional' | 'complete';
        
        if (gmailCount === 0) {
          scanSuggestion = 'complete'; // No emails found
        } else if (dbBookings < gmailCount * 0.7) {
          // Less than 70% of emails converted to bookings
          scanSuggestion = 'recommended';
        } else {
          scanSuggestion = 'optional';
        }
        
        return {
          year,
          gmailCount,
          dbBookings,
          dbPayouts,
          scanSuggestion,
          lastScanned: lastSession?.completedAt?.toISOString()
        };
        
      } catch (error: any) {
        console.error(`❌ Error checking year ${year}:`, error.message);
        return {
          year,
          gmailCount: 0,
          dbBookings: 0,
          dbPayouts: 0,
          scanSuggestion: 'optional' as const
        };
      }
    });
    
    const yearStats = await Promise.all(yearPromises);
    
    // Calculate totals
    const totalGmailEmails = yearStats.reduce((sum, stat) => sum + stat.gmailCount, 0);
    const totalDbBookings = yearStats.reduce((sum, stat) => sum + stat.dbBookings, 0);
    const totalDbPayouts = yearStats.reduce((sum, stat) => sum + stat.dbPayouts, 0);
    
    // Get recommended years
    const recommendedYears = yearStats
      .filter(stat => stat.scanSuggestion === 'recommended')
      .map(stat => stat.year)
      .sort((a, b) => b - a); // Most recent first
    
    const overview: GmailOverview = {
      yearStats: yearStats.sort((a, b) => b.year - a.year), // Most recent first
      totalGmailEmails,
      totalDbBookings,
      totalDbPayouts,
      recommendedYears
    };
    
    console.log(`✅ Gmail overview complete:`);
    console.log(`   📧 Total Gmail emails: ${totalGmailEmails}`);
    console.log(`   📋 Total DB bookings: ${totalDbBookings}`);
    console.log(`   💰 Total DB payouts: ${totalDbPayouts}`);
    console.log(`   🎯 Recommended years: ${recommendedYears.join(', ')}`);
    
    res.json({
      success: true,
      data: overview
    });
    
  } catch (error: any) {
    console.error('❌ Gmail year overview failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;