import Database from "better-sqlite3";
import crypto from "node:crypto";

export const db = new Database(process.env.SQLITE_PATH ?? "data.sqlite");
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0);
-- a grant gives a user a directory (absolute real path) and everything below it
CREATE TABLE IF NOT EXISTS grants(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  path TEXT NOT NULL, UNIQUE(user_id, path));
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- every file view / download / stream / shared-link use; rows survive user deletion
CREATE TABLE IF NOT EXISTS access_log(
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username TEXT NOT NULL, action TEXT NOT NULL, via TEXT NOT NULL, file TEXT NOT NULL, shown TEXT NOT NULL,
  ip TEXT NOT NULL DEFAULT '', ua TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS access_log_user ON access_log(user_id, ts);
CREATE INDEX IF NOT EXISTS access_log_ts ON access_log(ts);
CREATE TABLE IF NOT EXISTS sessions(
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL, expires INTEGER NOT NULL);
`);

// ---------- passwords ----------
const hashPassword = (pw: string) => {
    const salt = crypto.randomBytes(16);
    return (
        salt.toString("hex") +
        ":" +
        crypto.scryptSync(pw, salt, 64).toString("hex")
    );
};

const checkPassword = (pw: string, stored: string) => {
    const [s, h] = stored.split(":");
    return crypto.timingSafeEqual(
        crypto.scryptSync(pw, Buffer.from(s, "hex"), 64),
        Buffer.from(h, "hex"),
    );
};

const DUMMY = hashPassword("dummy-password");

// ---------- users ----------
export interface User {
    id: number;
    username: string;
    is_admin: boolean;
}

const toUser = (r: any): User | undefined =>
    r && { id: r.id, username: r.username, is_admin: !!r.is_admin };

export const getUser = (id: number) =>
    toUser(
        db.prepare("SELECT id,username,is_admin FROM users WHERE id=?").get(id),
    );

export const listUsers = () =>
    (
        db
            .prepare("SELECT id,username,is_admin FROM users ORDER BY username")
            .all() as any[]
    ).map((r) => toUser(r)!);

export function authenticate(username: string, password: string): User | null {
    const r = db
        .prepare("SELECT id,password_hash FROM users WHERE username=?")
        .get(username) as any;
    const ok = checkPassword(password, r?.password_hash ?? DUMMY);
    return r && ok ? getUser(r.id)! : null;
}

export function checkUserPassword(id: number, pw: string) {
    const r = db
        .prepare("SELECT password_hash FROM users WHERE id=?")
        .get(id) as any;
    return !!r && checkPassword(pw, r.password_hash);
}

export const validUsername = (u: string) => /^[\w.@-]{3,64}$/.test(u);

export function createUser(
    username: string,
    password: string,
    isAdmin: boolean,
) {
    if (!validUsername(username))
        throw new Error(
            "Username must be 3-64 characters: letters, digits, . _ - @",
        );
    if (password.length < 8)
        throw new Error("Password must be at least 8 characters");
    try {
        return Number(
            db
                .prepare(
                    "INSERT INTO users(username,password_hash,is_admin) VALUES(?,?,?)",
                )
                .run(username, hashPassword(password), isAdmin ? 1 : 0)
                .lastInsertRowid,
        );
    } catch (e: any) {
        if (String(e.code).startsWith("SQLITE_CONSTRAINT"))
            throw new Error("That username is already taken");
        throw e;
    }
}

export function setPassword(id: number, pw: string) {
    if (pw.length < 8)
        throw new Error("Password must be at least 8 characters");
    db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(
        hashPassword(pw),
        id,
    );
}

export function setUsername(id: number, username: string) {
    if (!validUsername(username)) throw new Error("Invalid username");
    try {
        db.prepare("UPDATE users SET username=? WHERE id=?").run(username, id);
    } catch {
        throw new Error("That username is already taken");
    }
}

const adminCount = () =>
    (db.prepare("SELECT COUNT(*) c FROM users WHERE is_admin=1").get() as any)
        .c as number;

export function setAdmin(id: number, isAdmin: boolean) {
    if (!isAdmin && getUser(id)?.is_admin && adminCount() <= 1)
        throw new Error("Can't remove the last admin");
    db.prepare("UPDATE users SET is_admin=? WHERE id=?").run(
        isAdmin ? 1 : 0,
        id,
    );
}

export function deleteUser(id: number) {
    if (getUser(id)?.is_admin && adminCount() <= 1)
        throw new Error("Can't delete the last admin");
    db.prepare("DELETE FROM users WHERE id=?").run(id);
}

export function ensureRootUser() {
    const name = process.env.ROOT_USERNAME,
        pw = process.env.ROOT_PASSWORD;
    if (!name || !pw) {
        if (!adminCount())
            throw new Error(
                "No admin exists: set ROOT_USERNAME and ROOT_PASSWORD",
            );
        return;
    }
    const r = db
        .prepare("SELECT id FROM users WHERE username=?")
        .get(name) as any;
    if (!r) createUser(name, pw, true);
    else db.prepare("UPDATE users SET is_admin=1 WHERE id=?").run(r.id);
}

// ---------- sessions ----------
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const SESSION_MS = 12 * 3600_000;

export function createSession(userId: number) {
    const token = crypto.randomBytes(32).toString("hex");
    db.prepare("DELETE FROM sessions WHERE expires<?").run(Date.now());
    db.prepare("INSERT INTO sessions VALUES(?,?,?,?)").run(
        sha(token),
        userId,
        crypto.randomBytes(24).toString("hex"),
        Date.now() + SESSION_MS,
    );
    return { token, maxAge: SESSION_MS };
}

export function getSession(token: string) {
    return db
        .prepare(
            "SELECT user_id,csrf FROM sessions WHERE token_hash=? AND expires>?",
        )
        .get(sha(token), Date.now()) as
        | { user_id: number; csrf: string }
        | undefined;
}

export const deleteSession = (token: string) =>
    void db.prepare("DELETE FROM sessions WHERE token_hash=?").run(sha(token));

export const deleteOtherSessions = (userId: number, keep: string) =>
    void db
        .prepare("DELETE FROM sessions WHERE user_id=? AND token_hash<>?")
        .run(userId, sha(keep));

// ---------- grants ----------
export interface GrantRow {
    id: number;
    path: string;
}

export const grantsOf = (userId: number) =>
    db
        .prepare("SELECT id,path FROM grants WHERE user_id=? ORDER BY path")
        .all(userId) as GrantRow[];

export const getGrant = (userId: number, id: number) =>
    db
        .prepare("SELECT id,path FROM grants WHERE user_id=? AND id=?")
        .get(userId, id) as GrantRow | undefined;

export const addGrant = (userId: number, path: string) =>
    void db
        .prepare("INSERT OR IGNORE INTO grants(user_id,path) VALUES(?,?)")
        .run(userId, path);

export const removeGrant = (userId: number, id: number) =>
    void db
        .prepare("DELETE FROM grants WHERE user_id=? AND id=?")
        .run(userId, id);

// ---------- link-signing secret (env LINK_SECRET, else generated once and kept in the DB) ----------
export function linkSecret(): string {
    if (process.env.LINK_SECRET) return process.env.LINK_SECRET;
    const r = db
        .prepare("SELECT value FROM settings WHERE key='link_secret'")
        .get() as any;
    if (r) return r.value;
    const v = crypto.randomBytes(32).toString("hex");
    db.prepare("INSERT INTO settings VALUES('link_secret',?)").run(v);
    return v;
}

// ---------- access log ----------
export type LogAction = "view" | "download" | "stream" | "link_created";

export interface LogRow {
    id: number;
    ts: number;
    user_id: number | null;
    username: string;
    action: string;
    via: string;
    file: string;
    shown: string;
    ip: string;
}

const recent = new Map<string, number>();

export function logAccess(e: {
    user: User;
    action: LogAction;
    via: "session" | "link";
    file: string;
    shown: string;
    ip?: string;
    ua?: string;
}) {
    // collapse bursts (players fire several requests per play):
    // same user+file+action+via within 30s = one entry
    const key = `${e.user.id}|${e.action}|${e.via}|${e.file}`,
        now = Date.now();
    if (e.action !== "link_created") {
        if ((recent.get(key) ?? 0) > now - 30_000) return;
        recent.set(key, now);
        if (recent.size > 5000)
            for (const [k, v] of recent) if (v < now - 30_000) recent.delete(k);
    }
    db.prepare(
        "INSERT INTO access_log(ts,user_id,username,action,via,file,shown,ip,ua) VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(
        now,
        e.user.id,
        e.user.username,
        e.action,
        e.via,
        e.file,
        e.shown,
        e.ip ?? "",
        (e.ua ?? "").slice(0, 200),
    );
}

export function listLog(userId: number | null, limit: number, offset: number) {
    const where = userId === null ? "" : "WHERE user_id=?",
        args = userId === null ? [] : [userId];
    const total = (
        db
            .prepare(`SELECT COUNT(*) c FROM access_log ${where}`)
            .get(...args) as any
    ).c as number;
    const rows = db
        .prepare(
            `SELECT * FROM access_log ${where} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`,
        )
        .all(...args, limit, offset) as LogRow[];
    return { total, rows };
}
