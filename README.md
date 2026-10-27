# CampConnect

Live site: [pulse-sns-nine.vercel.app](https://pulse-sns-nine.vercel.app/). GitHub holds the code; Vercel builds and hosts the app from `main`. (The old GitHub Pages site is retired; install the phone app only from the Vercel URL.)

A school-only social app for OSFL students. React/Vite provides the frontend; Supabase provides Postgres and email/password authentication.

## Features in the current source

- Sign up with a confirmed `@osfl.ac.jp` address, sign in, and sign out
- Publish school-wide, selected-student, or group posts; like and comment only when allowed to see the post, edit/delete your comments, and attach photos, animated GIFs, or built-in stickers
- Create groups and manage members; new members cannot see earlier posts, and removed members lose access in the app
- Find members, edit profiles, follow people, and receive notifications
- Share images on school-wide posts, switch between English and Japanese, and choose light or dark mode
- Set up a browser chat key, save a recovery code, and exchange encrypted one-to-one messages
- Block another student from sending new messages
- Install on a phone (PWA) with an unread count on the app icon where supported
- Report a post or comment (spam, harassment, inappropriate, other); reports are stored in the `reports` table, readable only from the Supabase dashboard
- Each group page has a board to post to its members (posts are not encrypted)
- Group owners can rename a group and set its photo; year of study is limited to 1 to 3

The audience, group, and encrypted-chat features require the latest migration and frontend deployment. Existing plaintext chats remain marked as legacy. Reports are collected but nobody is notified: a designated reviewer must check the `reports` table (Supabase dashboard > Table Editor) regularly, and school report delivery awaits a reviewer and address. Student profiles cannot be reported yet. Images are limited to school-wide posts because the current image bucket is public.

## What is and is not private

- **Private messages are end-to-end encrypted.** The server and school staff cannot read them. Students must save their recovery code: if they lose both the browser key and the code, old messages are gone for good (a reset only restores sending new ones).
- **Posts and comments are not encrypted.** They are visible to verified school students and can be reviewed by staff if reported.
- The site's operator controls the website code, so this is a prototype, not Signal-level security (see the security boundary section below).

## Install on a phone

The app is a PWA, so there is nothing to download from an app store. Install it from the **one** public URL you choose (installs are tied to the URL):

- **iPhone/iPad:** open the site in **Safari**, tap Share, then **Add to Home Screen**.
- **Android:** open the site in **Chrome**, tap the menu, then **Install app** / **Add to Home screen**.

The home-screen icon shows an unread count where the browser supports the Badging API; iOS requires notification permission for badges, and Android support is partial. There are no push notifications: open the app to check. The service worker only shows the last loaded page when offline; it never caches Supabase data. Icons live in `public/`.

## Set up the database

For the group roster fix, apply `supabase/migrations/0013_group_roster.sql` once after `0012` in the Supabase SQL editor, using the project migration role. It lets current verified members see their group's full member list; outsiders and removed members remain excluded. Deploy the updated frontend after applying the migration. The SQL file being present locally does not apply it to the hosted database.

To change a post's audience while editing it, apply `supabase/migrations/0014_edit_post_audience.sql` once after `0013`, then deploy the updated frontend. The migration updates a post and its selected recipients in one transaction.

For image cleanup, apply `supabase/migrations/0015_image_cleanup.sql` once after `0014`. Supabase Storage removal needs both SELECT and DELETE access to object metadata; this adds SELECT only for verified students' own folders in `avatars` and `post-images`. It does not delete any existing files or find images orphaned by earlier operations. The frontend warns if cleanup fails, while keeping successfully saved posts and photos intact.

After applying it, test with two confirmed school accounts: upload and replace a profile/group photo, remove a profile photo, and edit/delete an image post. Check that obsolete objects disappear from Storage, current photos stay present, and the second account cannot list or remove objects in the first account's folder through the authenticated Storage API. Public image URLs remain public. Do not delete rows directly from `storage.objects`; use the Storage API or dashboard to remove files.

To save posts for later, apply `supabase/migrations/0016_saved_posts.sql` once after `0015_image_cleanup.sql`, then deploy the updated frontend. Saved post references are private to each student, and the existing post visibility rules still control which post content can be read.

Saved-post collections are added by `supabase/migrations/0017_saved_collections.sql`. Apply it once after `0016_saved_posts.sql` and deploy the updated frontend. Collections are private to the student who created them; saved posts can be assigned to a collection and filtered from the Saved page.

Comment editing, photo/GIF attachments, and stickers are added by `supabase/migrations/0019_comment_media_and_editing.sql`. Apply it after `0018_username_from_email.sql` and deploy the updated frontend. Comment media uses the existing public image bucket, so the database only permits attachments on school-wide posts; stickers and text comments continue to work on posts with restricted audiences.

1. For a **new** Supabase project, run the numbered SQL files in [supabase/migrations/](./supabase/migrations/) in order. For an existing project, apply any missing migrations after its current version in sequence. The comment-media feature specifically requires `0019_comment_media_and_editing.sql` after `0018_username_from_email.sql`. Do not rerun older migrations after `0008`; some older scripts replace policies with earlier rules.
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

1. Apply the required migrations through `0019` to the database before deploying the new frontend. New code depends on the image-storage, saved-post, collection, and comment-media policies.
2. Build with `npm run build`. Vercel deploys automatically when `main` is pushed; check the deployment finished before inviting students.
3. Verify the live app with at least three confirmed school accounts. An unconfirmed or external address must not read community data; nonmembers must not fetch selected/group posts, comments, likes, or counts through direct API calls. New group members must not see old posts, and removed members must lose future database access.
4. Set up chat keys for two accounts. Confirm only ciphertext is stored for new DMs, both participants decrypt, a third account cannot fetch the row, and a fresh browser restores with the recovery code. Test a key reset and legacy plaintext labeling. Test desktop and scrolled mobile screens.

The publishable key is designed for client use; never place a secret key in browser code. Free plans have usage limits, and Vercel Hobby is for personal, non-commercial use.

## Private chat security boundary

New chat messages are encrypted in the browser with ECDH, HKDF, and AES-GCM. Supabase stores ciphertext, sender/recipient IDs, and timestamps. Each account's private key has an encrypted backup protected by a randomly generated recovery code. The code stays in the browser until the student acknowledges saving it and is never uploaded. Signing out clears the browser's local key. If a student loses both the browser key and recovery code, they can reset their key to send new messages, but cannot read their own old encrypted chats. Other participants can still read their copies using preserved historical public keys.

This is a prototype, **not Signal-level security**. It has no ratchet or forward secrecy, and the server could substitute a public key before students verify fingerprints through another channel. Whoever controls the website can change its JavaScript. Do not promise that the operator is technically unable to read messages under every circumstance. Existing version-0 messages remain plaintext and are labeled as such in the UI.

Official setup references: [Supabase React Auth](https://supabase.com/docs/guides/auth/quickstarts/react), [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [Vercel Vite](https://vercel.com/docs/frameworks/frontend/vite).

For school-only access, do not turn off email confirmation. Review mail delivery and authentication settings before inviting more students.
