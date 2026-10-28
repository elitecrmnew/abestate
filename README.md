# LeadExtract + Calling CRM

Live app: https://abestate.netlify.app
Supabase project: abestate (yosldtcsplksidtwfmty)
Netlify site: abestate (2af6c3d6-8a75-4cf4-afa8-d2fad928d168)

## Using the app

1. Sign in as `admin` or `admin@abestate.com`, using your existing Supabase Auth password.
2. Open Callers and create a caller with a username and password (minimum 8 characters).
3. Open Extract leads. Paste a header and rows, or upload a CSV / Excel file (first worksheet, up to 5 MB and 5,000 rows).
4. Review and edit extracted rows. Save them in a named group. Matching source IDs or primary phone numbers are skipped as duplicates.
5. Open All leads, select leads, choose a caller and apply assignment.
6. Callers log in using their username and password. They can view assigned leads and update status and remark only.

Statuses: Not Connected, Connected, Planning, Meeting.
Original lead date and assignment date are stored separately. Callers see assignment date as Lead Date. All displayed timestamps use India Standard Time.

Call and WhatsApp buttons open the device's calling app and WhatsApp. They do not place calls inside the CRM or send automated WhatsApp messages.

## Local development

Requires Node.js 22 or later.

```
npm ci
npm run dev
```

```
npm run build
```

The frontend contains only the public Supabase publishable key. It has no service-role key. Supabase's manage-caller function uses the service-role environment variable provided by Supabase on the server and verifies the authenticated admin against crm_profiles before performing account management.

## Database and authorization

The existing lead_groups and leads tables are retained. `supabase/crm-upgrade.sql` records the applied CRM additions. This file has already been applied; do not rerun it on the live database.

`supabase/functions/manage-caller/index.ts` is deployed as manage-caller with verify_jwt enabled. It creates, activates/deactivates and resets passwords for callers. Admin profile is provisioned for the pre-existing admin@abestate.com auth user. There is no public admin signup.

RLS restricts leads to active admins and the active assigned caller. A database trigger prevents callers from modifying any column except status, remark and server-generated updated_at. Caller profiles cannot be changed directly by browser clients.

A separate applied hardening migration revokes public execution of the existing public.rls_auto_enable event-trigger function.

## Validation

- TypeScript and production Vite build passed.
- Meta Markdown, long source IDs, Indian phone normalization, budget normalization, TSV and quoted CSV parser cases passed.
- Database transaction verified admin import and assignment, caller isolation, status/remark updates, blocked protected-column modifications, assignment timestamps and inactive caller denial. All synthetic test data was rolled back.
- Existing admin password was not changed. Signed-in browser workflows require the existing credentials; they have not been verified end-to-end in this session.

## Scope and limitations

This release supports manual paste/file import and manual assignment. It does not include Meta/99acres webhooks, automatic assignment, background WhatsApp API messaging or automatic browser push notifications.

The dashboard counts each lead's current status; it is not historical activity reporting. Remarks are the current editable note, not an append-only call log.

Supabase reported that leaked-password protection is disabled in the project. The app enforces a 8-character minimum for admin-created caller passwords. Review account-level password protection in Supabase when appropriate.

## Admin date editing
Open a lead from All leads, edit Lead date & time (IST), and Save changes. Assigned leads update the caller-visible assigned date; unassigned leads update the original date. Reassignment starts a new assigned date. Callers cannot edit either timestamp. Concurrent updates are detected before saving.

## Group reuse fix
Existing group selection is retained after import. Names entered with different capitalization or extra whitespace resolve to the same group. An owner-scoped unique database index prevents concurrent duplicate creation. crm_get_or_create_group is an admin-only SECURITY INVOKER RPC. The applied group-reuse.sql migration merged duplicate group references without deleting leads.

## Website forms and 99acres intake (1 October 2026)

Admin → Integrations creates website forms and server webhooks. Each connection selects an existing group and optionally an active caller. Website connections offer a public enquiry link and instructions for connecting an existing HTML form. Public intake validates consent, allowed origins, bounded payloads and per-minute limits. Origin checks are not bot authentication; rate limits and a honeypot provide basic spam controls.

99acres connections create a generic authenticated receiver, not an activated provider account. Confirm lead-push access, the actual payload and custom-header support with the 99acres account manager. POST one JSON object or URL-encoded lead, with `x-integration-key`. The UI supports top-level field mapping; XML, nested objects and batches require an adapter. Secrets are displayed once and only their SHA-256 hashes are stored. The receiver is not a Meta connector; the Meta Developer app and OAuth setup remain pending.

Backend: `supabase/integrations.sql`, `manage-integrations` (JWT plus active-admin check), and `lead-intake` (custom webhook authentication, public website forms). Only the service role can execute intake RPCs or write integration settings. New intake is serialized per owner; duplicate normalized phone numbers keep the existing record, caller and notes. Delivery events record created/duplicate outcomes without storing raw payloads. Connections support pause and webhook-key replacement. Do not embed a webhook key or Supabase service key in a website.

Verification: TypeScript/Vite production build; rolled-back database tests for creation, duplicate handling, assignment, preserving existing data, pause and rate limits. Live HTTP tests passed for public form metadata, consent validation, website-origin checks, webhook-key checks, cross-source duplicate handling, new enquiries and invalid phone rejection. Temporary test leads and connections were removed; the original 33 leads were preserved. The existing CRM import path retains its previous duplicate rules.


## Netlify account migration — 2 October 2026
New project: abestate-crm (e0ba310d-f6db-40ba-971d-eb386753f127). Intended production URL: https://abestate-crm.netlify.app. Supabase remains yosldtcsplksidtwfmty. Both integration functions accept the old and new production origins. Deployment status is tracked in the conversation.

## API gateway (October 2, 2026)

Admin > Integrations now includes API Gateway Configuration, a master service switch, and API / Automations connections. Each connection routes to a selected group and optional caller. The master switch pauses all website and webhook intake for that administrator. Existing leads remain available.

Apply `supabase/api-gateway.sql` after `integrations.sql` on a fresh installation, then deploy the updated `manage-integrations` and `lead-intake` functions. The live AB Estate project already has these changes. API keys are generated on creation/replacement, shown once, and only SHA-256 hashes are stored. Replacement invalidates the previous key.

In an automation tool, configure a custom HTTP POST to the connection URL with JSON and the `x-integration-key` header. Map `name`, `phone`, and optional fields shown in the setup panel. This is a generic webhook interface, not a preconfigured native Zapier/Make/Pabbly integration. Third-party account setup is still required.

Validation: TypeScript/production build passed; transaction tests confirmed creation, deduplication and master pause with rollback; live requests confirmed missing/wrong keys return 401 and valid keys reach lead validation. Production bundle verified. Authenticated admin UI was not exercised with an admin password.

## B2BBricks outbound export module — October 3, 2026

This extends the existing AB Estate CRM; it does not replace its data, roles or inbound integrations. All outbound configuration and actions are admin-only. Normal callers have no outbound permissions.

### Using the module

1. Open **Integrations → Open B2BBricks**, or **B2BBricks** in the sidebar.
2. Add a connection. Save an inactive draft until the exact Website Form request is available. Multiple connections are supported. URLs and authentication headers are saved server-side and are not returned to the browser.
3. Configure the documented HTTP method, JSON or URL-encoded body, exact destination field names, optional JSON wrapper, phone format, authentication headers, success HTTP codes and optional JSON response success field/value. Mark one field as Full name and one as Primary mobile. Mark the project/email fields accordingly for reports and validation. Map any extracted column, a canonical CRM field, connection defaults or a static value; each dynamic field also supports an optional fallback.
4. Confirm the contract and activate. No B2BBricks payload or credential has been preconfigured. The only supported outbound host is the exact `connector.b2bbricks.com` provider host, under `/api/Integration/`. Redirects are rejected. Other hosts/body structures need a reviewed adapter.
5. Upload/paste data as before. Extracted original columns are now preserved in `leads.imported_fields`. Choose **Send selected to B2BBricks** or **Send all to B2BBricks** from the preview, or select saved leads / choose a group from All leads. The module also allows selecting an entire group directly.
6. Select a connection, batch name and import group. Review mappings, normalized numbers and duplicate/invalid tabs. Only the final Send button queues delivery. Valid new draft records are saved in the current `leads` table; matching existing CRM records are reused. Invalid records are logged as skipped. No duplicate lead table is introduced.
7. Export history shows batch totals, per-record status, timestamps, project, response, retries and attempt history. Filters include status, date in IST, group, connection, project and batch; search accepts name, phone, email or batch name.

### Delivery and duplicate semantics

- A scheduled database job checks the durable queue every minute. A leased worker sends at most 10 records per invocation with a configurable 1–10 second delay. Browser polling only updates the report; it does not drive sending. Batches support up to 5,000 records.
- `Pending`, `Sending`, `Sent`, `Failed`, `Skipped` and `Duplicate` are persisted per record. Batch totals are updated transactionally.
- Duplicate checks are scoped to the connection and compare normalized Indian mobile or saved lead ID. Pending, in-flight and uncertain records are protected. Already successful records are skipped unless an administrator explicitly forces resend. Concurrent enqueues use a connection lock; the client batch UUID makes repeated enqueue requests idempotent.
- Retry Failed Leads never requeues successful records. Timeouts, interrupted workers, 5xx responses and ambiguous 2xx responses require an administrator to check B2BBricks and acknowledge the duplicate risk before retry. Exactly-once remote delivery cannot be guaranteed without provider idempotency support.
- A 429 response causes a provider cooldown; retries remain explicit. Pausing a connection stops future claims, but an in-flight request may complete. Cancel Pending leaves in-flight records untouched.
- Connection request settings cannot be changed while records are queued/sending. Finish or cancel pending work first. A retry against an older connection version requires a fresh batch. Deleting a connection archives it and retains export history.
- Test Connection requires an explicit action and sends a real external request. By default its delivery is marked as a test and excluded from real-lead duplicate tracking. The optional checkbox saves/tracks it as a real lead. Tests may still create a real lead in B2BBricks.
- Supported payloads are one flat object per request, optionally wrapped in one JSON object key. XML, multipart and arbitrary nested payloads are not implemented. Field values are strings. No final provider response contract has been verified yet.

### Backend and installation order

Existing database migrations remain prerequisites. Apply `supabase/b2bbricks.sql` once, deploy `b2bbricks` (JWT verification enabled) and `b2bbricks-worker` (custom worker-token authentication), including `_shared/outbound.ts`, then apply `supabase/b2bbricks-scheduler.sql`. The scheduler SQL contains the AB Estate project URL; adjust only for a separate installation. Worker credentials are generated inside Postgres, stored in Vault and checked as a SHA-256 hash. Connection secrets and all queue tables revoke client access and use RLS; the admin API scopes every operation to the authenticated owner. No service-role key is included in frontend code.

### Validation and current limits

- TypeScript and production build passed. Pure-function checks cover phone normalization, mappings, static/default values, destination restriction, success rules and secret redaction (`node --experimental-strip-types --test tests/outbound.test.mjs`).
- Rolled-back database checks cover queue creation, cross-batch/in-batch duplicates, idempotency, force resend, worker leases, reporting, failed-only retries, invalid phones, test isolation and client permissions (`tests/b2bbricks-queue.sql`). They send no external requests and leave no records.
- Live unauthenticated requests to both Edge Functions return 401. Scheduled job logs report successful ticks. After migration, the existing counts remained 33 leads, 9 profiles and 1 group; zero outbound connections/deliveries.
- The Playwright mock UI test is included (`tests/b2bbricks-ui.cjs`) but could not run in this environment because the browser download failed. It requires Playwright plus Chromium and the app at localhost:5173, and intercepts all remote requests.
- An authenticated manual worker invocation was blocked by automatic approval review because it could send queued records. No live B2BBricks send was performed. The exact provider URL/request, success/error samples and rate limit are still required for an end-to-end test.

### Group → B2BBricks automation
Administrators can open **Group automation · B2BBricks** below the group buttons on Dashboard or All leads, select a group and active configured connection, enable auto-send, and save. Rules default OFF; enabling never backfills existing leads. Project mapping uses the group's name and the connection's existing destination field marked Project. A private INSERT trigger captures new saved leads from any import/API, without calling the provider inside the import transaction. Edits and moving existing leads do not trigger sends. Group rules override intake-connection routing.

The existing one-minute B2B worker prepares up to 20 jobs per invocation, using a durable outbox ID as an atomic batch/enqueue key, then processes deliveries at the connection's configured pace. Duplicate protection, response rules, export history and failed-delivery retries are reused. Invalid lead mappings appear as Skipped in Export History; inactive connections or preparation errors appear in the group automation panel with Retry failed preparation. OFF cancels unprepared jobs; already-created delivery batches are cancelled from Export History. No Google Apps Script replacement is needed for this feature.

Validation: `node --test tests/group-automation.test.cjs tests/google-sheets.test.cjs tests/sheet-mapping-save.cjs` and `npm run build`. Database rollback tests cover capture, no backfill, updates ignored, atomic enqueue idempotency, disabled rules and restricted write grants. No real test lead was sent to B2BBricks during deployment.

### Manual lead creation and caller permissions
Dashboard and All leads include a compact **+ Add lead** form for administrators and permitted callers. Name and phone are required; group is optional. Indian mobile formats normalize to +91; invalid/duplicate numbers are rejected. With no group selected, a Manual leads bucket is created (per caller where applicable). Caller-created leads belong to the granting administrator and are assigned to their creator; administrators' manual leads start unassigned. These are real records and follow enabled group B2B automation.

Admin → Callers → Permissions has separate **Add lead** and **Create group** checkboxes and Save permissions. Both default OFF. The service-only SQL functions recheck active profiles and permissions on each request; caller identity is resolved from the authenticated session. Callers cannot choose arbitrary owners/assignees, self-grant permissions or add into another caller's private group. Callers see their created groups (including empty groups) plus groups of assigned leads. Group automation controls remain admin-only. Existing CSV import and admin caller management are preserved.

Tests: `node --test tests/manual-leads-api.cjs`; `tests/manual-leads.sql` is a rollback-only integration test covering permissions, self-assignment, ownership, duplicates, group isolation, phone validation and revocation. Frontend build and 24 existing group/import/automation tests passed. No test lead was retained or sent externally.

## Workspace UI refresh — 26 October 2026
Admin navigation is grouped into Workspace, Team and Connections. Dashboard shows four actionable summaries instead of every call status. Compact searchable group cards remain available on Dashboard and All leads. Export/send and budget tools are expandable; group B2B automation is under Integrations. Caller mobile tables emphasize contact, call status and follow-up, with Call/WhatsApp and a sticky save action in lead details. Existing backend, permissions and data are unchanged.

Validation: production build; 11 group, automation and manual-lead tests; mocked Chromium desktop/admin and mobile/caller checks including permission controls, lead form, navigation, overflow and call actions. Screenshots visually reviewed. No external leads sent during UI testing.

UI smoke test: after `npm run build`, run `node tests/workspace-ui.cjs` and `UI_ROLE=caller node tests/workspace-ui.cjs` with Playwright/Chromium installed. Optional environment variables: `CHROMIUM_PATH`, `CHROMIUM_PACKAGE` (a serverless Chromium package providing launch args), `UI_OUTPUT_DIR`. All backend calls are intercepted using synthetic fixtures.

Admin All leads now shows the saved lead remark below Budget, replacing the estimate label in this table. Click the preview to open full lead details. Empty remarks show No remark yet. Estimate provenance remains in admin lead details.

## Delete group, keep leads — 27 October 2026
Select a group in All leads, then use the admin-only “Delete group · keep leads” action. Confirmation removes the group and returns to All leads. Leads become ungrouped; assignments, remarks, follow-ups and delivery records remain. Group automation rules and unprepared jobs are removed; already queued B2BBricks batches continue. Groups referenced by incoming integrations are blocked with a message to change the integration destination first. External Sheet configurations using a deleted group name can recreate that group on their next import; update those mappings if retiring a group permanently.

Migrations: `20261027045150_delete_group_keep_leads.sql`, then `20261027045304_delete_group_admin_check.sql`. Group FK is SET NULL instead of CASCADE. The RPC is security invoker, verifies an active admin and locks the owned group. Group mutation policies require ownership. Tests: rollback-only `tests/delete-group.sql` verified removal, preserved lead details and caller denial; integration reference guard; mocked UI confirms cancel/confirm and retained lead; 11 regression tests and production build passed.
