<p align="center"><img src="docs/logo.svg" width="64" alt=""></p>

<h1 align="center">ac·modern</h1>

<p align="center">Access requests, approvals and reviews for small teams.<br>Self-host it in one container, or run it as a hosted service.</p>

<p align="center">
  <a href="https://github.com/Armistice-Group/ac-modern/actions/workflows/ci.yml"><img src="https://github.com/Armistice-Group/ac-modern/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE.md"><img src="https://img.shields.io/badge/license-FSL--1.1--ALv2-7c3aed" alt="License: FSL-1.1-ALv2"></a>
  <a href="https://ac-modern.mintlify.app"><img src="https://img.shields.io/badge/docs-ac--modern.mintlify.app-7c3aed" alt="Docs"></a>
</p>

![Overview](docs/screenshots/overview.png)

Small teams usually handle access in Slack DMs and a spreadsheet, or pay for a helpdesk suite they don't need. ac·modern sits in between: people ask for the access they need, the right person approves it, someone (or a webhook) sets it up, and it expires on time. You always know who has what.

## What it does

- **Catalog.** Every app and system people can request, with access levels (e.g. GitHub *Member / Maintainer / Owner*).
- **Approvals.** Per resource: none, the requester's manager, resource approvers, or manager *then* approver. Nobody approves their own access, unless nobody else could (a one-person team); that case is logged as self-approved. **Auto-approval rules** approve standard requests by system, level, directory group and duration (privileged levels always go to a person), and each one records the rule that approved it.
- **Setup.** By hand (the fulfiller gets a task and marks it done), with the built-in **GitHub** (org and team membership), **Google Workspace** (groups, account suspension), **Okta** (groups or app assignments), **Authentik** (groups) and **Microsoft Entra ID** (security groups) integrations, or by **webhook**: a signed POST to your script, n8n, Zapier or Lambda. If anything automatic fails, the task falls back to a person with the error.
- **Time-boxed access.** Max and default durations per resource. Expired grants open a removal automatically, and people get a reminder before expiry with a one-click *Extend*.
- **Access reviews.** Review policies start them on schedule (monthly, quarterly, every six months, yearly; all access or privileged only; by system owners or managers). Reviewers get reminders, late reviews escalate to admins, and the evidence shows who decided, when, and that revoked access was actually removed.
- **Leavers.** Offboarding records the last day; removals past your target (24 hours by default) escalate daily, and a leavers report shows time-to-remove for everyone who left.
- **Reconciliation.** Compare a system's real user list (CSV, or pulled from the IdP) with recorded access, and resolve every unknown or stale account with a reason.
- **Security controls.** Two-step verification (TOTP) for password sign-in, session lifetime and idle timeout, and an optional second-admin approval for every change to the approval controls.
- **Offboarding.** One click deactivates the person, cancels their open requests, and opens a removal for everything they hold.
- **Record existing access.** Import what people already have, so reviews and offboarding cover it from day one.
- **Audit log** of every request, decision, grant and setting change, exportable as CSV, sealed daily with chained SHA-256 digests you can verify, and streamable to your log store.
- **Slack.** Approvers get a direct message with Approve and Deny buttons (Deny asks why), or reply **y** / **n** *reason* in its thread. Anyone can type `/access` to request from a form, and requesters hear back in Slack. Self-hosted orgs create the app from a manifest; the cloud uses "Add to Slack". Email (SMTP) and a channel webhook work too.
- **MCP server** at `/mcp` for Claude, Cursor and other AI assistants: request access, check on requests, and (if the personal token allows it) approve, all as yourself and recorded *via MCP*.
- **Directory sync** from your IdP: SCIM 2.0 push (Okta, Entra ID, JumpCloud, OneLogin, Rippling) or scheduled pulls from Google Workspace, the Okta API and Microsoft Graph. People are added with title and manager, and deactivation in the IdP offboards them (opening removals for all their access). IdP groups map to ac·modern admins, or to access levels, so access that already lives in the IdP is detected and tracked. Access granted there without a request is flagged in the audit evidence.
- **API for GRC tools.** Read-only, org-scoped tokens and a REST API (`/api/v1`, OpenAPI at `/api/v1/openapi.json`) for Vanta, Drata, Secureframe or your own scripts: users, resources, access, requests with approvals (the audit population), reviews and the audit log.
- **Single sign-on (OIDC)** per organisation: Okta, Entra ID, Google, JumpCloud, Authentik, Keycloak. Email domains are claimed per org (DNS-verified in the cloud), accounts are created on first sign-in, and SSO can be required, with owners keeping a password as a break-glass.

See the [screenshot tour](#screenshots) below.

## Audit evidence

Built for the control auditors test as *"a process to request and approve user accounts and permissions"*, where they sample new-hire access, transfers, new admins and extra permissions (databases, repositories) and ask for the approval ticket.

- **Every change is a request** with a business justification, including onboarding (one batch for a new hire's starting access) and transfers (new access requested and old access removed together, with a new manager and title).
- **Documented approval from the system owner or manager.** Each approval records who approved, in what capacity (manager, system owner, designated approver, admin fallback, admin override, self) and when. Privileged levels (admin, owner, read-write to production) always need the system owner or an approver, even on pre-approved or manager-only resources. Admin overrides are off unless you allow them.
- **Snapshots.** The person, their title and manager, the resource, its owner and the level are frozen when the request is made, so a ticket reads the same after renames and reorgs.
- **Audit evidence page:** the population for any period (CSV), filterable by type (new hire, transfer, permission change, additional access, extension, removal), privileged-only and exceptions-only. It prints tickets one per page (save as PDF) with the approval table, provisioning after approval, full history and a SHA-256 fingerprint of the record. It also lists access recorded outside requests, ac·modern admin changes and control changes, and gives a written control description generated from your settings.

## Screenshots

All from the fictional demo organisation (`pnpm seed`), regenerated with `pnpm screenshots`.

### Requesting access

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/catalog.png" alt="Request access catalog"><br><sub><b>Catalog.</b> Every tool people can ask for, its levels, who approves and for how long.</sub></td>
    <td width="50%"><img src="docs/screenshots/request-dialog.png" alt="Request dialog"><br><sub><b>Request.</b> Pick a level and duration, say why. Privileged levels are marked and always need the system owner.</sub></td>
  </tr>
</table>

### Approving and setting up

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/requests.png" alt="Requests to approve"><br><sub><b>Requests.</b> What's waiting for your approval or setup, yours, and everyone's.</sub></td>
    <td width="50%"><img src="docs/screenshots/request.png" alt="Request detail"><br><sub><b>A request.</b> Approve or deny, see each step and who approved it in what capacity, and the full history.</sub></td>
  </tr>
</table>

### Access, resources and people

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/access.png" alt="Access"><br><sub><b>Access.</b> Who has what right now, until when, and where it came from. Revoke, give up or extend.</sub></td>
    <td width="50%"><img src="docs/screenshots/resources.png" alt="Resources"><br><sub><b>Resources.</b> Every system, its levels, approval rule, setup method and owner.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/resource.png" alt="Resource holders"><br><sub><b>A resource.</b> Who holds each level, and its recent requests.</sub></td>
    <td width="50%"><img src="docs/screenshots/resource-editor.png" alt="Resource editor"><br><sub><b>Resource settings.</b> Levels (and which are privileged), approval, duration limits and how access is set up.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/people.png" alt="People"><br><sub><b>People.</b> Roles, managers and grant counts; invite, onboard, transfer and offboard.</sub></td>
    <td width="50%"><img src="docs/screenshots/person.png" alt="Person"><br><sub><b>A person.</b> Their access and requests, manager and GitHub username.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/transfer.png" alt="Transfer dialog"><br><sub><b>Transfer.</b> New access requested and old access removed together, with one reason. Copy a teammate's access in one click.</sub></td>
    <td width="50%"><img src="docs/screenshots/reviews.png" alt="Access reviews"><br><sub><b>Access reviews.</b> Campaigns with progress, due dates and what's waiting on you.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/review.png" alt="A review"><br><sub><b>A review.</b> Resource owners keep or revoke each grant; revoked ones become removals.</sub></td>
    <td width="50%"><img src="docs/screenshots/audit.png" alt="Audit log"><br><sub><b>Audit log.</b> Every request, decision, grant and setting change.</sub></td>
  </tr>
</table>

### Audit evidence

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/evidence.png" alt="Audit evidence"><br><sub><b>Audit evidence.</b> The population for any period by type, with approvals in capacity and exceptions flagged.</sub></td>
    <td width="50%"><img src="docs/screenshots/evidence-ticket.png" alt="Evidence ticket"><br><sub><b>Ticket.</b> One printable page per request: approval table, setup after approval, full history and a SHA-256 fingerprint.</sub></td>
  </tr>
</table>

### Identity and integrations

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/settings-sso.png" alt="Single sign-on settings"><br><sub><b>Single sign-on.</b> OIDC per organisation, claimed email domains, require SSO.</sub></td>
    <td width="50%"><img src="docs/screenshots/settings-directory.png" alt="Directory sync settings"><br><sub><b>Directory sync.</b> SCIM, Google Workspace, Okta or Entra ID; deactivation offboards; groups map to admins or access.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/settings-integrations.png" alt="Integrations"><br><sub><b>Integrations.</b> GitHub, Google Workspace, Okta, Authentik, Entra ID and the Slack app.</sub></td>
    <td width="50%"><img src="docs/screenshots/settings-api.png" alt="API tokens"><br><sub><b>API.</b> Read-only tokens for GRC tools, and the endpoints they can use.</sub></td>
  </tr>
</table>

### Light theme and sign-in

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/overview-light.png" alt="Overview, light theme"></td>
    <td width="50%"><img src="docs/screenshots/catalog-light.png" alt="Catalog, light theme"></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/request-light.png" alt="Request, light theme"></td>
    <td width="50%"><img src="docs/screenshots/evidence-light.png" alt="Audit evidence, light theme"></td>
  </tr>
  <tr>
    <td colspan="2" align="center"><img src="docs/screenshots/login.png" alt="Sign in" width="70%"></td>
  </tr>
</table>

## Self-hosting

```sh
curl -O https://raw.githubusercontent.com/Armistice-Group/ac-modern/main/compose.yaml
docker compose up -d
# open http://<host>:3040 and create your organisation
```

The image is `ghcr.io/armistice-group/ac-modern` (linux/amd64 and linux/arm64), built from `main` and from `v*` tags. One container, no other services needed. The first visit opens the setup wizard, which creates your organisation and its owner; set `ACM_ADMIN_EMAIL` and `ACM_ADMIN_PASSWORD` to create them on first start instead. Locked out? See [account recovery](https://ac-modern.mintlify.app/self-hosting/account-recovery): reset links, and `docker exec ac-modern ac-modern reset-password you@example.com`. Data lives in a SQLite file in the `/data` volume, with a generated `secret.key` that encrypts stored secrets (Slack URL, webhook signing keys). Back up both, or set `ACM_SECRET_KEY`. To use Postgres instead, set `ACM_DATABASE_URL=postgres://…` (there's a commented service in `compose.yaml`). All settings are in [`.env.example`](.env.example).

## Hosted (cloud) mode

`ACM_MODE=cloud` turns on `/signup`. Anyone (or only addresses matching `ACM_SIGNUP_ALLOW`) can create an organisation. One account can belong to several organisations and switch between them from the sidebar. Every table is scoped by `org_id`, and a test checks that one organisation can't read or act on another's data. Use Postgres in this mode.

## Provisioning through your IdP

Make the identity provider the place access is granted. A resource's levels map to an Okta group or app assignment, an Authentik group, an Entra ID security group, or a Google group. When a request is approved, ac·modern adds the person there; when it's removed or expires, ac·modern takes them out. The IdP then signs them in to the app, and provisions them in it if the app supports SCIM, so one connection covers every app behind it. People are matched by email. Connect each IdP under Settings → Integrations; it can reuse directory sync's credentials if they have write permission (Okta: Group Membership Admin / App Admin; Entra: `GroupMember.ReadWrite.All`; Authentik: a token that can edit groups).

## Billing (cloud)

With `ACM_MODE=cloud` and a Stripe key, organisations get a free tier (`ACM_FREE_SEATS`, default 5) and a per-seat plan (`ACM_STRIPE_PRICE_ID`) with a trial (`ACM_TRIAL_DAYS`). Upgrading goes through Stripe Checkout, and cards and invoices are handled in the Stripe Customer Portal. Seats follow active members automatically. Point a Stripe webhook at `/api/billing/webhook` (`checkout.session.completed`, `customer.subscription.*`) and set `ACM_STRIPE_WEBHOOK_SECRET`. Over the free limit, only *adding* people pauses. Approvals, removals and offboarding always work. Self-hosted installs have no billing.

## Webhook fulfillment

```
POST <your url>
content-type: application/json
x-acm-event: access.grant | access.revoke
x-acm-timestamp: <unix seconds>
x-acm-signature: sha256=<hex HMAC-SHA256(secret, timestamp + "." + body)>

{ "event": "access.grant",
  "request": { "id": "…", "number": 42, "reason": "request", "url": "https://…/requests/42" },
  "user": { "id": "…", "email": "dev@acme.com", "name": "Dev" },
  "resource": { "id": "…", "name": "GitHub" },
  "role": { "id": "…", "name": "Member" },
  "durationDays": 30, "grantId": null }
```

Answer 2xx once access is in place. Anything else (or a timeout after 15 s) leaves the request open for the fallback people, who can retry from the request page.

## Development

Node 24+ (26 recommended, see `.nvmrc`) and pnpm 12: `npm install -g pnpm@12` (Node 24's corepack can't run pnpm 12, and Node 26 no longer ships corepack).

```sh
pnpm install
pnpm dev                                   # setup wizard at http://localhost:5173
ACM_DATA_DIR=./demo-data pnpm seed         # demo org: avery@northwind.example / demo-password
pnpm test                                  # workflow tests on SQLite
TEST_DATABASE_URL=postgres://… pnpm test   # same tests on Postgres
pnpm check
pnpm screenshots                           # regenerates docs/screenshots from demo data
pnpm docs:dev                              # Mintlify docs at http://localhost:3000 (regenerates the API reference first)
```

Stack: SvelteKit (adapter-node), Svelte 5, Tailwind 4, TypeScript, Node 26 (built-in `node:sqlite`; 24+ works) or `pg`.

Code map: `src/lib/server/requests.ts` is the workflow (approval steps, fulfillment, revocation, webhooks), `grants.ts` covers grants, expiry and offboarding, `reviews.ts` the review campaigns, `db.ts` the SQLite/Postgres layer, and `schema.ts` the migrations.

## Documentation

Read the docs at **[ac-modern.mintlify.app](https://ac-modern.mintlify.app)**: setup, guides, audit and compliance, identity, integrations, self-hosting and the API reference. They're a [Mintlify](https://mintlify.com) site built from [`docs/`](docs/) on every push to `main`; preview locally with `pnpm docs:dev`.

## License

[Functional Source License 1.1, Apache 2.0 future license](LICENSE.md) (FSL-1.1-ALv2).

You can read, run, self-host and modify ac·modern for your own organisation, including commercially, and contribute changes back. You may not offer it, or something built from it, as a competing product or service, such as a hosted access-request platform. Each release becomes Apache-2.0 two years after it's published.
