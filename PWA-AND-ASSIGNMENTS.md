# AB Estate: scheduled assignment and caller app

Production: https://abestate.vercel.app

## Admin
All leads → select leads (or filter a group and Select all filtered).
Choose a caller and Assign now for immediate delivery, or Schedule selected.
Only unassigned, owned leads can be queued; the same lead cannot have two pending schedules.
Choose fixed interval (e.g. one lead every two hours), or spread across a duration (e.g. 24 hours).
Choose batch size, start time and optional daily working hours. All displayed scheduling times are IST.
Working hours, pauses and processing delays can extend the finish time of a spread schedule.
The backend checks due schedules once a minute and never sends catch-up bursts.
Assignment schedules provides pending/assigned/skipped/cancelled counts and pause/resume/cancel.
Cancel affects pending records only. Deleted/manually assigned leads are skipped.
Deactivated caller/admin accounts pause affected schedules.

## Caller
Open the website on the phone. Install through the Install app button when available, or browser menu.
On iPhone use Safari → Share → Add to Home Screen; open the installed app.
Sign in, then Enable notifications and accept the browser permission.
Assignment alerts are also available in the app; tap an alert to open its current lead.
App/phone push delivery depends on OS settings and connectivity; it is not an exact-time guarantee.
No lead data is cached offline. Assignment push content contains no name or phone number.
Signing out unsubscribes this device. Enable notifications again after signing in.

## Backend
Existing Supabase authentication, caller roles and lead records are reused.
assignment-scheduling.sql adds schedules/items, release worker, notification trigger and outbox.
caller-push-scheduler.sql adds the dispatch cron and server-side schedule summaries.
caller-push Edge Function verifies the user's token or the cron worker credential itself.
VAPID private key is stored in crm_private.push_settings, never returned to the browser.
Cron credential is held in Supabase Vault. Production keys are already configured and are not included here.
For a different backend, generate new P-256 VAPID keys server-side and provision private settings securely before enabling push.
Do not copy production subscriptions or keys to a separate environment.

## Verification
Transactional fixtures passed: batch timing, working-hour boundaries, duplicate reservations,
caller row permissions and assignment guard, pause/resume/cancel, spread interval, manual-assignment skip and notification creation.
Mocked push tests passed: authentication, endpoint restrictions, public-key isolation, dispatch,
stale assignment suppression, expired subscriptions and retry.
Frontend TypeScript and production build passed.
Physical phone notification delivery requires an installed/authorized device.
Browser UI automation was not run in this environment because Chromium could not be downloaded.

## Follow-up reminders and Google Sheets (24 October 2026)

Follow-up reminders are queued once per lead, recipient and scheduled time by
`abestate-followup-reminders` every minute. The current caller receives the alert;
for unassigned leads the owning admin receives it. Completed/rescheduled or
reassigned reminders are checked again before push delivery. Enable notifications
on each device. Enable chime & vibration each visit to unlock browser audio.
Custom chime plays while the page is visible; background sound/vibration is
controlled by the OS/browser and Do Not Disturb. Device delivery is best effort.

Admin Integrations > Google Sheets creates an incoming connection with one route:
Admin inbox (unassigned), active caller, or configured active B2BBricks connection.
Setup details supplies one central Apps Script with shared column mapping. Install
it in a control Google Sheet. Store the connection key in Script Properties as
ABESTATE_API_KEY; run startAbEstate once. It creates AB Sources. Add spreadsheet
URLs in column A and exact tab names in column B; blank/TRUE enables, FALSE pauses.
New files/tabs can be added without editing or reinstalling the script. All listed
sources use this CRM connection and destination. Source tabs must use the shared
column headers. The authorizing Google account needs edit access to each source.
Only trusted administrators should have edit access to that Apps Script.
The first run imports existing rows; the clock trigger checks every 5 minutes,
up to 50 requests total (25 per source visit) and 500 scanned rows per source.
A rotating source cursor prevents large sources starving other spreadsheets.
Each file/tab has its own row cursor. Errors appear in AB Sources and do not block
other sources. Stop older per-sheet triggers before switching to central sync. Google quotas apply.

AB Row ID, AB Sync Hash and AB Sync Status are added to the Sheet. Keep these with
their original row when sorting. Failed rows retry; API errors appear in that row.
Repeated/edited imported leads retain the existing CRM lead, caller and notes;
this is an inbound-new-leads sync, not a two-way contact update system.
A B2B route uses the saved B2B mapping. Map Project to Lead group name if desired.
CRM insert and B2B enqueue run in one transaction: an enqueue failure rolls back
that import so the Sheet can safely retry. Queued is not delivered: check
B2BBricks Export History for delivery results/retry failed leads.

Apply supabase/migrations/20261023194000_reminders_sheets.sql after the earlier
schema files. Deploy lead-intake (with _shared/outbound.ts), manage-integrations,
and caller-push. All are authenticated in their function bodies; retain existing
verify_jwt settings (lead-intake/caller-push false; manage-integrations true).

Verification: tests/caller-push.test.cjs, tests/google-sheets.test.cjs,
tests/follow-ups.test.mjs and rollback-only tests/reminders-sheets.sql.
