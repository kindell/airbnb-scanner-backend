import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../database/client';
import { User } from '../types';

export interface AuthenticatedRequest extends Request {
  user?: User;
}

/**
 * JWT authentication middleware for API routes
 */
export async function authenticateJWT(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const token = req.header('Authorization')?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
    
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId }
    });

    if (!user) {
      return res.status(401).json({ error: 'Invalid token. User not found.' });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('❌ JWT authentication error:', error);
    res.status(401).json({ error: 'Invalid token.' });
  }
}

/**
 * Optional authentication middleware - doesn't fail if no token
 */
export async function optionalAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const token = req.header('Authorization')?.replace('Bearer ', '');

  if (!token) {
    return next();
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
    
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId }
    });

    if (user) {
      req.user = user;
    }
  } catch (error: any) {
    // Silent fail for optional auth
    console.log('⚠️ Optional auth failed (continuing anyway):', error?.message || 'Unknown error');
  }

  next();
}

/**
 * Generate JWT token for user
 */
export function generateJWT(user: User): string {
  return jwt.sign(
    { 
      userId: user.id,
      email: user.email 
    },
    process.env.JWT_SECRET!,
    { 
      expiresIn: '7d' // Token expires in 7 days
    }
  );
}