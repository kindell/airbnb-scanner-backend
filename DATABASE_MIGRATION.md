# Database Migration: SQLite → PostgreSQL

## 📊 Setup Overview

**Development:** SQLite (lokalt, snabbt)
**Production:** PostgreSQL (Railway managed)

## 🚀 Development Setup

```bash
# Install dependencies
npm install

# Generate Prisma client for SQLite
npm run db:generate

# Push schema to SQLite database
npm run db:push

# Start development server
npm run dev
```

## 🐘 Production Setup (Railway)

### 1. Add PostgreSQL Service to Railway

```bash
# In Railway dashboard:
# 1. Go to your project
# 2. Add service -> Database -> PostgreSQL
# 3. Railway will automatically provide DATABASE_URL
```

### 2. Deploy with PostgreSQL

```bash
# Build for production with PostgreSQL
npm run build:postgresql

# Deploy to Railway (uses railway.toml)
railway up

# Or manual commands:
npm run db:generate:postgresql
npm run db:push:postgresql
```

## 🔧 Available Commands

### SQLite (Development)
- `npm run db:generate` - Generate Prisma client
- `npm run db:push` - Push schema to DB
- `npm run db:studio` - Open Prisma Studio
- `npm run dev` - Start dev server

### PostgreSQL (Production)
- `npm run db:generate:postgresql` - Generate client for PostgreSQL
- `npm run db:push:postgresql` - Push schema to PostgreSQL
- `npm run db:studio:postgresql` - Open Prisma Studio for PostgreSQL
- `npm run build:postgresql` - Build for production
- `npm run start:postgresql` - Start production server

## 📁 Schema Files

- `prisma/schema.prisma` - SQLite schema (development)
- `prisma/schema.postgresql.prisma` - PostgreSQL schema (production)

## 🌍 Environment Variables

### Development (.env)
```bash
DATABASE_PROVIDER="sqlite"
DATABASE_URL="file:./dev.db"
```

### Production (Railway)
```bash
DATABASE_PROVIDER="postgresql"
DATABASE_URL=$DATABASE_URL  # Auto-injected by Railway
```

## 🔄 Migration Process

1. **Schema changes**: Update both `schema.prisma` AND `schema.postgresql.prisma`
2. **Development**: `npm run db:push`
3. **Production**: Deploy to Railway (auto-migrates via railway.toml)

## ⚡ Benefits

- **🏃‍♂️ Fast Development**: No PostgreSQL setup lokalt
- **🔒 Robust Production**: PostgreSQL ACID compliance
- **📈 Scalable**: Railway managed database
- **🛠️ Same ORM**: Prisma fungerar seamless med båda