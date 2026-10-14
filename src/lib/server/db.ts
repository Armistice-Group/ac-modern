import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';
import { MIGRATIONS } from './schema.ts';

export type Param = string | number | boolean | null | undefined;

/**
 * The one database interface the app uses. SQL is written once with `?` placeholders in the
 * subset SQLite and Postgres share (TEXT/INTEGER columns, ISO timestamps as text,
 * ON CONFLICT, RETURNING), so self-hosted installs run on a single SQLite file and the
 * cloud runs on Postgres without a second set of queries.
 */
export interface Db {
	readonly kind: 'sqlite' | 'postgres';
	all<T>(sql: string, params?: Param[]): Promise<T[]>;
	get<T>(sql: string, params?: Param[]): Promise<T | undefined>;
	run(sql: string, params?: Param[]): Promise<{ changes: number }>;
	/** Runs `fn` in a transaction; queries inside must use the `tx` it is given. */
	tx<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
	close(): Promise<void>;
}

const norm = (params: Param[] = []) => params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));

/** A tiny FIFO lock: SQLite has one connection, so a transaction must not interleave with other requests' queries. */
class Lock {
	private tail: Promise<void> = Promise.resolve();
	async run<T>(fn: () => Promise<T>): Promise<T> {
		let release!: () => void;
		const prev = this.tail;
		this.tail = new Promise((r) => (release = r));
		await prev;
		try {
			return await fn();
		} finally {
			release();
		}
	}
}

async function openSqlite(file: string): Promise<Db> {
	const { DatabaseSync } = await import('node:sqlite');
	const raw = new DatabaseSync(file);
	raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
	const lock = new Lock();
	let inTx = false;

	const exec = {
		all: <T>(sql: string, params?: Param[]) => raw.prepare(sql).all(...(norm(params) as never[])) as T[],
		get: <T>(sql: string, params?: Param[]) => raw.prepare(sql).get(...(norm(params) as never[])) as T | undefined,
		run: (sql: string, params?: Param[]) => ({ changes: Number(raw.prepare(sql).run(...(norm(params) as never[])).changes) })
	};
	// Outside a transaction, each query waits for any open transaction to finish.
	const guarded = <A extends unknown[], R>(f: (...a: A) => R) => (...a: A) => (inTx ? lock.run(async () => f(...a)) : Promise.resolve(f(...a)));

	const txDb: Db = {
		kind: 'sqlite',
		all: async (s, p) => exec.all(s, p),
		get: async (s, p) => exec.get(s, p),
		run: async (s, p) => exec.run(s, p),
		tx: (fn) => fn(txDb),
		close: async () => {}
	};

	return {
		kind: 'sqlite',
		all: guarded(exec.all) as Db['all'],
		get: guarded(exec.get) as Db['get'],
		run: guarded(exec.run),
		tx: (fn) =>
			lock.run(async () => {
				inTx = true;
				raw.exec('BEGIN IMMEDIATE');
				try {
					const out = await fn(txDb);
					raw.exec('COMMIT');
					return out;
				} catch (err) {
					raw.exec('ROLLBACK');
					throw err;
				} finally {
					inTx = false;
				}
			}),
		close: async () => raw.close()
	};
}

/** `?` → `$1, $2…`, skipping question marks inside string literals. */
export function toPgPlaceholders(sql: string): string {
	let n = 0;
	let out = '';
	let quoted = false;
	for (const ch of sql) {
		if (ch === "'") quoted = !quoted;
		out += ch === '?' && !quoted ? `$${++n}` : ch;
	}
	return out;
}

async function openPostgres(url: string): Promise<Db> {
	const { default: pg } = await import('pg');
	// COUNT(*) and other int8 results come back as strings by default; these values are small.
	pg.types.setTypeParser(20, (v) => Number(v));
	const pool = new pg.Pool({ connectionString: url, max: Number(process.env.ACM_DATABASE_POOL || 10) });

	type Q = { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }> };
	const wrap = (c: Q, txFn: Db['tx']): Db => ({
		kind: 'postgres',
		all: async <T>(s: string, p?: Param[]) => (await c.query(toPgPlaceholders(s), norm(p))).rows as T[],
		get: async <T>(s: string, p?: Param[]) => (await c.query(toPgPlaceholders(s), norm(p))).rows[0] as T | undefined,
		run: async (s, p) => ({ changes: (await c.query(toPgPlaceholders(s), norm(p))).rowCount ?? 0 }),
		tx: txFn,
		close: async () => pool.end()
	});

	const root: Db = wrap(pool, async (fn) => {
		const client = await pool.connect();
		try {
			await client.query('BEGIN');
			const inner: Db = wrap(client, (f) => f(inner));
			const out = await fn(inner);
			await client.query('COMMIT');
			return out;
		} catch (err) {
			await client.query('ROLLBACK').catch(() => {});
			throw err;
		} finally {
			client.release();
		}
	});
	return root;
}

/** Arbitrary key for the Postgres advisory lock that serialises migrations across instances. */
const MIGRATION_LOCK = 7_302_114_551;

async function migrate(db: Db) {
	// One transaction for the whole run. On Postgres an advisory lock makes other instances
	// starting at the same time wait, then see the migrations already applied.
	await db.tx(async (tx) => {
		if (tx.kind === 'postgres') await tx.get('SELECT pg_advisory_xact_lock(?)', [MIGRATION_LOCK]);
		await tx.run('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
		const done = new Set((await tx.all<{ version: number }>('SELECT version FROM schema_migrations')).map((r) => Number(r.version)));
		for (const [i, sql] of MIGRATIONS.entries()) {
			const version = i + 1;
			if (done.has(version)) continue;
			for (const stmt of sql.split(/;\s*$/m).map((s) => s.trim()).filter(Boolean)) await tx.run(stmt);
			await tx.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', [version, new Date().toISOString()]);
		}
	});
}

export async function openDb(url = config.databaseUrl): Promise<Db> {
	let db: Db;
	if (/^postgres(ql)?:\/\//.test(url)) {
		db = await openPostgres(url);
	} else {
		const file = url.startsWith('sqlite:') ? url.slice('sqlite:'.length) : url || join(config.dataDir, 'ac-modern.db');
		if (file !== ':memory:') mkdirSync(join(file, '..'), { recursive: true });
		db = await openSqlite(file);
	}
	await migrate(db);
	return db;
}

let shared: Promise<Db> | undefined;

/** The app-wide database, opened and migrated on first use. */
export function db(): Promise<Db> {
	shared ??= openDb();
	return shared;
}

/** Tests swap in their own database. */
export function setDb(d: Db) {
	shared = Promise.resolve(d);
}
