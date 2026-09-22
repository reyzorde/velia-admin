# Velia Admin

Platform admin panel for Velia ecosystem.

## Features
- Centers and plan change
- Subscriptions activate/deactivate
- Mock tests create/delete (admin unlimited)
- Announcements to centers (modal in Velia app)
- Promote users to platform admin

## Setup
```bash
npm install
cp .env.example .env
npm run dev
```

## First admin
1. Create user in Supabase Auth
2. `UPDATE profiles SET is_platform_admin = true WHERE email = 'your@email.com';`
3. Run FIX_ADMIN_ANNOUNCEMENTS.sql

## Env
```
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
```

## Logo
Place `velia-logo.png` and `velia-logo-night.png` in `public/assets/`.
