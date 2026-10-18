# AgencyOS — Agent integrations

Lets an AI agent that speaks the [Model Context Protocol](https://modelcontextprotocol.io) (MCP), for
example the Antigravity CLI, work with an AgencyOS workspace. The agent can **look** and can **prepare
drafts**. It can never do anything that reaches the outside world, and it can never change who may do what.

AgencyOS works exactly the same when no agent is connected. The agent is never a scheduler: it acts only
while a program the person started is talking to it, and nothing in AgencyOS depends on it.

Page: **Agent integrations** (`/agency/agent-integrations`), for owners and admins (`ai:configure`).

## What was and was not verified

| Verified | How |
| --- | --- |
| Tokens, scopes, tool catalogue, proposals and approval, secrets, role checks, tenant isolation, rate limit, audit | 41 integration tests against PostgreSQL (`agency.agent.gateway.int.spec.ts`) |
| The same over HTTP on the compiled backend: missing, wrong, revoked, expired and cookie-authenticated callers refused; a token refused on every non-gateway route; tools listed per scope; a reading tool run; a drafting call turned into a proposal and approved by a signed-in owner; 429 | 11 tests in `apps/backend/e2e/agency.http.e2e.test.mjs` |
| The MCP server: handshake, tool listing, calls, error mapping, a refused token, no token in any output, loopback-only, malformed JSON-RPC | 23 `node --test` tests that run the real server as a child process against a fake gateway |
| The page, in a real Chromium against the compiled backend and PostgreSQL (Next.js development server): empty state, inline validation, the once-only token dialog (cannot be dismissed with Escape, Done disabled until confirmed, the copied configuration contains the token), proposals created by a token approved after a confirmation, declined with a reason, a failing change reported, revoke with confirmation (the token is refused at once), no horizontal scroll at 1280 and 390 px in light and dark, dialogs fit at 390 px | A one-off scripted run, 27 checks passed. A 28th (no console errors) failed only on the app shell's own errors (the Copilot runtime and an external connection that the sandbox blocks), none from this page. The script is not part of the repository. |

| **Not** verified | Why |
| --- | --- |
| **Antigravity.** The file name `.agents/mcp_config.json`, its layout (`mcpServers` → name → `command`, `args`, `env`) and that Antigravity reads it were **not** checked against Antigravity's documentation or against an installed Antigravity. They follow the common MCP-client convention. Vendor documentation could not be reached from the build environment. | The page and this document say so; the generic command below lets you adapt the settings to what your program expects. Do not read this document as a claim that Antigravity is supported. |
| Any real MCP client. The server was exercised only by tests that speak JSON-RPC to it. | A real client may require things the tests do not (for example a protocol revision other than the three the server answers as). |
| The protocol revisions the server answers as (`2025-06-18`, `2025-03-26`, `2024-11-05`) | Taken from the author's knowledge of the specification, not checked against a client. A client that asks for another revision is told `2025-06-18`. |
| Windows. The tests ran on Linux. Paths with spaces and a `node` that is not on the `PATH` were not tried. | |
| The installed app. The installer build copies `apps/agent-mcp/server.mjs` to `app/agent-mcp/server.mjs` and the app tells the server where its own Node.js is (`AGENCYOS_NODE_PATH`), so the settings the page shows use the installed Node.js. That is written and unit-tested; no Windows run has opened the page yet. | |
| Browsers other than Chromium, touch devices, and assistive technology on the page | |

## Scopes

| Scope | What the agent can do |
| --- | --- |
| **READ** | Use the reading tools. |
| **DRAFT** | Use the reading tools and propose changes. A proposal changes nothing until a person approves it. |

**There is no WRITE scope in this version, on purpose.** A scope that let a model send, schedule, approve,
join, authorize or delete would put a model one step from the outside world, and an "approval" flow in
front of such a tool would still be the model's request that a tired person clicks through. Everything a
DRAFT token can propose ends at a draft or at the approval inbox, where a person still has to approve the
campaign through the normal review before anything is scheduled or sent.

## Tools

The names are the contract; a test pins the exact list.

### Reading tools (READ and DRAFT tokens)

| Tool | Returns | Needs (of the token's person) |
| --- | --- | --- |
| `dashboard` | Counts of clients, campaigns, approvals and deliveries; whether Telegram and the dispatcher are set up | `dashboard:read` |
| `list_clients` | Up to 25 clients: id, name, company, industry. **No e-mail address.** | `client:read` |
| `list_campaigns` | Up to 25 campaigns with status and client | `campaign:read` |
| `get_campaign` | One campaign: text, link, status, destinations, delivery counts | `campaign:read` |
| `list_destinations` | The Telegram chats and their authorization status (title, type, status, whether the bot can post, the last error Telegram reported) | `destination:read` |
| `list_approvals` | Campaigns waiting for review | `campaign:read` |
| `get_report` | Delivery totals for a period | `analytics:read` |
| `list_deals` | Up to 25 deals: company, stage, value. **No contact name.** | `crm:read` |
| `suggest_copy` | Three headlines, bodies and calls to action for a brief. It only writes text. It uses the AI provider the owners chose in Settings (a model on this computer unless they chose a service), and counts against the rate limit. | `ai:use` |
| `list_communities` | The community directory: title, @username, member count, labels, stage, advertising-review state | `research:read` |
| `get_community` | One directory entry (the same fields) | `research:read` |
| `list_telegram_accounts` | Each connected Telegram account's label, status, what it may do, **masked** phone number, last check. No ids, no credentials. | `userAccount:read` |
| `get_proposal` | Where a proposal this token made stands, with its outcome | `ai:configure` |

### Drafting tools (DRAFT tokens only)

Each creates a proposal and answers
`{"status": "pending_approval", "proposalId": "…", "message": "…"}`. The change is **not** made.

| Tool | If a person approves it |
| --- | --- |
| `create_client` | A client is added |
| `create_campaign_draft` | A campaign is created in the DRAFT state for a client (not submitted, not scheduled) |
| `update_campaign_draft` | The text of a campaign that is still a draft is changed |
| `set_campaign_destinations` | A draft's Telegram destinations are replaced |
| `submit_campaign_for_review` | A draft is sent to the approval inbox. A person must still approve it there. |

The reading tools and the drafting tools reuse the in-app Copilot agent's own tools (through
`AgencyAiAgentService.describeTool`, `runRead` and `prepareChange`), so the same checks apply: the same
permission, the same argument rules and limits, and the same one-sentence summary. Arguments the tool does
not declare are dropped; they are not stored and not forwarded.

### What is deliberately absent

No tool exists to, and no setting enables an agent to:

* send, publish, schedule, pause, cancel or approve a campaign;
* join or leave a community, create one, or authorize a chat or a destination;
* create, change, check or sign out a Telegram account or bot, or read its credentials;
* delete anything;
* change roles, permissions, settings or AI keys, or make another agent token;
* read a password, token, session, API hash, or a full phone number;
* read Telegram messages, members, or WhatsApp contacts or messages;
* run a shell command, read or write a file, or make an HTTP request.

The MCP server itself has no tools; it only relays what the gateway offers a token.

## How a proposal is approved

1. A DRAFT token calls a drafting tool. AgencyOS cleans and checks the arguments with the in-app agent's
   rules, writes the one-sentence summary and stores an **AgentProposal** (tool, arguments, summary, status
   `PENDING`, the token, created time, expiry after **24 hours**). The same request made twice returns the
   same waiting proposal. One token can have 20 waiting proposals and one agency 50.
2. A person on **Agent integrations → Proposals** reads the summary and the exact arguments, and chooses
   Approve or Decline (each asks first; Decline takes an optional reason the agent can read).
3. **Approve** checks the approver's role again at that moment (owner or admin, and the permission the change
   itself needs), moves the proposal from `PENDING` to `APPROVED` in one guarded update, and only the call
   that made that move runs the change. It runs with the **approver's** identity and permissions, through the
   same code as the in-app agent's approve button, and is audited. Two people pressing Approve together run it
   once. An expired, declined or already-approved proposal never runs.
4. If the change fails when it runs (for example an invalid e-mail address), the proposal stays `APPROVED`
   with the reason and does not run again; the agent can propose it again, corrected.
5. Nothing expires in the background. An old `PENDING` proposal is marked `EXPIRED` the next time anyone looks.
   Revoking a token withdraws its waiting proposals.
6. The agent sees the result with `get_proposal`. It can only see proposals its own token made.

## Tokens

* Format `agt_` followed by 32 random bytes in base64url. **Only the SHA-256 is stored.** The token is in the
  answer that creates it and nowhere else; the page makes the person confirm they copied it.
* Scope READ or DRAFT, a name, an optional expiry (default **90 days**; "never" is possible and discouraged),
  last-used time, revocable at once. At most **10** work at a time per agency.
* Only owners and admins (`ai:configure`) make or revoke tokens and decide proposals.
* A token opens **only** the gateway: `GET /agent-gateway/health`, `GET /agent-gateway/tools` and
  `POST /agent-gateway/call`. It is not accepted by any other route (the app's sign-in, the public API and the
  rest refuse it), and a signed-in person's cookie is not accepted by the gateway.
* A token never outranks the person who made it: at every call the person is looked up again. If they are
  no longer an owner or admin, or have left the workspace, the token stops working.
* At most **60 calls a minute per token** (answer `429` with the seconds to wait). The count is kept in the
  memory of the AgencyOS process, which is enough for one computer.
* Events written to the audit trail: token created and revoked, proposal created (by the role `AGENT`, naming
  the token), approved, declined. A token is never written to the audit trail, a log or an error.

## Connecting an agent

The MCP server is `apps/agent-mcp/server.mjs`: Node.js, no dependencies, JSON-RPC 2.0 over standard
input/output, one message per line. It needs two settings:

| Setting | Meaning |
| --- | --- |
| `AGENCYOS_MCP_URL` | Where AgencyOS listens, for example `http://127.0.0.1:3000` |
| `AGENCYOS_MCP_TOKEN` | The token shown once on the page (`agt_…`) |

It refuses to start without both (exit code 2 and a line on standard error; standard output only ever carries
protocol messages), refuses a token that does not look like one, never logs the token, never follows a
redirect, and **talks only to this computer** (`localhost`, `127.x.x.x`, `::1`) unless
`AGENCYOS_MCP_ALLOW_REMOTE=1` is set, in which case the token travels the network.

The page shows this block, with a placeholder in place of the token (the dialog that shows the token once can
copy the block with the token already in it):

```json
{
  "mcpServers": {
    "agencyos": {
      "command": "node",
      "args": ["<path to apps/agent-mcp/server.mjs in the install>"],
      "env": {
        "AGENCYOS_MCP_URL": "http://127.0.0.1:<backend port>",
        "AGENCYOS_MCP_TOKEN": "<paste the token shown once>"
      }
    }
  }
}
```

It is written to **`.agents/mcp_config.json`** by convention. That file name and layout are **not verified
against Antigravity** (see above). For any other program, start the server with the same two settings in its
environment:

```text
node /path/to/server.mjs
AGENCYOS_MCP_URL=http://127.0.0.1:3000
AGENCYOS_MCP_TOKEN=agt_…
```

If `node` is not on the `PATH`, put the full path of a Node.js 22 program as the `command`. The path of the
server file is found next to the installed app (`app/agent-mcp/server.mjs`), in the source tree
(`apps/agent-mcp/server.mjs`), or at `AGENCYOS_MCP_SERVER` if that is set; if none exists the page says the
path is a guess.

## What an agent can learn, and what it cannot

* It sees the agency's own work: client names, campaign text and links, destinations, approvals, report
  totals, deal companies and values. It is **not** given client e-mail addresses or the contact names of
  deals, even though the person's own screens show them. That is a decision about exposing stored fields to a
  new surface; it can be changed in `OMITTED_FIELDS` in `agency.agent.gateway.service.ts`.
* **Telegram.** `list_communities` and `get_community` return only what the community directory holds: title,
  @username, the counts Telegram returned, the agency's labels and stage. Not the description Telegram
  publishes, not the team's notes, not members, not people, not Telegram's own numeric ids. No Telegram message
  text is stored in the directory or exposed through any of these tools.
  `list_telegram_accounts` returns label, status, permission flags and a masked phone number only.
  Telegram-derived content must not be used to train models. AgencyOS limits what it gives an agent to the
  directory metadata above, but it cannot control what the agent's own provider does with what the agent
  reads: choose a provider and plan that does not train on your inputs.
* **WhatsApp.** No tool reads WhatsApp contacts, messages or segments.
* A safety net under the per-tool field lists removes any key named like a secret (`sealed`, `session`,
  `apiHash`, `password`, `token`, `phone`, …) from every answer. A test runs every tool against data seeded with
  bot tokens, sealed sessions, an API hash, an AI key, full phone numbers and a token, and asserts none of it
  appears in any answer.

## Threat notes

* **Prompt injection.** Anything an agent reads can contain instructions written by someone else: a campaign
  text, a client's name, a community title, a reason a person typed when declining. The gateway returns it as
  data and the server tells the agent so, but a model can be fooled. The design assumes it will be: even a fully
  tricked agent still cannot send, schedule, approve, delete or authorize anything, and every change it asks
  for waits for a person who sees the exact details. **Read what you approve.** The one-sentence summary is built
  by AgencyOS from the agent's arguments and can repeat the agent's own words; the arguments are listed in full
  below it.
* **A stolen token** lets its holder read what the token's person can read and queue proposals, for up to the
  token's lifetime, until revoked. The configuration file holds the token in plain text on the computer, like
  any MCP client's settings: keep that file private.
* **Flooding.** An agent can create proposals, up to the caps above, and can read as fast as 60 calls a minute.
* **`suggest_copy`** sends the agent's brief to whatever AI provider the owners chose in Settings. On a
  server that needs the operator's `AGENCY_ALLOW_EXTERNAL_AI`; on the desktop app the owner's choice stands.
* **Other computers.** The gateway is part of the AgencyOS backend; on the desktop app that is bound to
  `127.0.0.1`. On a server install the gateway is reachable wherever the backend is, protected by the token.

## Gateway reference

```text
GET  /agent-gateway/health   → {"ok": true, "label": "…", "scope": "DRAFT", "tools": 18}
GET  /agent-gateway/tools    → {"scope": "DRAFT", "tools": [{"name", "scope", "description", "inputSchema", "annotations"}]}
POST /agent-gateway/call     {"tool": "list_clients", "args": {"search": "acme"}}
                             → {"tool": "list_clients", "result": …}
```

Every request carries `Authorization: Bearer agt_…`. Answers: `401` (missing, wrong, revoked, expired token),
`403` (`scope_denied`, or the token's person lost the role), `404` (`unknown_tool`, or the thing asked for is
not in this agency), `400` (arguments), `429` (rate limit, or too many waiting proposals).

Management routes for the signed-in person: `GET/POST /agency/agent-integrations/tokens`,
`POST …/tokens/:id/revoke`, `GET …/proposals`, `POST …/proposals/:id/approve`, `POST …/proposals/:id/decline`,
`GET …/config`.
