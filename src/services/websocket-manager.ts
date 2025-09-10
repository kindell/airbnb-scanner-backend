import { WebSocketServer, WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import { Server } from 'http';

interface AuthenticatedWebSocket extends WebSocket {
  userId: number;
  userEmail: string;
  isAlive: boolean;
  authTimeout?: NodeJS.Timeout;
}

interface WSMessage {
  type: 'auth' | 'subscribe' | 'unsubscribe' | 'ping' | 'pong';
  data?: any;
  token?: string;
  channel?: string;
}

interface WSResponse {
  type: 'auth_success' | 'auth_error' | 'progress' | 'scan_status' | 'booking_created' | 'booking_updated' | 'error' | 'pong';
  data?: any;
  channel?: string;
  message?: string;
}

export class WebSocketManager {
  private wss: WebSocketServer;
  private clients: Map<number, Set<AuthenticatedWebSocket>> = new Map();
  private heartbeatInterval: NodeJS.Timeout;

  constructor(server: Server) {
    this.wss = new WebSocketServer({ 
      server,
      path: '/ws',
      perMessageDeflate: false
    });

    this.wss.on('connection', this.handleConnection.bind(this));
    
    // Heartbeat to detect dead connections
    this.heartbeatInterval = setInterval(this.heartbeat.bind(this), 30000);
    
    console.log('🔌 WebSocket server initialized on /ws');
  }

  private handleConnection(ws: WebSocket) {
    const authWs = ws as AuthenticatedWebSocket;
    authWs.isAlive = true;

    console.log('🔌 New WebSocket connection');

    // Pong handler for heartbeat
    authWs.on('pong', () => {
      authWs.isAlive = true;
    });

    authWs.on('message', (message: Buffer) => {
      try {
        const parsed: WSMessage = JSON.parse(message.toString());
        this.handleMessage(authWs, parsed);
      } catch (error) {
        console.error('❌ WebSocket message parse error:', error);
        this.sendError(authWs, 'Invalid message format');
      }
    });

    authWs.on('close', () => {
      this.handleDisconnection(authWs);
    });

    authWs.on('error', (error) => {
      console.error('❌ WebSocket error:', error);
      this.handleDisconnection(authWs);
    });

    // Set authentication timeout
    const authTimeout = setTimeout(() => {
      if (!authWs.userId) {
        console.log('🔌 Unauthenticated WebSocket timeout');
        authWs.close(1008, 'Authentication timeout');
      }
    }, 30000); // 30 second timeout
    
    authWs.authTimeout = authTimeout;
  }

  private async handleMessage(ws: AuthenticatedWebSocket, message: WSMessage) {
    switch (message.type) {
      case 'auth':
        await this.handleAuth(ws, message.token);
        break;
      
      case 'subscribe':
        this.handleSubscribe(ws, message.channel);
        break;
      
      case 'unsubscribe':
        this.handleUnsubscribe(ws, message.channel);
        break;
      
      case 'ping':
        this.send(ws, { type: 'pong' });
        break;
      
      default:
        this.sendError(ws, 'Unknown message type');
    }
  }

  private async handleAuth(ws: AuthenticatedWebSocket, token?: string) {
    if (!token) {
      this.sendError(ws, 'No token provided');
      return;
    }

    try {
      if (!process.env.JWT_SECRET) {
        throw new Error('JWT_SECRET not configured');
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET) as any;
      if (!decoded.userId) {
        throw new Error('No user ID in token');
      }

      ws.userId = decoded.userId;
      ws.userEmail = decoded.email || 'Unknown';

      // Clear auth timeout since authentication succeeded
      if (ws.authTimeout) {
        clearTimeout(ws.authTimeout);
        ws.authTimeout = undefined;
      }

      // Add to clients map
      if (!this.clients.has(ws.userId)) {
        this.clients.set(ws.userId, new Set());
      }
      this.clients.get(ws.userId)!.add(ws);

      console.log(`✅ WebSocket authenticated: User ${ws.userId} (${ws.userEmail})`);

      this.send(ws, {
        type: 'auth_success',
        data: {
          userId: ws.userId,
          email: ws.userEmail
        }
      });

    } catch (error: any) {
      console.error('❌ WebSocket auth failed:', error.message);
      this.sendError(ws, 'Authentication failed: ' + error.message);
      ws.terminate();
    }
  }

  private handleSubscribe(ws: AuthenticatedWebSocket, channel?: string) {
    if (!ws.userId) {
      this.sendError(ws, 'Not authenticated');
      return;
    }

    // For now, we automatically subscribe authenticated users to their channels
    console.log(`📡 User ${ws.userId} subscribed to channel: ${channel || 'default'}`);
  }

  private handleUnsubscribe(ws: AuthenticatedWebSocket, channel?: string) {
    if (!ws.userId) {
      this.sendError(ws, 'Not authenticated');
      return;
    }

    console.log(`📡 User ${ws.userId} unsubscribed from channel: ${channel || 'default'}`);
  }

  private handleDisconnection(ws: AuthenticatedWebSocket) {
    // Clear auth timeout if it exists
    if (ws.authTimeout) {
      clearTimeout(ws.authTimeout);
      ws.authTimeout = undefined;
    }

    if (ws.userId) {
      const userClients = this.clients.get(ws.userId);
      if (userClients) {
        userClients.delete(ws);
        if (userClients.size === 0) {
          this.clients.delete(ws.userId);
        }
      }
      console.log(`🔌 WebSocket disconnected: User ${ws.userId} (${ws.userEmail})`);
    } else {
      console.log('🔌 Unauthenticated WebSocket disconnected');
    }
  }

  private heartbeat() {
    this.wss.clients.forEach((ws) => {
      const authWs = ws as AuthenticatedWebSocket;
      if (!authWs.isAlive) {
        console.log(`💔 Terminating dead WebSocket connection for user ${authWs.userId}`);
        return authWs.terminate();
      }

      authWs.isAlive = false;
      authWs.ping();
    });
  }

  private send(ws: AuthenticatedWebSocket, response: WSResponse) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(response));
    }
  }

  private sendError(ws: AuthenticatedWebSocket, message: string) {
    this.send(ws, {
      type: 'error',
      message
    });
  }

  // Public methods for broadcasting
  public broadcastToUser(userId: number, response: WSResponse) {
    const userClients = this.clients.get(userId);
    if (userClients) {
      userClients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
          this.send(ws, response);
        }
      });
      console.log(`📡 Broadcasted to ${userClients.size} client(s) for user ${userId}:`, response.type);
    }
  }

  public broadcastScanProgress(userId: number, progress: any) {
    this.broadcastToUser(userId, {
      type: 'progress',
      data: progress
    });
  }

  public broadcastScanStatus(userId: number, status: any) {
    this.broadcastToUser(userId, {
      type: 'scan_status',
      data: status
    });
  }

  public broadcastBookingCreated(userId: number, booking: any) {
    this.broadcastToUser(userId, {
      type: 'booking_created',
      data: booking
    });
  }

  public broadcastBookingUpdated(userId: number, booking: any) {
    this.broadcastToUser(userId, {
      type: 'booking_updated',
      data: booking
    });
  }

  public getConnectedUsers(): number[] {
    return Array.from(this.clients.keys());
  }

  public getUserConnectionCount(userId: number): number {
    return this.clients.get(userId)?.size || 0;
  }

  public close() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    this.wss.close();
  }
}

// Global instance
export let wsManager: WebSocketManager | null = null;

export function initializeWebSocket(server: Server): WebSocketManager {
  wsManager = new WebSocketManager(server);
  return wsManager;
}