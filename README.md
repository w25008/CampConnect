# CampConnect

Live sites: [GitHub Pages](https://w25008.github.io/CampConnect/) and [Vercel](https://pulse-sns-nine.vercel.app/).

A school-only social app for OSFL students. React/Vite provides the frontend; Supabase provides Postgres and email/password authentication.

## Features in the current source

- Sign up with a confirmed `@osfl.ac.jp` address, sign in, and sign out
- Publish school-wide, selected-student, or group posts; like and comment only when allowed to see the post
- Create groups and manage members; new members cannot see earlier posts, and removed members lose access in the app
- Find members, edit profiles, follow people, and receive notifications
- Share images on school-wide posts, switch between English and Japanese, and choose light or dark mode
- Set up a browser chat key, save a recovery code, and exchange encrypted one-to-one messages
- Block another student from sending new messages
- Report a post or comment (spam, harassment, inappropriate, other); reports are stored in the `reports` table, readable only from the Supabase dashboard
- Group owners can rename a group and set its photo; year of study is limited to 1 to 3

The audience, group, and encrypted-chat features require the latest migration and frontend deployment. Existing plaintext chats remain marked as legacy. There is no group chat yet. Reports are collected but nobody is notified: a designated reviewer must check the `reports` table (Supabase dashboard > Table Editor) regularly, and school report delivery awaits a reviewer and address. Student profiles cannot be reported yet. Images are limited to school-wide posts because the current image bucket is public.

## Set up the database

1. For a **new** Supabase project, run the numbered SQL files in [supabase/migrations/](./supabase/migrations/) in order. The existing CampConnect project is already at `0012`. For a project still at `0007`, run `0008` through `0012` in order, each once ([0008](./supabase/migrations/0008_school_audiences_and_encrypted_chat.sql) is the big one). Do not rerun older migrations after `0008`; some older scripts replace policies with earlier rules.
2. In **Authentication > Sign In / Providers**, keep Email and **Confirm email** enabled. The new school gate checks the confirmed address in `auth.users`. Custom SMTP is configured on the current project; test delivery to a school inbox before inviting more students.
3. In **Authentication > URL Configuration**, set the Site URL to the public app URL and include production and local URLs in Redirect URLs. The current project uses `https://pulse-sns-nine.vercel.app/` as its Site URL.

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

1. Apply all migrations through `0012` to the database before deploying the new frontend. New code calls its functions and columns.
2. Build with `npm run build`. GitHub Pages is published by the [workflow](./.github/workflows/deploy-pages.yml) when `main` is pushed; a separate Vercel project also hosts the app. Check both deploy paths before release.
3. Verify the live app with at least three confirmed school accounts. An unconfirmed or external address must not read community data; nonmembers must not fetch selected/group posts, comments, likes, or counts through direct API calls. New group members must not see old posts, and removed members must lose future database access.
4. Set up chat keys for two accounts. Confirm only ciphertext is stored for new DMs, both participants decrypt, a third account cannot fetch the row, and a fresh browser restores with the recovery code. Test a key reset and legacy plaintext labeling. Test desktop and scrolled mobile screens.

The publishable key is designed for client use; never place a secret key in browser code. Free plans have usage limits, and Vercel Hobby is for personal, non-commercial use.

## Private chat security boundary

New chat messages are encrypted in the browser with ECDH, HKDF, and AES-GCM. Supabase stores ciphertext, sender/recipient IDs, and timestamps. Each account's private key has an encrypted backup protected by a randomly generated recovery code. The code stays in the browser until the student acknowledges saving it and is never uploaded. Signing out clears the browser's local key. If a student loses both the browser key and recovery code, they can reset their key to send new messages, but cannot read their own old encrypted chats. Other participants can still read their copies using preserved historical public keys.

This is a prototype, **not Signal-level security**. It has no ratchet or forward secrecy, and the server could substitute a public key before students verify fingerprints through another channel. Whoever controls the website can change its JavaScript. Do not promise that the operator is technically unable to read messages under every circumstance. Existing version-0 messages remain plaintext and are labeled as such in the UI.

Official setup references: [Supabase React Auth](https://supabase.com/docs/guides/auth/quickstarts/react), [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [Vercel Vite](https://vercel.com/docs/frameworks/frontend/vite).

For school-only access, do not turn off email confirmation. Review mail delivery and authentication settings before inviting more students.

