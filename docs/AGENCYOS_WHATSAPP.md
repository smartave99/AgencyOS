# AgencyOS — WhatsApp workspace

A place inside AgencyOS where an agency prepares and tracks WhatsApp outreach to people **who agreed
to be contacted**, and where **a person sends every message by hand** in WhatsApp. It is free, runs
on your own computer and needs no WhatsApp account with the vendor beyond the one you already use.

Telegram stays AgencyOS's core channel and is untouched. WhatsApp is an extra in the sidebar under
**Grow**.

## What it does

| Part | What you can do |
| --- | --- |
| **Contacts** | Add a person with a name, a WhatsApp number, a language, tags, a company and notes, and the **consent record**: how they agreed (web form, in person, customer list with consent, ...), what shows it, and the day. Without a source and a day nobody is added. Numbers are checked and written in international form (`+4915112345678`); the same number cannot be added twice. |
| **Imports** | Paste or choose a CSV. AgencyOS checks every row first and shows what would happen: ready, duplicate, invalid, no consent, or withdrew before. Nothing is saved by checking. Only rows that carry their own consent source and date can be imported, and only after you confirm that the people agreed. The confirmation is stored with the import. |
| **Segments** | Saved filters (tags, language, how they agreed). Members are counted fresh each time. People who withdrew are never members. |
| **Templates** | The wording of a message, with `{{name}}`, `{{first_name}}`, `{{company}}` and `{{agency}}` filled in per person (no other placeholders exist). Every message ends with an opt-out line (default “Reply STOP to opt out.”) that you can change per template; leaving it out is allowed but warned about. A live preview shows the finished message for a sample person or a real contact. An optional **Suggest wording** button asks the AI chosen in Settings and puts the text in the editor for you to change. |
| **Outreach** | Choose a segment (or one contact) and a template; AgencyOS prepares **one task per person**. For each task there are exactly three things you do yourself: **Open in WhatsApp** (opens a `wa.me` chat with the message already typed in the box), **Copy message**, and **Mark as sent / skipped / replied**. A note and a reminder day can be added to any task. |
| **Today** | The reminders that have come due, and the messages waiting to be sent. Reminders live in the app only; nothing is sent to anyone. |
| **Unsubscribed** | Everyone who withdrew consent: when, how it reached you, who recorded it. It can be read and never edited or emptied, and it survives erasing the person (see below). |

## What it deliberately does not do, and why

* **It never sends a message.** There is no sender, no queue, no timer and no “send all” button.
  *Open in WhatsApp* opens one chat, because you clicked once for that one task. The unattended
  sending of promotional messages is what gets numbers banned and what the people on the list did
  not agree to.
* **It never says a message was delivered or read.** AgencyOS cannot see either. A task has four
  states only: *To send*, *Marked sent by you*, *Replied* and *Skipped*, all of them things a person
  said. There is no “delivered” state in the code or the database.
* **It does not scrape.** No WhatsApp groups, no reading of WhatsApp Web or Desktop, no driving of the
  WhatsApp apps, no collecting numbers from anywhere.
* **It does not message people who did not agree.** A contact cannot be created, and a row cannot be
  imported, without a consent source and date. Someone who withdrew is kept out of every segment and
  message list, is refused a chat link, and cannot be added again by form or by import, even after
  their details were erased.
* **It does not use the WhatsApp Business API yet.** See “Business API” below.

## Consent, privacy and erasing

* **Phone numbers are personal data.** Lists show `+49•••••5678`. The whole number appears only on
  the person's own screen (and only to staff who work contacts; analysts see it masked) and inside the
  chat link when you ask for it. It is never written to the audit trail, the logs or a list response.
  The search box does not search numbers, because search terms end up in server logs.
* **Withdrawing consent** marks the person *Opted out*, closes the messages still waiting for them,
  clears their reminders, and adds a row to the unsubscribe ledger. In this version a withdrawal
  cannot be undone: if someone later asks to hear from you again, that needs an explicit, audited
  step that has not been built.
* **The ledger keeps a keyed hash, not the number.** Each row holds the day, how the request arrived,
  who recorded it, and an HMAC-SHA256 of the number keyed with the install's secret and the agency.
  That is enough to recognise the same number when a list brings it back, and not enough to read the
  number. Rows are only ever added.
* **Erase contact** (Owner, Admin, Sales manager) deletes the person's name, number, notes and every
  message prepared for them. If they had withdrawn, the ledger row stays. If they had not and they
  asked not to be contacted, withdraw consent first so that is remembered.
* **Keep the secret stable.** The hash is keyed with `AGENCY_WHATSAPP_HASH_KEY` if set, otherwise with
  `JWT_SECRET`. If that value changes, old ledger rows stop matching and withdrawn people could be
  added again. Back it up with the database.
* **The audit trail** records consent recorded and withdrawn, imports committed (with counts and the
  attesting person), every task status change, contacts erased, and changes to segments, templates and
  settings. Entries carry ids and short summaries, never names or numbers.

## Who can do what

| Permission | Roles | Allows |
| --- | --- | --- |
| `whatsapp:read` | all staff (owner, admin, sales manager, sales executive, campaign manager, content editor, analyst) | See lists (numbers masked), templates, tasks, the ledger and imports |
| `whatsapp:write` | owner, admin, sales manager, sales executive, campaign manager, content editor | Add and edit contacts, withdraw consent, import, segments, templates, prepare messages, open chats, mark tasks, reminders, notes, wording suggestions; sees whole numbers |
| `whatsapp:delete` | owner, admin, sales manager | Erase a contact |
| `whatsapp:manage` | owner, admin | Change the default opt-out line |

Client users get nothing here. Contacts belong to the agency, not to the person who added them: a
sales executive sees every contact, because a withdrawal must be visible to everyone at once.

## CSV format

One header row, then one row per person. Column names are matched loosely (`Full Name`, `Mobile`,
`consent date` and similar work), and commas, semicolons (Excel in many countries) or tabs separate
the columns.

| Column | Needed | Notes |
| --- | --- | --- |
| `name` | yes | up to 120 characters |
| `phone` | yes | with the country code: `+4915112345678`, `0049 151 1234 5678`, `+49 (0) 151 ...`. A national number without a country code is refused, never guessed. |
| `consent_source` | yes | how the person agreed, e.g. `Web form` |
| `consent_date` | yes | `YYYY-MM-DD`, not in the future |
| `consent_evidence` | no | what shows it |
| `language` | no | `en`, `de`, `pt-br` |
| `tags` | no | separate with `\|` |
| `company`, `notes` | no | |

Limits: at most **2000 rows** per import, and the whole request must stay under the API's **100 KB**
JSON limit (the screen stops a bigger file before sending it; split it into parts). A task draft is
limited to **500 people**, because every message is sent by hand.

## Suggest wording (optional)

The button asks the AI chosen under Settings → AI (the same gateway the campaign composer uses; no
new AI client). Only the idea or draft wording you typed is sent, never a contact's details. The reply
is cleaned to plain text with only the allowed placeholders and put in the editor, with a way to put
your own wording back. If the AI is not set up or not running, the screen says so and everything else
works as before. Nothing is saved or sent by asking.

## Business API (not available in this version)

`WhatsappBusinessProvider` (`libraries/nestjs-libraries/src/integrations/whatsapp/`) describes what a
sender would look like (`sendTemplate`, `sendText`, `listApprovedTemplates`). The only
implementation, `DisabledWhatsappBusinessProvider`, refuses every call with “The WhatsApp Business API
is not enabled in this version of AgencyOS”. The settings flag `businessApiEnabled` is always `false`,
asking to turn it on is refused with the same message, and the screen shows “Not available in this
version”. There is no network code and there are no credential fields.

Switching it on would need, none of which exists:

1. a Meta business account with a verified WhatsApp Business number and a permanent access token,
   stored sealed like Telegram bot tokens and never returned by any API;
2. message templates approved by Meta (a business may only start a conversation with one) and the
   24-hour window for free-form replies;
3. a public HTTPS webhook with a verification token and signature check, to hear about replies and
   about delivery and read receipts. Only then could AgencyOS say a message was delivered;
4. the same consent rules as the manual workspace: only opted-in contacts, the ledger checked before
   every send, every send audited;
5. queueing with retries and backoff, a dead-letter state with an alert, and per-number rate limits,
   as for Telegram.

## API

All under `/agency/whatsapp`, authenticated like every agency route and checked per role.

`GET/PUT /settings` · `GET /facets` · `GET/POST /contacts` · `GET/PUT/DELETE /contacts/:id` ·
`POST /contacts/:id/withdraw` · `GET /imports` · `POST /imports/preview` · `POST /imports` ·
`GET /unsubscribes` (no way to change it) · `GET/POST /segments` · `POST /segments/preview` ·
`PUT/DELETE /segments/:id` · `GET/POST /templates` · `POST /templates/preview` ·
`POST /templates/suggest` · `PUT/DELETE /templates/:id` · `GET /tasks` · `GET /tasks/due` ·
`POST /tasks/draft` · `POST /tasks/:id/open` (returns the link for that one task) ·
`PUT /tasks/:id/status` · `PUT /tasks/:id`.

## What is tested, and what is not

Tested against PostgreSQL: consent required; number normalisation and duplicate refusal; opted-out
people excluded from segments, tasks and chat links; import check versus commit, attestation, limits,
a race with a second writer; the ledger refusing a withdrawn person after erasing; erase keeping only
the hash; the task state machine and the absence of any “delivered” state; link encoding; reminders;
cross-agency isolation (service and repository); the permission matrix; the AI answering and failing;
and an HTTP test on the compiled backend.

The screens were type-checked and driven in a real Chromium against the compiled backend and
PostgreSQL (44 scripted checks, run as the owner in the app's local mode on the development server):
all seven tabs; a contact's own screen; inline validation when adding a contact; the template editor
with its live preview, the warning when the opt-out line is removed, an unknown placeholder, and the AI
being unavailable; a segment's live count; an import check, the refusal without the confirmation, and
the commit; one chat link per click, prefilled, with nothing marked sent by opening it; mark as sent;
the withdraw dialog; and no sideways scroll at 390 px on all seven tabs and the two largest dialogs.
Light, dark and phone screenshots were looked at.

**Not verified:** that WhatsApp (phone, Desktop or Web) opens the `wa.me` link and fills the text as
described. That is WhatsApp's behaviour: nothing here talks to WhatsApp, and the build sandbox cannot
reach it, so the browser run only observed the request the click made. Also not covered: roles other
than the owner in the browser (the roles are covered by the integration and HTTP tests), browsers other
than Chromium, real touch devices, a production build of the frontend, and assistive technology.
