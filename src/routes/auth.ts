import express from 'express';
import passport from 'passport';
import { generateJWT } from '../middleware/auth';
import { User } from '../types';

const router = express.Router();

/**
 * GET /auth/google
 * Initiate Google OAuth flow
 */
router.get('/google', (req, res, next) => {
  // Force consent and offline access for refresh tokens
  req.query.access_type = 'offline';
  req.query.prompt = 'consent';
  
  passport.authenticate('google', { 
    scope: [
      'profile', 
      'email',
      'https://www.googleapis.com/auth/gmail.readonly'
    ]
  })(req, res, next);
});

/**
 * GET /auth/google/callback
 * Handle Google OAuth callback
 */
router.get('/google/callback',
  passport.authenticate('google'),
  (req, res) => {
    const user = req.user as User;
    
    if (!user) {
      return res.redirect(`${process.env.FRONTEND_URL}/setup?error=auth_failed`);
    }

    console.log(`🔧 About to generate JWT for user:`, user.email);
    
    // Generate JWT token
    const token = generateJWT(user);
    console.log(`🔑 JWT token generated for ${user.email}:`, token ? 'Present' : 'Missing');
    console.log(`🔍 Token length:`, token ? token.length : 0);
    
    console.log(`✅ User authenticated: ${user.email}`);
    
    // Redirect directly to React app with JWT token as URL parameter
    const redirectUrl = `${process.env.FRONTEND_URL}/dashboard?token=${encodeURIComponent(token)}`;
    console.log(`🔄 Redirecting to:`, redirectUrl.substring(0, 100) + '...');
    res.redirect(redirectUrl);
    
    /* Old success page - keeping for reference
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
          <title>🎉 Authentication Success!</title>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
              body { 
                  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                  max-width: 600px; margin: 50px auto; padding: 20px; text-align: center;
                  background: #f8f9fa;
              }
              .container { 
                  background: white; padding: 40px; border-radius: 12px; 
                  box-shadow: 0 2px 20px rgba(0,0,0,0.1); 
              }
              .token { 
                  background: #f4f4f4; padding: 16px; border-radius: 8px; 
                  font-family: 'Monaco', 'Courier New', monospace; font-size: 12px;
                  word-break: break-all; margin: 20px 0;
                  border: 2px solid #28a745;
              }
              .btn { 
                  display: inline-block; padding: 12px 24px; background: #007bff; color: white; 
                  text-decoration: none; border-radius: 6px; font-weight: 500; margin: 8px;
              }
              .btn:hover { background: #0056b3; }
              .btn.success { background: #28a745; }
              .btn.success:hover { background: #1e7e34; }
              h1 { color: #28a745; margin-bottom: 8px; }
              .user-info { background: #e7f3ff; padding: 16px; border-radius: 8px; margin: 20px 0; }
          </style>
      </head>
      <body>
          <div class="container">
              <h1>🎉 Authentication Success!</h1>
              
              <div class="user-info">
                  <strong>Authenticated as:</strong> ${user.email}<br>
                  <strong>Display Name:</strong> ${user.displayName || 'Not provided'}<br>
                  <strong>User ID:</strong> ${user.id}
              </div>
              
              <p>Din JWT-token (spara denna för API-anrop):</p>
              <div class="token">${token}</div>
              
              <h3>🚀 Nästa steg:</h3>
              <p>Nu kan du testa API:erna med din token!</p>
              
              <a href="/api/stats" class="btn success">Visa Statistik</a>
              <a href="/api/user/settings" class="btn">Visa Inställningar</a>
              <a href="/setup/test-parser" class="btn">Testa AI Parser</a>
              
              <hr style="margin: 40px 0;">
              <p style="color: #666;">
                  <strong>API Exempel:</strong><br>
                  <code>curl -H "Authorization: Bearer ${token}" http://localhost:3000/api/stats</code>
              </p>
              
              <a href="/setup" class="btn">← Tillbaka till Setup</a>
          </div>
          
          <script>
              // Auto-copy token to clipboard
              navigator.clipboard.writeText('${token}').then(() => {
                  console.log('JWT token copied to clipboard!');
              });
          </script>
      </body>
      </html>
    `);
    */
  }
);

/**
 * POST /auth/logout
 * Logout user (client-side token removal)
 */
router.post('/logout', (req, res) => {
  res.json({ message: 'Logged out successfully' });
});

/**
 * GET /auth/me
 * Get current user info
 */
router.get('/me', 
  passport.authenticate('jwt', { session: false }),
  (req, res) => {
    const user = req.user as User;
    
    res.json({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      profilePicture: user.profilePicture,
      settings: user.settings,
      createdAt: user.createdAt
    });
  }
);

export default router;