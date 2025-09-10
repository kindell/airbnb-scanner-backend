# Development Setup Guide

## Project Structure
```
airbnb/
├── airbnb-scanner-frontend/    # React/Vite frontend
└── airbnb-scanner-backend/     # Node.js/Express backend
```

## Current Deployment Status
- **Backend**: Deployed on Railway.com at `https://airbnb-scanner-backend-production.up.railway.app`
- **Frontend**: Runs locally on `http://localhost:5173`

## Development Scenarios

### 1. Local Development (Both Frontend + Backend)

**Backend Setup:**
```bash
cd airbnb-scanner-backend
npm install
npm run dev  # Runs on http://localhost:3000
```

**Frontend Setup:**
```bash
cd airbnb-scanner-frontend
npm install

# Update .env.local for local backend:
VITE_API_URL=http://localhost:3000
VITE_WS_URL=ws://localhost:3000/ws

npm run dev  # Runs on http://localhost:5173
```

**Vite Config for Local Backend:**
Update `vite.config.ts`:
```typescript
server: {
  proxy: {
    '/api': 'http://localhost:3000',
    '/auth': 'http://localhost:3000',
    '/ws': {
      target: 'http://localhost:3000',
      ws: true
    }
  }
}
```

### 2. Frontend Development (Against Railway Backend)

**Current Setup - Frontend → Railway:**
```bash
cd airbnb-scanner-frontend

# .env.local is configured for Railway:
VITE_API_URL=https://airbnb-scanner-backend-production.up.railway.app
VITE_WS_URL=wss://airbnb-scanner-backend-production.up.railway.app/ws

npm run dev  # Runs on http://localhost:5173
```

**Vite Config for Railway:**
```typescript
server: {
  proxy: {
    '/api': {
      target: 'https://airbnb-scanner-backend-production.up.railway.app',
      changeOrigin: true,
      secure: true
    },
    '/auth': {
      target: 'https://airbnb-scanner-backend-production.up.railway.app',
      changeOrigin: true,
      secure: true
    }
  }
}
```

### 3. Backend Development & Deployment

**Local Testing:**
```bash
cd airbnb-scanner-backend
npm run dev
```

**Deploy to Railway:**
```bash
git add .
git commit -m "Your changes"
git push origin main  # Auto-deploys to Railway
```

**Environment Variables on Railway:**
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET` 
- `GOOGLE_CALLBACK_URL=https://airbnb-scanner-backend-production.up.railway.app/auth/google/callback`
- `JWT_SECRET`
- `DATABASE_URL` (Railway provides this)
- `FRONTEND_URL=http://localhost:5173`

## Key Files to Switch Between Setups

### Frontend Files:
1. **`.env.local`** - Switch API URLs
2. **`vite.config.ts`** - Switch proxy targets
3. **`src/components/Setup.tsx`** - OAuth login URL (if needed)
4. **`src/services/websocket.ts`** - WebSocket URL (uses env var)

### Backend Files:
1. **Environment variables** - Different for local vs Railway
2. **OAuth callback URLs** - Must match deployment

## Testing Checklist

### Local Development:
- [ ] Backend starts on :3000
- [ ] Frontend starts on :5173  
- [ ] OAuth login works
- [ ] WebSocket connection establishes
- [ ] Email classification works
- [ ] Database operations work

### Railway Development:
- [ ] Frontend connects to Railway API
- [ ] OAuth works with Railway callback
- [ ] WebSocket connects via WSS
- [ ] ML classifier processes emails
- [ ] Database persists on Railway

## ML Classifier Setup

**Dependencies:**
- Python 3 with numpy, scikit-learn
- Model files: `airbnb_email_classifier.pkl`, `ml_extractor_model.pkl`

**Railway Requirements:**
- `ml/requirements.txt` exists with Python dependencies
- Dockerfile installs Python packages with `--break-system-packages`

## Common Issues & Solutions

**WebSocket connection fails:**
- Check .env.local has correct WS_URL
- Ensure ws:// for local, wss:// for Railway

**OAuth missing refresh tokens:**
- Railway backend forces `prompt=consent` and `access_type=offline`

**Railway deployment fails:**
- Check Dockerfile has all dependencies
- Verify railway.toml uses Dockerfile builder
- Ensure Python dependencies in requirements.txt

**ML classifier errors:**
- Check Python dependencies installed
- Verify .pkl model files exist (not in git)

## Quick Switch Commands

**Switch to Local Backend:**
```bash
cd airbnb-scanner-frontend
echo "VITE_API_URL=http://localhost:3000
VITE_WS_URL=ws://localhost:3000/ws" > .env.local
# Update vite.config.ts proxy targets to localhost:3000
```

**Switch to Railway Backend:**
```bash
cd airbnb-scanner-frontend  
echo "VITE_API_URL=https://airbnb-scanner-backend-production.up.railway.app
VITE_WS_URL=wss://airbnb-scanner-backend-production.up.railway.app/ws" > .env.local
# Update vite.config.ts proxy targets to Railway URL
```