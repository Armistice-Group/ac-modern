/**
 * Schema migrations, applied in order. Each entry runs once, in a transaction. Keep to the
 * SQL that SQLite and Postgres share: TEXT and INTEGER columns, timestamps as ISO-8601 text
 * (they sort correctly as strings), booleans as 0/1, JSON as TEXT.
 * Every tenant-owned table carries org_id and every query filters on it.
 */
export const MIGRATIONS: string[] = [
	`
CREATE TABLE orgs (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	slug TEXT NOT NULL UNIQUE,
	settings TEXT NOT NULL DEFAULT '{}',
	request_seq INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL
);

CREATE TABLE users (
	id TEXT PRIMARY KEY,
	email TEXT NOT NULL UNIQUE,
	name TEXT NOT NULL DEFAULT '',
	password_hash TEXT,
	created_at TEXT NOT NULL,
	last_login_at TEXT
);

CREATE TABLE members (
	org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	role TEXT NOT NULL DEFAULT 'member',
	title TEXT NOT NULL DEFAULT '',
	manager_id TEXT REFERENCES users(id) ON DELETE SET NULL,
	status TEXT NOT NULL DEFAULT 'active',
	joined_at TEXT NOT NULL,
	PRIMARY KEY (org_id, user_id)
);
CREATE INDEX members_user ON members(user_id);

CREATE TABLE sessions (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	org_id TEXT REFERENCES orgs(id) ON DELETE SET NULL,
	created_at TEXT NOT NULL,
	expires_at TEXT NOT NULL
);

CREATE TABLE invites (
	id TEXT PRIMARY KEY,
	org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
	email TEXT NOT NULL,
	role TEXT NOT NULL DEFAULT 'member',
	token_hash TEXT NOT NULL UNIQUE,
	invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
	created_at TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	accepted_at TEXT
);
CREATE INDEX invites_org ON invites(org_id);

CREATE TABLE resources (
	id TEXT PRIMARY KEY,
	org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	description TEXT NOT NULL DEFAULT '',
	category TEXT NOT NULL DEFAULT 'app',
	url TEXT NOT NULL DEFAULT '',
	color TEXT NOT NULL DEFAULT 'violet',
	owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
	approval TEXT NOT NULL DEFAULT 'approvers',
	fulfillment TEXT NOT NULL DEFAULT 'manual',
	webhook_url TEXT NOT NULL DEFAULT '',
	webhook_secret TEXT NOT NULL DEFAULT '',
	max_days INTEGER,
	default_days INTEGER,
	requestable INTEGER NOT NULL DEFAULT 1,
	archived INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE INDEX resources_org ON resources(org_id);

CREATE TABLE resource_roles (
	id TEXT PRIMARY KEY,
	org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
	resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	description TEXT NOT NULL DEFAULT '',
	position INTEGER NOT NULL DEFAULT 0,
	archived INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX resource_roles_resource ON resource_roles(resource_id);

CREATE TABLE resource_people (
	org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
	resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	kind TEXT NOT NULL,
	PRIMARY KEY (resource_id, user_id, kind)
);

CREATE TABLE grants (
	id TEXT PRIMARY KEY,
	org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
	role_id TEXT NOT NULL REFERENCES resource_roles(id) ON DELETE CASCADE,
	status TEXT NOT NULL DEFAULT 'active',
	source TEXT NOT NULL DEFAULT 'request',
	request_id TEXT,
	note TEXT NOT NULL DEFAULT '',
	granted_at TEXT NOT NULL,
	expires_at TEXT,
	reminded_at TEXT,
	revoked_at TEXT
);
CREATE INDEX grants_org_status ON grants(org_id, status);
CREATE INDEX grants_user ON grants(user_id);

CREATE TABLE requests (
	id TEXT PRIMARY KEY,
	org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
	number INTEGER NOT NULL,
	kind TEXT NOT NULL DEFAULT 'grant',
	reason TEXT NOT NULL DEFAULT 'request',
	requester_id TEXT REFERENCES users(id) ON DELETE SET NULL,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
	role_id TEXT NOT NULL REFERENCES resource_roles(id) ON DELETE CASCADE,
	grant_id TEXT,
	justification TEXT NOT NULL DEFAULT '',
	duration_days INTEGER,
	status TEXT NOT NULL,
	step INTEGER NOT NULL DEFAULT 1,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	closed_at TEXT,
	fulfilled_by TEXT REFERENCES users(id) ON DELETE SET NULL,
	UNIQUE (org_id, number)
);
CREATE INDEX requests_org_status ON requests(org_id, status);
CREATE INDEX requests_user ON requests(user_id);

CREATE TABLE approvals (
	id TEXT PRIMARY KEY,
	org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
	request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
	step INTEGER NOT NULL,
	approver_id TEXT REFERENCES users(id) ON DELETE SET NULL,
	decision TEXT NOT NULL,
	comment TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL
);
CREATE INDEX approvals_request ON approvals(request_id);

CREATE TABLE reviews (
	id TEXT PRIMARY KEY,
	org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'open',
	due_at TEXT,
	created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
	created_at TEXT NOT NULL,
	closed_at TEXT
);

CREATE TABLE review_items (
	id TEXT PRIMARY KEY,
	org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
	review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
	grant_id TEXT NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
	reviewer_id TEXT REFERENCES users(id) ON DELETE SET NULL,
	decision TEXT,
	note TEXT NOT NULL DEFAULT '',
	decided_by TEXT REFERENCES users(id) ON DELETE SET NULL,
	decided_at TEXT
);
CREATE INDEX review_items_review ON review_items(review_id);

CREATE TABLE events (
	id TEXT PRIMARY KEY,
	org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
	at TEXT NOT NULL,
	actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
	action TEXT NOT NULL,
	request_id TEXT,
	subject TEXT NOT NULL DEFAULT '',
	summary TEXT NOT NULL,
	data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX events_org_at ON events(org_id, at);
CREATE INDEX events_request ON events(request_id)
`,
	// Audit evidence: classify requests, snapshot what was asked for and who approved in
	// which capacity, so a ticket reads the same years later even if names change.
	`
ALTER TABLE resource_roles ADD COLUMN privileged INTEGER NOT NULL DEFAULT 0;
ALTER TABLE requests ADD COLUMN category TEXT NOT NULL DEFAULT 'new_access';
ALTER TABLE requests ADD COLUMN privileged INTEGER NOT NULL DEFAULT 0;
ALTER TABLE requests ADD COLUMN policy TEXT NOT NULL DEFAULT 'approvers';
ALTER TABLE requests ADD COLUMN batch_id TEXT;
ALTER TABLE requests ADD COLUMN snapshot TEXT NOT NULL DEFAULT '{}';
ALTER TABLE approvals ADD COLUMN capacity TEXT NOT NULL DEFAULT '';
ALTER TABLE approvals ADD COLUMN approver_name TEXT NOT NULL DEFAULT '';
ALTER TABLE approvals ADD COLUMN approver_email TEXT NOT NULL DEFAULT '';

CREATE TABLE request_batches (
	id TEXT PRIMARY KEY,
	org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
	kind TEXT NOT NULL,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	reason TEXT NOT NULL DEFAULT '',
	created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
	created_at TEXT NOT NULL
);

CREATE INDEX requests_org_created ON requests(org_id, created_at);
CREATE INDEX requests_batch ON requests(batch_id)
`,
	// Single sign-on, per organisation.
	`
CREATE TABLE org_sso (
	org_id TEXT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
	issuer TEXT NOT NULL,
	client_id TEXT NOT NULL,
	client_secret TEXT NOT NULL DEFAULT '',
	name TEXT NOT NULL DEFAULT 'SSO',
	scopes TEXT NOT NULL DEFAULT 'openid email profile',
	auto_create INTEGER NOT NULL DEFAULT 1,
	required INTEGER NOT NULL DEFAULT 0,
	updated_at TEXT NOT NULL
);

CREATE TABLE org_domains (
	domain TEXT PRIMARY KEY,
	org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
	token TEXT NOT NULL,
	verified_at TEXT,
	created_at TEXT NOT NULL
);
CREATE INDEX org_domains_org ON org_domains(org_id);

CREATE TABLE user_identities (
	org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
	sub TEXT NOT NULL,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	created_at TEXT NOT NULL,
	PRIMARY KEY (org_id, sub)
);

ALTER TABLE sessions ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'password'
`,
	// Directory sync: users and groups from the identity provider (SCIM push or API pull).
	`
CREATE TABLE directory_sources (
	org_id TEXT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
	kind TEXT NOT NULL,
	config TEXT NOT NULL DEFAULT '',
	scim_token_hash TEXT,
	on_deactivate TEXT NOT NULL DEFAULT 'offboard',
	create_members INTEGER NOT NULL DEFAULT 1,
	last_sync_at TEXT,
	last_error TEXT NOT NULL DEFAULT '',
	stats TEXT NOT NULL DEFAULT '{}',
	created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX directory_sources_token ON directory_sources(scim_token_hash);

CREATE TABLE directory_users (
	org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
	id TEXT NOT NULL,
	external_id TEXT NOT NULL DEFAULT '',
	email TEXT NOT NULL,
	name TEXT NOT NULL DEFAULT '',
	title TEXT NOT NULL DEFAULT '',
	manager_ref TEXT NOT NULL DEFAULT '',
	active INTEGER NOT NULL DEFAULT 1,
	user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
	raw TEXT NOT NULL DEFAULT '{}',
	updated_at TEXT NOT NULL,
	PRIMARY KEY (org_id, id)
);
CREATE INDEX directory_users_email ON directory_users(org_id, email);

CREATE TABLE directory_groups (
	org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
	id TEXT NOT NULL,
	external_id TEXT NOT NULL DEFAULT '',
	name TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (org_id, id)
);

CREATE TABLE directory_memberships (
	org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
	group_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	PRIMARY KEY (org_id, group_id, user_id)
);

CREATE TABLE group_mappings (
	id TEXT PRIMARY KEY,
	org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
	group_id TEXT NOT NULL,
	target TEXT NOT NULL,
	resource_id TEXT REFERENCES resources(id) ON DELETE CASCADE,
	role_id TEXT REFERENCES resource_roles(id) ON DELETE CASCADE,
	created_at TEXT NOT NULL
);
CREATE INDEX group_mappings_org ON group_mappings(org_id);

ALTER TABLE members ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE members ADD COLUMN role_source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE members ADD COLUMN deactivated_by TEXT NOT NULL DEFAULT '';
ALTER TABLE grants ADD COLUMN idp_group TEXT
`,
	// Read-only API tokens for GRC tools and scripts.
	`
CREATE TABLE api_tokens (
	id TEXT PRIMARY KEY,
	org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	token_hash TEXT NOT NULL UNIQUE,
	prefix TEXT NOT NULL,
	created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
	created_at TEXT NOT NULL,
	expires_at TEXT,
	last_used_at TEXT,
	revoked_at TEXT
);
CREATE INDEX api_tokens_org ON api_tokens(org_id)
`
];
