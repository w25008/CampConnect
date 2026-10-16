# Live Demo
https://w25008.github.io/CampConnect/

 # CampConnect

A school-only social app for OSFL students. React/Vite provides the frontend; Supabase provides Postgres and email/password authentication.

## Repository features

- Sign up with a confirmed `@osfl.ac.jp` address, sign in, and sign out
- Publish school-wide, selected-student, or group posts; like and comment only when allowed to see the post
- Create groups and manage members; new members cannot see earlier posts, and removed members lose access in the app
- Find members and follow or unfollow them
- Set up a browser chat key, save a recovery code, and exchange encrypted one-to-one messages
- Block another student from sending new messages

The new database migration must be applied before these features work. Existing plaintext chats remain marked as legacy. There are no image uploads, push notifications, group chat, or student report workflow yet. School report delivery awaits a designated reviewer and address.

## Set up the database

1. Create a Supabase project on the Free plan.
2. In Supabase **SQL Editor**, run [0001_initial.sql](./supabase/migrations/0001_initial.sql), then [0002_school_audiences_and_encrypted_chat.sql](./supabase/migrations/0002_school_audiences_and_encrypted_chat.sql). Apply `0002` once to an existing `0001` database; it preserves current rows.
3. In **Authentication → Providers**, keep Email and **Confirm Email** enabled. The school gate checks the confirmed address in `auth.users` on every protected database operation. Configure a sender that can deliver confirmation links to `@osfl.ac.jp`, then test delivery to school inboxes. The default sender may only reach project team members.
4. In **Authentication → URL Configuration**, set the Site URL to your deployed URL and add `http://localhost:5173/**` and the production URL to Redirect URLs.

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
5. Before inviting students, use at least three confirmed school test accounts. Verify that an unconfirmed or external address cannot read community data, a nonmember cannot fetch a group or selected post or its comments by direct API request, and a removed member loses group access. Set up chat keys for two accounts; confirm new rows contain ciphertext only, both participants can decrypt, and a third account cannot fetch the row. Restore one chat key in a fresh browser with its recovery code. Test on mobile after scrolling.

The publishable key is designed for client use; never place a secret key in browser code. Free plans have usage limits, and Vercel Hobby is for personal, non-commercial use. Apply `0002` before deploying the new frontend, since it calls new database functions and columns.

## Private chat security boundary

New chat messages are encrypted in the browser with ECDH, HKDF, and AES-GCM. Supabase stores ciphertext, sender/recipient IDs, and timestamps. Each account's private key has an encrypted backup protected by a randomly generated recovery code. The code stays in the browser until the student acknowledges saving it and is never uploaded. Signing out clears the browser's local key. If a student loses both the browser key and recovery code, they can reset their key to send new messages, but cannot read their own old encrypted chats. Other participants can still read their copies using preserved historical public keys.

This is a prototype, **not Signal-level security**. It has no ratchet or forward secrecy, and the server could substitute a public key before students verify fingerprints through another channel. Whoever controls the website can change its JavaScript. Do not promise that the operator is technically unable to read messages under every circumstance. Existing version-0 messages remain plaintext and are labeled as such in the UI.

Official setup references: [Supabase React Auth](https://supabase.com/docs/guides/auth/quickstarts/react), [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [Vercel Vite](https://vercel.com/docs/frameworks/frontend/vite).

For school-only access, do not turn off email confirmation. Review mail delivery and authentication settings before inviting more students.

