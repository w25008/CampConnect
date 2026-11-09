# CampConnect

Live site: [pulse-sns-nine.vercel.app](https://pulse-sns-nine.vercel.app/). The code is on GitHub, and Vercel builds and hosts the app from the `main` branch. The old GitHub Pages site is retired, so install the phone app only from the Vercel URL.

CampConnect is a social app just for OSFL students. The screens are built with React and Vite. Supabase stores the data in a Postgres database and handles email and password sign-in.

## What the app can do

- Sign up with a confirmed `@osfl.ac.jp` email address, sign in, and sign out.
- Reset a forgotten password by email (use "Forgot your password?" on the sign-in screen). You can also change your password from your profile page, and it asks for your current password first. The reset link returns to the page it was requested from, so that URL must be listed in Supabase under Authentication > URL Configuration > Redirect URLs.
- Write posts for the whole school, for selected students, or for a group. You can like and comment only on posts you are allowed to see. You can edit and delete your own comments, and attach still photos or built-in stickers.
- Create groups and manage their members. New members cannot see earlier posts, and removed members lose access in the app.
- Find other members, edit your profile, follow people, and get notifications.
- Share images on school-wide posts, switch between English and Japanese, and choose light or dark mode.
- Set up a chat key in your browser, save a recovery code, and send encrypted one-to-one messages.
- Block another student so they cannot send you new messages.
- Install the app on a phone (it is a PWA, explained below). Where the phone supports it, the app icon shows an unread count.
- Report a post or comment as spam, harassment, inappropriate, or other. Reports go into the `reports` table, which you can only read from the Supabase dashboard.
- Post to a group's board, which only that group's members can see. These posts are not encrypted.
- Let group owners rename a group and set its photo. Year of study is limited to 1 to 3.

A few things to know before you rely on these features:

- The audience, group, and encrypted-chat features need the latest database migration and the latest frontend deployment.
- Old plaintext chats stay in the app and are labeled as legacy.
- Nobody is notified when a report comes in. A designated reviewer has to check the `reports` table (Supabase dashboard > Table Editor) regularly. Sending reports to the school is waiting on a reviewer and an address.
- Student profiles cannot be reported yet.
- Images only work on school-wide posts, because the image bucket (the storage folder for pictures) is public.

## What is private and what is not

- Private messages are end-to-end encrypted, which means they are scrambled in your browser before they are sent. The server stores only the scrambled version, and school staff cannot read it. Students must save their recovery code. If they lose both the browser key and the code, their old messages are gone for good. A reset only lets them send new messages.
- Posts and comments are unencrypted. Verified school students can see them, and staff can review them if they are reported.
- Whoever runs the website controls its code, so this chat is a prototype and falls short of Signal-level security. The private chat security boundary section below explains why.

## Install on a phone

The app is a PWA (progressive web app). That means you install it straight from the website and do not need an app store. Pick one public URL and install from it, because an install is tied to the URL it came from.

- iPhone or iPad: open the site in Safari, tap Share, then tap Add to Home Screen.
- Android: open the site in Chrome, tap the menu, then tap Install app or Add to Home screen.

The home-screen icon shows an unread count if your browser supports the Badging API. On iOS you must allow notifications for badges to work, and Android support is partial. There are no push notifications, so open the app to check for new things. When you are offline, the service worker (a small helper script) only shows the last page you loaded, and it never saves Supabase data. The icons live in `public/`.

## Set up the database

A migration is a SQL file that changes your database, such as adding a table or a rule. Each file in `supabase/migrations/` is numbered, and you run them in order in the Supabase SQL editor. Having a file on your computer does not change the hosted database. You have to run it.

- `0013_group_roster.sql` fixes the group roster. Apply it once after `0012`, using the project migration role. It lets current verified members see their group's full member list, while outsiders and removed members stay excluded. Deploy the updated frontend after you apply it.
- `0014_edit_post_audience.sql` lets you change a post's audience while editing it. Apply it once after `0013`, then deploy the updated frontend. It updates a post and its selected recipients in one transaction.
- `0015_image_cleanup.sql` cleans up images. Apply it once after `0014`. Supabase Storage needs both SELECT and DELETE access to an object's metadata before it can remove a file. This migration adds SELECT only, and only for verified students' own folders in `avatars` and `post-images`. It does not delete any existing files, and it does not find images orphaned by earlier operations. If cleanup fails, the frontend shows a warning and keeps the saved posts and photos.
- `0016_saved_posts.sql` lets students save posts for later. Apply it once after `0015_image_cleanup.sql`, then deploy the updated frontend. Saved post references are private to each student, and the existing post visibility rules still control which post content can be read.
- `0017_saved_collections.sql` adds saved-post collections. Apply it once after `0016_saved_posts.sql` and deploy the updated frontend. Collections are private to the student who created them. You can put saved posts into a collection and filter by it on the Saved page.
- `0019_comment_media_and_editing.sql` adds comment editing, still-photo attachments, and stickers. Apply it after `0018_username_from_email.sql`. Comment photos work only on school-wide posts, because the image bucket has public URLs. Stickers and text comments also work on posts with restricted audiences. GIFs are not available in comments.

After you apply `0015`, test it with two confirmed school accounts:

1. Upload and replace a profile or group photo.
2. Remove a profile photo.
3. Edit and delete an image post.
4. Check that old objects disappear from Storage and current photos stay.
5. Check that the second account cannot list or remove objects in the first account's folder through the authenticated Storage API.

Do not delete rows directly from `storage.objects`. Use the Storage API or the dashboard to remove files.

To set up a project:

1. For a new Supabase project, run the numbered SQL files in [supabase/migrations/](./supabase/migrations/) in order. For an existing project, apply any missing migrations after its current version, in sequence. Comment media requires `0019_comment_media_and_editing.sql` after `0018_username_from_email.sql`. Do not rerun older migrations after `0008`, because some older scripts replace policies with earlier rules.
2. In Authentication > Sign In / Providers, keep Email and Confirm email turned on. The school gate checks the confirmed address in `auth.users`, so turning confirmation off would break school-only access. Custom SMTP (your own email sender) is set up on the current project. Test delivery to a school inbox before you invite more students.
3. In Authentication > URL Configuration, set the Site URL to the public app URL, and include your production and local URLs in Redirect URLs. The current project uses `https://pulse-sns-nine.vercel.app/` as its Site URL.

## Run it on your own computer

You need Node.js 22.12 or newer. Open a terminal in this folder and run:

```bash
npm install
Copy-Item .env.example .env.local
```

`Copy-Item` is a Windows PowerShell command. It makes a copy of the example settings file.

Then edit `.env.local` and fill in the Project URL and the publishable key. You can find both in your Supabase project's Connect dialog:

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your-publishable-key
```

Then start the app:

```bash
npm run dev
```

Open the URL that Vite prints in the terminal. Run `npm run build` before you deploy. Never put a Supabase secret key or service-role key in a `VITE_` variable or in browser code, because anyone can read those.

## Deploy for free

1. Apply the required migrations through `0019` to the database before you deploy the new frontend. The new code depends on the image-storage, saved-post, collection, and comment-media rules.
2. Build with `npm run build`. Vercel deploys automatically when you push to `main`. Check that the deployment finished before you invite students.
3. Test the live app with at least three confirmed school accounts. An unconfirmed or outside email address must not be able to read community data. People outside an audience or group must not be able to fetch its posts, comments, likes, or counts through direct API calls. New group members must not see old posts, and removed members must lose database access going forward.
4. Set up chat keys for two accounts and check the following:
   - Only scrambled (encrypted) text is stored for new DMs.
   - Both people can read the messages.
   - A third account cannot fetch the row.
   - A fresh browser can restore the chat with the recovery code.
   - A key reset works, and old plaintext chats are labeled as legacy.
   - The app looks right on desktop and on a scrolled mobile screen.

The publishable key is meant to be used in the browser. Free plans have usage limits, and Vercel Hobby is for personal, non-commercial use.

## Private chat security boundary

New chat messages are encrypted in the browser with ECDH, HKDF, and AES-GCM. Supabase stores the scrambled messages, the sender and recipient IDs, and the timestamps. Each account's private key has an encrypted backup, protected by a randomly generated recovery code. The code stays in the browser until the student confirms they saved it, and it is never uploaded. Signing out clears the browser's local key.

If a student loses both the browser key and the recovery code, they can reset their key and send new messages, but they cannot read their own old encrypted chats. The other person can still read their copies, because the old public keys are kept.

This is a prototype and falls short of Signal-level security. It has no ratchet or forward secrecy (the extra steps that protect old messages if a key leaks later). The server could also swap in a different public key unless students compare fingerprints through another channel. Whoever controls the website can change its JavaScript, so do not promise that the operator is technically unable to read messages. Existing version-0 messages are plaintext and are labeled that way in the app.

Official setup references: [Supabase React Auth](https://supabase.com/docs/guides/auth/quickstarts/react), [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [Vercel Vite](https://vercel.com/docs/frameworks/frontend/vite).
