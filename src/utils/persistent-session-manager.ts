/**
 * Persistent Session Manager
 * ==========================
 * 
 * Manages scanning sessions with full persistence across server restarts.
 * Provides dual-layer storage (memory + database) for optimal performance.
 */

import { prisma } from '../database/client';
import { EventEmitter } from 'events';
import { wsManager } from '../services/websocket-manager';
import { bookingUpdateEmitter } from './booking-update-emitter';

export interface EnhancedSessionStatus {
  // Core session info
  id?: number;
  userId: number;
  year: number;
  status: 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  
  // Progress tracking
  totalEmails?: number;
  processedEmails: number;
  skippedEmails: number;
  errorEmails: number;
  
  // Detailed current state
  currentEmailIndex?: number;
  currentEmailId?: string;
  currentBookingCode?: string;
  currentGuestName?: string;
  
  // Result statistics
  bookingsFound: number;
  bookingsUpdated: number;
  payoutsLinked: number;
  changesDetected: number;

  // Enrichment tracking
  enrichmentTotal: number;       // Total bookings that need enrichment
  enrichmentCompleted: number;   // Bookings that have completed enrichment
  enrichmentInProgress: number;  // Bookings currently being enriched
  
  // Performance metrics
  emailsPerMinute?: number;
  avgConfidence?: number;
  mlFailures: number;
  
  // Queue information
  queuePosition?: number;
  estimatedTimeLeft?: number;
  
  // Scope information
  searchQuery?: string;
  emailTypes?: string;
  dateRange?: string;
  
  // Error tracking
  lastError?: string;
  errorDetails?: string;
  failedEmailIds?: string;
  
  // Timestamps
  currentMessage?: string;
  currentStep?: string;
  startedAt: Date;
  completedAt?: Date;
  lastUpdateAt: Date;
  
  // Memory-only flags
  isScanning?: boolean;
  scanStartTime?: Date;
}

export class PersistentSessionManager extends EventEmitter {
  private memoryCache = new Map<number, EnhancedSessionStatus>();
  
  constructor() {
    super();
    // Restore active sessions on startup
    this.restoreActiveSessions().catch(console.error);

    // Listen for booking enrichment events to update progress
    this.setupEnrichmentListener();
  }
  
  /**
   * Restore active sessions from database on server startup
   */
  async restoreActiveSessions(): Promise<void> {
    console.log('🔄 Restoring active scanning sessions from database...');
    
    const activeSessions = await prisma.scanningSession.findMany({
      where: { 
        status: { in: ['running', 'queued'] },
        completedAt: null
      },
      orderBy: { lastUpdateAt: 'desc' }
    });
    
    let restoredCount = 0;
    for (const session of activeSessions) {
      const memorySession = this.dbSessionToMemory(session);
      this.memoryCache.set(session.userId, memorySession);
      restoredCount++;
      
      console.log(`   ✅ Restored session for user ${session.userId}: ${session.status} (${session.processedEmails}/${session.totalEmails || 0} emails)`);
    }
    
    if (restoredCount > 0) {
      console.log(`🚀 Successfully restored ${restoredCount} active scanning sessions`);
    } else {
      console.log('✨ No active scanning sessions to restore');
    }
  }
  
  /**
   * Create a new scanning session
   */
  async createSession(userId: number, year: number, searchQuery: string): Promise<EnhancedSessionStatus> {
    const now = new Date();
    
    // Create database record
    const dbSession = await prisma.scanningSession.create({
      data: {
        userId,
        year,
        status: 'queued',
        processedEmails: 0,
        skippedEmails: 0,
        errorEmails: 0,
        bookingsFound: 0,
        bookingsUpdated: 0,
        payoutsLinked: 0,
        changesDetected: 0,
        mlFailures: 0,
        searchQuery,
        startedAt: now,
        lastUpdateAt: now,
        currentMessage: 'Initialiserar scanning...',
        currentStep: 'setup'
      }
    });
    
    // Create memory record
    const memorySession: EnhancedSessionStatus = {
      ...this.dbSessionToMemory(dbSession),
      isScanning: false,
      scanStartTime: now
    };

    this.memoryCache.set(userId, memorySession);

    // DISABLED: Old individual enrichment stats - now using batch enrichment only
    // Initialize enrichment stats
    // await this.updateEnrichmentStats(userId).catch(err =>
    //   console.warn(`⚠️ Failed to initialize enrichment stats:`, err?.message)
    // );
    
    console.log(`📝 Created new scanning session ${dbSession.id} for user ${userId}, year ${year}`);
    
    return memorySession;
  }
  
  /**
   * Update session (both memory and database)
   */
  async updateSession(userId: number, updates: Partial<EnhancedSessionStatus>): Promise<void> {
    // Get current session
    const current = this.memoryCache.get(userId);
    if (!current) {
      console.warn(`⚠️  No session found for user ${userId} to update`);
      return;
    }
    
    // Update memory cache
    const updated = { 
      ...current, 
      ...updates, 
      lastUpdateAt: new Date() 
    };
    this.memoryCache.set(userId, updated);
    
    // Update database (exclude memory-only fields)
    const { isScanning, scanStartTime, ...dbUpdates } = updates;
    
    try {
      await prisma.scanningSession.update({
        where: { id: current.id },
        data: {
          ...dbUpdates,
          lastUpdateAt: updated.lastUpdateAt
        }
      });
      
      // Emit update event for real-time UI
      this.emit('session_updated', { userId, session: updated });
      
    } catch (error) {
      console.error(`❌ Failed to update database for session ${current.id}:`, error);
    }
  }
  
  /**
   * Get session (memory first, database fallback)
   */
  async getSession(userId: number): Promise<EnhancedSessionStatus | null> {
    // Check memory cache first
    const memorySession = this.memoryCache.get(userId);
    if (memorySession?.isScanning) {
      return memorySession;
    }
    
    // Fallback to database
    const dbSession = await prisma.scanningSession.findFirst({
      where: { 
        userId, 
        status: { in: ['running', 'queued'] },
        completedAt: null 
      },
      orderBy: { startedAt: 'desc' }
    });
    
    if (dbSession) {
      const restored = this.dbSessionToMemory(dbSession);
      this.memoryCache.set(userId, restored);
      console.log(`🔄 Restored session ${dbSession.id} from database for user ${userId}`);
      return restored;
    }
    
    return null;
  }
  
  /**
   * Mark session as completed
   */
  async completeSession(userId: number, results: Partial<EnhancedSessionStatus> = {}): Promise<void> {
    const current = this.memoryCache.get(userId);
    if (!current) return;
    
    const completedAt = new Date();
    
    await this.updateSession(userId, {
      ...results,
      status: 'completed',
      completedAt,
      currentMessage: 'Scanning slutförd',
      currentStep: 'completed',
      isScanning: false
    });
    
    console.log(`✅ Completed scanning session ${current.id} for user ${userId}`);
    
    // Clean up memory after delay
    setTimeout(() => {
      this.memoryCache.delete(userId);
    }, 5 * 60 * 1000); // Keep in memory for 5 minutes
  }
  
  /**
   * Mark session as failed
   */
  async failSession(userId: number, error: string, errorDetails?: any): Promise<void> {
    await this.updateSession(userId, {
      status: 'failed',
      lastError: error,
      errorDetails: errorDetails ? JSON.stringify(errorDetails) : undefined,
      currentMessage: `Fel: ${error}`,
      currentStep: 'error',
      isScanning: false
    });
    
    console.log(`❌ Failed scanning session for user ${userId}: ${error}`);
  }
  
  /**
   * Cancel session
   */
  async cancelSession(userId: number): Promise<void> {
    await this.updateSession(userId, {
      status: 'cancelled',
      currentMessage: 'Scanning avbruten',
      currentStep: 'cancelled',
      isScanning: false
    });
    
    console.log(`🛑 Cancelled scanning session for user ${userId}`);
  }
  
  /**
   * Calculate performance metrics
   */
  calculateMetrics(session: EnhancedSessionStatus): { 
    emailsPerMinute: number; 
    estimatedTimeLeft: number;
    progressPercentage: number;
  } {
    const now = new Date();
    const elapsedMinutes = session.scanStartTime 
      ? (now.getTime() - session.scanStartTime.getTime()) / (1000 * 60)
      : 1;
    
    const emailsPerMinute = session.processedEmails / Math.max(elapsedMinutes, 0.1);
    const totalEmails = session.totalEmails || 1;
    const remainingEmails = totalEmails - session.processedEmails;
    const estimatedTimeLeft = emailsPerMinute > 0 ? remainingEmails / emailsPerMinute : 0;
    const progressPercentage = Math.round((session.processedEmails / totalEmails) * 100);
    
    return {
      emailsPerMinute: Math.round(emailsPerMinute * 10) / 10,
      estimatedTimeLeft: Math.round(estimatedTimeLeft),
      progressPercentage
    };
  }
  
  /**
   * Get all active sessions (for admin/monitoring)
   */
  async getActiveSessions(): Promise<EnhancedSessionStatus[]> {
    const activeSessions = await prisma.scanningSession.findMany({
      where: { 
        status: { in: ['running', 'queued'] },
        completedAt: null 
      },
      include: { user: { select: { email: true, displayName: true } } },
      orderBy: { lastUpdateAt: 'desc' }
    });
    
    return activeSessions.map(session => ({
      ...this.dbSessionToMemory(session),
      userEmail: (session.user as any)?.email,
      userDisplayName: (session.user as any)?.displayName
    }));
  }
  
  /**
   * Convert database session to memory format
   */
  private dbSessionToMemory(dbSession: any): EnhancedSessionStatus {
    return {
      id: dbSession.id,
      userId: dbSession.userId,
      year: dbSession.year,
      status: dbSession.status,
      totalEmails: dbSession.totalEmails,
      processedEmails: dbSession.processedEmails || 0,
      skippedEmails: dbSession.skippedEmails || 0,
      errorEmails: dbSession.errorEmails || 0,
      currentEmailIndex: dbSession.currentEmailIndex,
      currentEmailId: dbSession.currentEmailId,
      currentBookingCode: dbSession.currentBookingCode,
      currentGuestName: dbSession.currentGuestName,
      bookingsFound: dbSession.bookingsFound || 0,
      bookingsUpdated: dbSession.bookingsUpdated || 0,
      payoutsLinked: dbSession.payoutsLinked || 0,
      changesDetected: dbSession.changesDetected || 0,
      enrichmentTotal: 0,        // Will be calculated dynamically
      enrichmentCompleted: 0,    // Will be calculated dynamically
      enrichmentInProgress: 0,   // Will be calculated dynamically
      emailsPerMinute: dbSession.emailsPerMinute,
      avgConfidence: dbSession.avgConfidence,
      mlFailures: dbSession.mlFailures || 0,
      queuePosition: dbSession.queuePosition,
      estimatedTimeLeft: dbSession.estimatedTimeLeft,
      searchQuery: dbSession.searchQuery,
      emailTypes: dbSession.emailTypes,
      dateRange: dbSession.dateRange,
      lastError: dbSession.lastError,
      errorDetails: dbSession.errorDetails,
      failedEmailIds: dbSession.failedEmailIds,
      currentMessage: dbSession.currentMessage,
      currentStep: dbSession.currentStep,
      startedAt: dbSession.startedAt,
      completedAt: dbSession.completedAt,
      lastUpdateAt: dbSession.lastUpdateAt,
      isScanning: dbSession.status === 'running'
    };
  }

  /**
   * Calculate enrichment statistics for a user's current scanning session
   */
  async calculateEnrichmentStats(userId: number): Promise<{
    total: number;
    completed: number;
    inProgress: number;
  }> {
    // Get the current active session to filter bookings created during this scan
    const currentSession = await prisma.scanningSession.findFirst({
      where: {
        userId,
        status: { in: ['running', 'queued'] },
        completedAt: null
      },
      orderBy: { startedAt: 'desc' }
    });

    if (!currentSession) {
      // No active session, check for recently completed sessions with ongoing enrichment
      const recentSession = await prisma.scanningSession.findFirst({
        where: {
          userId,
          status: 'completed',
          completedAt: {
            gte: new Date(Date.now() - 10 * 60 * 1000) // Within last 10 minutes
          }
        },
        orderBy: { completedAt: 'desc' }
      });

      if (!recentSession) {
        return { total: 0, completed: 0, inProgress: 0 };
      }

      // Use recent session for stats calculation
      const whereClause: any = {
        userId,
        createdAt: {
          gte: recentSession.startedAt
        }
      };

      if (recentSession.completedAt) {
        whereClause.createdAt.lte = recentSession.completedAt;
      }

      const stats = await prisma.booking.groupBy({
        by: ['enrichmentStatus'],
        where: whereClause,
        _count: { id: true }
      });

      let total = 0, completed = 0, inProgress = 0;

      stats.forEach(stat => {
        const count = stat._count?.id || 0;
        total += count;
        if (['completed', 'upcoming', 'cancelled'].includes(stat.enrichmentStatus)) {
          completed += count;
        } else if (stat.enrichmentStatus === 'enriching') {
          inProgress += count;
        }
      });

      return { total, completed, inProgress };
    }

    const stats = await prisma.booking.groupBy({
      by: ['enrichmentStatus'],
      where: {
        userId,
        createdAt: {
          gte: currentSession.startedAt // Only bookings from current scan session
        }
      },
      _count: {
        id: true
      }
    });

    let total = 0;
    let completed = 0;
    let inProgress = 0;

    stats.forEach(stat => {
      const count = stat._count?.id || 0;
      total += count;

      if (['completed', 'upcoming', 'cancelled'].includes(stat.enrichmentStatus)) {
        completed += count;
      } else if (stat.enrichmentStatus === 'enriching') {
        inProgress += count;
      }
      // Note: 'scanning' status bookings are counted in total but not in completed/inProgress
      // This is intentional - they haven't started enrichment yet
    });

    return { total, completed, inProgress };
  }

  /**
   * Set up listener for booking enrichment events
   */
  private setupEnrichmentListener(): void {
    bookingUpdateEmitter.on('booking_update', async (eventData: any) => {
      // Only listen for enrichment events
      if (eventData.eventType === 'enriched') {
        console.log(`🔔 Received enrichment event for user ${eventData.userId}, booking ${eventData.bookingId}`);

        // DISABLED: Old individual enrichment stats - now using batch enrichment only
        // Update enrichment stats for this user's session
        // await this.updateEnrichmentStats(eventData.userId).catch(err => {
        //   console.warn(`⚠️ Failed to update enrichment stats for user ${eventData.userId}:`, err?.message);
        // });
      }
    });

    console.log('🎧 Set up enrichment event listener for session progress updates');
  }

  /**
   * Update enrichment stats for a session
   */
  async updateEnrichmentStats(userId: number): Promise<void> {
    let session: EnhancedSessionStatus | undefined | null = this.memoryCache.get(userId);

    // If session not in memory, try to restore from database
    if (!session) {
      console.log(`🔍 [DEBUG] No session found in memory for user ${userId}, attempting to restore from database...`);
      session = await this.getSession(userId);

      if (!session) {
        console.log(`🔍 [DEBUG] No active session found for user ${userId} in updateEnrichmentStats`);
        return;
      }

      console.log(`🔄 Restored session ${session.id} for enrichment stats update`);
    }

    const stats = await this.calculateEnrichmentStats(userId);
    console.log(`🔍 [DEBUG] Enrichment stats for user ${userId}:`, stats);
    session.enrichmentTotal = stats.total;
    session.enrichmentCompleted = stats.completed;
    session.enrichmentInProgress = stats.inProgress;
    session.lastUpdateAt = new Date();

    // Broadcast enrichment progress via WebSocket
    // Only send enrichment data as an update, don't override main progress
    if (wsManager && stats.total > 0) {
      const enrichmentUpdate = {
        // Only add enrichment data - don't touch main status/message/progress
        enrichment: {
          total: stats.total,
          completed: stats.completed,
          inProgress: stats.inProgress,
          percentage: stats.total > 0 ? Math.round((stats.completed / stats.total) * 100) : 0,
          status: stats.completed >= stats.total ? 'completed' : 'processing',
          message: `🧠 Enriching: ${stats.completed}/${stats.total} bookings completed${stats.inProgress > 0 ? ` (${stats.inProgress} in progress...)` : ''}`
        }
      };

      console.log(`🔍 [DEBUG] Broadcasting enrichment-only update:`, enrichmentUpdate);
      wsManager.broadcastScanProgress(userId, enrichmentUpdate);
    } else {
      console.log(`🔍 [DEBUG] Not broadcasting enrichment - wsManager: ${!!wsManager}, stats.total: ${stats.total}`);
    }

    // Emit event for real-time updates
    this.emit('progress', userId, session);
  }
}

// Singleton instance
export const sessionManager = new PersistentSessionManager();