# Live Demo
https://w25008.github.io/CampConnect/

 # CampConnect

A small social network with real accounts, SQL-backed posts, follows, comments, and private one-to-one messages. The frontend is React/Vite. Supabase provides Postgres and email/password authentication.

## What works

- Create an account, sign in, and sign out
- Publish and delete text posts; like and comment
- Find members and follow or unfollow them
- Send and read private messages with another member

This is a lean starter for a small community. It has no image uploads, push notifications, moderation tools, or end-to-end encryption.

## Set up the database

1. Create a Supabase project on the Free plan.
2. In Supabase **SQL Editor**, run [0001_initial.sql](./supabase/migrations/0001_initial.sql). It creates tables, indexes, signup profile creation, grants, and row-level security policies.
3. In **Authentication → Providers**, keep Email enabled. For a free prototype open to users outside your Supabase project team, turn **Confirm Email** off. Supabase's default mail service only delivers to team addresses. For a public launch with verified email accounts and password recovery, configure your own SMTP provider and turn confirmation back on.
4. In **Authentication → URL Configuration**, set the Site URL to your deployed URL when you have one. If email confirmation is enabled, add `http://localhost:5173/**` and the production URL to Redirect URLs.

## Run locally

Use Node.js 22.12 or newer. In this folder:

```bash
npm install
Copy-Item .env.example .env.local
```

Edit `.env.local` with the **Project URL** and **publishable key** from your Supabase project's Connect dialog:

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your-publishable-key
```

Then run:

```bash
npm run dev
```

Open the URL Vite prints. Run `npm run build` before deployment. Never put a Supabase secret or service-role key in a `VITE_` variable or browser code.

## Deploy for free

1. Publish this folder in a Git repository, then import that repository into Vercel on its Hobby plan. If this folder is inside a larger repository, set the project root directory to `pulse-sns`.
2. Use the Vite defaults: build command `npm run build`, output directory `dist`.
3. Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` as project environment variables.
4. Deploy, then update Supabase Authentication URL Configuration with the production URL.
5. Create two accounts and verify that one can send a message to the other. Test after a fresh reload as well.

The publishable key is designed for client use; the SQL row-level security policies protect user data. Free plans have usage limits, and Vercel Hobby is for personal, non-commercial use. Private messages are stored in Postgres and are visible to their sender and recipient, not publicly.

Official setup references: [Supabase React Auth](https://supabase.com/docs/guides/auth/quickstarts/react), [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [Vercel Vite](https://vercel.com/docs/frameworks/frontend/vite).

Supabase's [default email service](https://supabase.com/docs/guides/auth/auth-smtp) is restricted to project-team recipients and is not intended for a public SNS. Turning off confirmation makes email ownership unverified; use verified email plus custom SMTP before inviting a wider audience.

