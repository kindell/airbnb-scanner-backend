import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { Strategy as JwtStrategy, ExtractJwt } from 'passport-jwt';
import { prisma } from '../database/client';
import { User } from '../types';

export function configurePassport() {
  // Google OAuth Strategy
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID!,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    callbackURL: process.env.GOOGLE_CALLBACK_URL!
  },
  async (accessToken, refreshToken, profile, done) => {
    try {
      console.log(`🔑 OAuth tokens received for ${profile.emails?.[0]?.value}`);
      console.log(`📧 Access token: ${accessToken ? 'Present' : 'Missing'}`);
      console.log(`🔄 Refresh token: ${refreshToken ? 'Present' : 'Missing'}`);
      
      // Check if user exists (by googleId first, then by email)
      let user = await prisma.user.findUnique({
        where: { googleId: profile.id }
      });
      
      // If not found by googleId, check by email
      if (!user && profile.emails?.[0]?.value) {
        user = await prisma.user.findUnique({
          where: { email: profile.emails[0].value }
        });
      }

      const userData = {
        googleId: profile.id,
        email: profile.emails?.[0]?.value || '',
        displayName: profile.displayName,
        profilePicture: profile.photos?.[0]?.value,
        // Save Gmail tokens
        gmailAccessToken: accessToken,
        gmailRefreshToken: refreshToken,
        gmailTokenExpiry: null, // We'll set this when we know the expiry
        settings: JSON.stringify({
          scanYears: [new Date().getFullYear()],
          airbnbUrl: ''
        }),
        updatedAt: new Date()
      };

      if (!user) {
        // Create new user with Gmail tokens
        user = await prisma.user.create({
          data: userData
        });
        
        console.log(`🆕 Created new user with Gmail access: ${user.email}`);
      } else {
        // Update existing user info and Gmail tokens
        user = await prisma.user.update({
          where: { id: user.id },
          data: userData
        });
        
        console.log(`🔄 Updated user with Gmail access: ${user.email}`);
      }

      return done(null, user);
    } catch (error) {
      console.error('❌ Google OAuth error:', error);
      return done(error, false);
    }
  }));

  // JWT Strategy for API authentication
  passport.use(new JwtStrategy({
    jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
    secretOrKey: process.env.JWT_SECRET!
  },
  async (payload, done) => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: payload.userId }
      });

      if (user) {
        return done(null, user);
      } else {
        return done(null, false);
      }
    } catch (error) {
      console.error('❌ JWT validation error:', error);
      return done(error, false);
    }
  }));

  // Serialize/deserialize user for session management
  passport.serializeUser((user: any, done) => {
    done(null, user.id);
  });

  passport.deserializeUser(async (id: number, done) => {
    try {
      const user = await prisma.user.findUnique({
        where: { id }
      });
      done(null, user);
    } catch (error) {
      done(error, null);
    }
  });
}