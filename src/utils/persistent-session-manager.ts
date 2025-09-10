/**
 * Persistent Session Manager
 * ==========================
 * 
 * Manages scanning sessions with full persistence across server restarts.
 * Provides dual-layer storage (memory + database) for optimal performance.
 */

import { prisma } from '../database/client';
import { EventEmitter } from 'events';

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
}

// Singleton instance
export const sessionManager = new PersistentSessionManager();