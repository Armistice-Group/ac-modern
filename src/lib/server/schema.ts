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
`
];
