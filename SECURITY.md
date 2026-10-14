# Security policy

ac·modern decides who gets access to what, so we treat security reports as our highest priority.

## Reporting a vulnerability

**Please don't open a public issue.** Report it privately through GitHub:

1. Go to the [Security tab](https://github.com/Armistice-Group/ac-modern/security) of this repository.
2. Choose **Report a vulnerability**.

Include what you found, the version or commit, how to reproduce it, and what an attacker could do with it. A proof of concept helps but isn't required.

We aim to:

- acknowledge your report within **3 business days**,
- confirm whether it's a vulnerability, and how severe, within **10 business days**,
- fix critical and high-severity issues as a priority, and keep you updated until they're released.

We'll credit you in the advisory unless you'd rather we didn't.

## Supported versions

| Version | Supported |
|---|---|
| The latest release and `main` | Yes |
| Older releases | Upgrade to the latest release |

Self-hosted installs should run the latest image (`ghcr.io/armistice-group/ac-modern`). Security fixes ship as new releases; there are no backports to old versions.

## In scope

Anything that breaks ac·modern's guarantees, for example:

- Getting, approving or keeping access you shouldn't: bypassing approval rules, approving your own requests, acting as another user, escalating to admin or owner.
- Seeing or changing another organisation's data (tenant isolation).
- Authentication: sessions, password resets, single sign-on, SCIM tokens, API tokens.
- Forging or replaying signed requests: Slack interactions, Stripe webhooks, outgoing webhook signatures.
- Tampering with the audit log or evidence without it showing (the record fingerprint).
- Reading stored secrets: integration credentials, webhook secrets, client secrets.
- Injection (SQL, XSS, SSRF), CSRF, or remote code execution.

## Out of scope

- Issues that need an already compromised host, container or database, or the server's secret key.
- Misconfiguration of your own deployment (for example, no TLS, or the setup wizard left open on the internet; see the docs).
- Volumetric denial of service, and rate limits that are merely generous.
- Missing security headers or cookie flags with no demonstrated impact.
- Vulnerabilities in third-party services we integrate with (report those to the vendor).
- Social engineering, physical attacks, and findings from automated scanners with no proof of impact.

## Testing guidelines

- Test against your own self-hosted instance, not someone else's, and never against other organisations on a hosted instance.
- Don't access, change or delete data that isn't yours. If you do reach real data by accident, stop and tell us.
- Give us reasonable time to fix the issue before disclosing it.

If you follow these guidelines, we won't take legal action against you for your research, and we'll work with you to understand and fix the issue.

## How ac·modern protects data

For context when assessing impact:

- Passwords are hashed with scrypt. Session, API, SCIM, invite and reset tokens are random and stored only as SHA-256 hashes.
- Integration credentials, webhook secrets and OIDC client secrets are encrypted at rest (AES-256-GCM) with a key that lives outside the database (`ACM_SECRET_KEY` or `secret.key`).
- Every tenant-owned row carries its organisation id, and every query filters on it.
- Browser writes are checked against the request's `Origin`. Slack and Stripe callbacks are verified by signature and timestamp. Outgoing webhooks are signed with HMAC-SHA256.
- Each request ticket carries a SHA-256 fingerprint of its stored record, approvals and history.
