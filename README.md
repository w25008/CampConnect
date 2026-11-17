# CampConnect

CampConnect is a social app for OSFL students. It uses React and Vite for the screens and Supabase for the Postgres database and email sign-in.

Live site: [pulse-sns-nine.vercel.app](https://pulse-sns-nine.vercel.app/). Vercel builds it from the `main` branch on GitHub. The old GitHub Pages site is retired, so install the phone app only from the Vercel URL.

## Features

- Sign up with a confirmed `@osfl.ac.jp` email, sign in, and sign out.
- Reset a forgotten password by email ("Forgot your password?" on the sign-in screen), or change it from your profile after entering the current one. The reset link returns to the page it came from, so that URL must be in Supabase under Authentication > URL Configuration > Redirect URLs.
- Post to the whole school, to selected students, or to a group. Like and comment on posts you can see. Edit and delete your own comments, and add still photos or stickers to them.
- Create groups and manage members. New members can't see earlier posts, and removed members lose access. Group owners can rename the group and set its photo.
- Post on a group board that only members can see. Board posts are not encrypted.
- Find members, follow people, edit your profile (year of study is 1 to 3), and get notifications.
- Add images to school-wide posts, switch between English and Japanese, and pick light or dark mode.
- Send encrypted one-to-one messages after setting up a chat key and saving a recovery code.
- Block a student so they can't send you new messages.
- Report a post or comment as spam, harassment, inappropriate, or other.
- Install the app on a phone. Where supported, the icon shows an unread count.

Things to know:

- Audiences, groups, and encrypted chat need the latest migration and the latest frontend.
- Old plaintext chats are kept and labeled as legacy.
- Reports go to the `reports` table, and nobody is notified. Someone has to check it in Supabase (Table Editor). Sending reports to the school is waiting on a reviewer and an address.
- Student profiles can't be reported yet.
- Images only work on school-wide posts, because the image bucket is public.

## Privacy

- Private messages are end-to-end encrypted: your browser scrambles them before sending, and the server stores only the scrambled text. Staff can't read them. Save your recovery code. If you lose both the browser key and the code, your old messages are gone, and a reset only lets you send new ones.
- Posts and comments are not encrypted. Verified students can see them, and staff can review reported ones.
- Whoever runs the site controls its code, so the chat is a prototype and not as secure as Signal. See [Chat security limits](#chat-security-limits).

## Install on a phone

The app is a PWA, so you install it from the website instead of an app store. An install is tied to the URL it came from, so always use the same one.

- iPhone or iPad: open the site in Safari, tap Share, then Add to Home Screen.
- Android: open the site in Chrome, open the menu, then Install app or Add to Home screen.

The unread badge needs the Badging API. On iOS you must allow notifications for it, and Android support is partial. There are no push notifications. Offline, the service worker shows only the last page you loaded and never caches Supabase data. Icons are in `public/`.

## Database setup

A migration is a numbered SQL file in `supabase/migrations/`. Run them in order in the Supabase SQL editor. A file on your computer does nothing until you run it.

For a new project, run every file in order. For an existing project, run only the missing ones, in order. Don't rerun anything older than `0008`, because some old scripts put back earlier rules.

Notes on recent migrations (each one runs after the one before it):

- `0013_group_roster.sql`: current verified members can see their group's full member list. Outsiders and removed members can't. Run it with the project migration role, then deploy the frontend.
- `0014_edit_post_audience.sql`: lets you change a post's audience when editing. Post and recipients update in one transaction. Deploy the frontend after.
- `0015_image_cleanup.sql`: lets the app delete replaced or removed images. It adds SELECT access (Storage needs SELECT and DELETE to remove a file) only for verified students' own folders in `avatars` and `post-images`. It doesn't delete existing files or find older orphaned images. If cleanup fails, the app shows a warning and keeps the post or photo.
- `0016_saved_posts.sql`: save posts for later. Saved lists are private, and normal visibility rules still apply. Deploy the frontend after.
- `0017_saved_collections.sql`: private collections for saved posts, with a filter on the Saved page. Deploy the frontend after.
- `0019_comment_media_and_editing.sql` (after `0018_username_from_email.sql`): comment editing, photos, and stickers. Photos only work on school-wide posts. Stickers and text work everywhere. No GIFs.
- `0022_security_hardening.sql` (after `0021_leave_and_delete_groups.sql`): posts can only be edited through the app's edit function. Blocking also stops follows, likes, comments, selected-audience posts, and group invites between the two students. Adds chat size limits and rate limits: 20 posts or comments a minute, 40 messages a minute, 10 reports an hour.
- `0024_edit_post_requires_visibility.sql` (after `0023_message_actions.sql`): you can only edit a post you can still see. This stops someone who left a group from widening an old group post to read its comments. No frontend change.
- `0025_post_edit_efficiency_and_limits.sql`: saving without changes no longer marks a post as edited, recipients are only rewritten when they change, selected-audience posts allow up to 200 recipients, and each student can save up to 30 edits a minute. No frontend change.

After `0015`, test with two confirmed school accounts:

1. Upload and replace a profile or group photo.
2. Remove a profile photo.
3. Edit and delete an image post.
4. Check that old files leave Storage and current photos stay.
5. Check that the second account can't list or remove files in the first account's folder through the Storage API.

Remove files with the Storage API or the dashboard, never by deleting rows from `storage.objects`.

Supabase auth settings:

1. In Authentication > Sign In / Providers, keep Email and Confirm email on. The school check reads the confirmed address in `auth.users`, so turning confirmation off breaks school-only access. Custom SMTP is already set up. Test delivery to a school inbox before inviting more students.
2. In Authentication > URL Configuration, set the Site URL to the public app URL (currently `https://pulse-sns-nine.vercel.app/`) and add your production and local URLs to Redirect URLs.

Security headers (Content-Security-Policy, clickjacking protection, and others) are in `vercel.json`. Scripts can only load from the app, and the app can only connect to Supabase and the two translation services in `src/lib/translate.js` (Google Translate and MyMemory). If you add an outside script, image host, or API, add its address to `vercel.json` and test with `npm run preview`, which sends the same headers.

## Run locally

You need Node.js 22.12 or newer. In this folder, run:

```bash
npm install
Copy-Item .env.example .env.local
```

(`Copy-Item` is the PowerShell copy command.)

Fill in `.env.local` with the Project URL and publishable key from your Supabase project's Connect dialog:

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your-publishable-key
```

Start the app and open the URL Vite prints:

```bash
npm run dev
```

Run `npm run build` before deploying. Never put a Supabase secret or service-role key in a `VITE_` variable or browser code, because anyone can read it. The publishable key is safe in the browser.

## Deploy

1. Apply all migrations through `0025` before deploying the new frontend, since the code depends on them.
2. Push to `main`. Vercel builds and deploys automatically. Check that the deploy finished before inviting students.
3. Test with at least three confirmed school accounts:
   - An unconfirmed or outside email can't read community data.
   - People outside an audience or group can't fetch its posts, comments, likes, or counts, even with direct API calls.
   - New group members can't see old posts, and removed members lose access.
4. Set up chat keys on two accounts and check that:
   - New DMs are stored only as encrypted text.
   - Both people can read them.
   - A third account can't fetch them.
   - A fresh browser can restore chats with the recovery code.
   - A key reset works, and old plaintext chats show as legacy.
   - The app looks right on desktop and on a scrolled mobile screen.

Free plans have usage limits, and Vercel Hobby is for personal, non-commercial use.

## Chat security limits

New messages are encrypted in the browser with ECDH, HKDF, and AES-GCM. Supabase stores the encrypted text, sender and recipient IDs, and timestamps. Each private key has an encrypted backup locked by a random recovery code. The code stays in the browser and is never uploaded. Signing out clears the local key.

If a student loses both the key and the code, they can reset and send new messages but can't read their old ones. The other person can still read their copies, because old public keys are kept.

Known gaps:

- No ratchet or forward secrecy, so a leaked key exposes old messages.
- Students don't have to compare keys. The browser remembers the first key it sees for each contact and warns if it changes, but the server could swap in a different key for a first conversation without anyone noticing.
- Whoever controls the site can change its JavaScript, so don't promise that the operator can't read messages.
- Old version-0 messages are plaintext and labeled that way.

References: [Supabase React Auth](https://supabase.com/docs/guides/auth/quickstarts/react), [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [Vercel Vite](https://vercel.com/docs/frameworks/frontend/vite).
