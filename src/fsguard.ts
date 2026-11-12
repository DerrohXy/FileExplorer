import fs from "node:fs/promises";
import path from "node:path";
import { getGrant, grantsOf, type User } from "./db";
import { info, type Kind } from "./kinds";

export class NotFound extends Error {}

// ---------- configured roots (the only places that can ever be exposed) ----------
export interface RootCfg {
    name: string;
    path: string;
}

function parseRoots(s: string): RootCfg[] {
    return s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => {
            const i = x.indexOf("=");
            const p = path.resolve(i > 0 ? x.slice(i + 1).trim() : x);
            return {
                name:
                    (i > 0 ? x.slice(0, i).trim() : "") ||
                    path.basename(p) ||
                    p,
                path: p,
            };
        });
}

export const ROOTS = parseRoots(process.env.MEDIA_ROOTS ?? "/media");

export const within = (parent: string, child: string) =>
    child === parent ||
    child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

const rp = (p: string) => fs.realpath(p).catch(() => null);

const isDir = (p: string) =>
    fs.stat(p).then(
        (s) => s.isDirectory(),
        () => false,
    );

export const badSeg = (s: string) =>
    !s || s.startsWith(".") || /[\0/\\]/.test(s);

/** Roots resolved NOW (index-aligned with ROOTS; real=null if missing). Nothing is cached. */
export async function realRoots() {
    return Promise.all(
        ROOTS.map(async (r) => ({ name: r.name, real: await rp(r.path) })),
    );
}

// ---------- locations = the top of what a user may see ----------
export interface Loc {
    gid: string;
    label: string;
    real: string;
}

async function grantLoc(
    row: { id: number; path: string },
    roots: { real: string | null }[],
): Promise<Loc | null> {
    const real = await rp(row.path);
    if (!real || !(await isDir(real))) return null;
    // root config changed -> grant dormant
    if (!roots.some((r) => r.real && within(r.real, real))) return null;
    return { gid: `g${row.id}`, label: path.basename(real) || real, real };
}

async function allLocations(user: User): Promise<Loc[]> {
    const roots = await realRoots();
    if (user.is_admin)
        return roots.flatMap((r, i) =>
            r.real ? [{ gid: `r${i}`, label: r.name, real: r.real }] : [],
        );
    const out = await Promise.all(
        grantsOf(user.id).map((g) => grantLoc(g, roots)),
    );
    return out.filter((x): x is Loc => !!x);
}

/** The top-most directories the user holds: grants nested under another grant are dropped. */
export async function topLocations(user: User): Promise<Loc[]> {
    const all = await allLocations(user);
    return all.filter(
        (a, i) =>
            !all.some(
                (b, j) =>
                    j !== i &&
                    within(b.real, a.real) &&
                    (b.real !== a.real || j < i),
            ),
    );
}

/** Resolve a URL's grant id for this user. Re-checked on every request, so revocation is immediate. */
export async function locate(user: User, gid: string): Promise<Loc | null> {
    const m = /^([rg])(\d+)$/.exec(gid);
    if (!m) return null;
    const roots = await realRoots();
    if (m[1] === "r") {
        const r = user.is_admin ? roots[Number(m[2])] : undefined;
        return r?.real ? { gid, label: r.name, real: r.real } : null;
    }
    if (user.is_admin) return null;
    const row = getGrant(user.id, Number(m[2]));
    return row ? grantLoc(row, roots) : null;
}

/** Resolve path segments below a location. Symlinks are followed but may never leave the location. */
export async function resolveIn(loc: Loc, segs: string[]) {
    if (segs.some(badSeg)) throw new NotFound();
    const real = await rp(path.join(loc.real, ...segs));
    if (!real || !within(loc.real, real)) throw new NotFound();
    const st = await fs.stat(real).catch(() => {
        throw new NotFound();
    });
    return { real, st };
}

// ---------- listing (always read fresh from disk) ----------
export interface Entry {
    name: string;
    isDir: boolean;
    size: number;
    mtime: number;
    kind: Kind;
}

export async function listDir(loc: Loc, dir: string): Promise<Entry[]> {
    const dirents = (await fs.readdir(dir, { withFileTypes: true })).filter(
        (d) => !d.name.startsWith("."),
    );
    const out: Entry[] = [];
    for (let i = 0; i < dirents.length; i += 64) {
        const part = await Promise.all(
            dirents.slice(i, i + 64).map(async (d): Promise<Entry | null> => {
                try {
                    const full = path.join(dir, d.name);
                    if (d.isSymbolicLink()) {
                        const real = await fs.realpath(full);
                        // symlink leaves the granted tree: invisible
                        if (!within(loc.real, real)) return null;
                    } else if (!d.isDirectory() && !d.isFile()) return null;
                    const st = await fs.stat(full);
                    if (!st.isDirectory() && !st.isFile()) return null;
                    return {
                        name: d.name,
                        isDir: st.isDirectory(),
                        size: st.isDirectory() ? 0 : st.size,
                        mtime: st.mtimeMs,
                        kind: st.isDirectory() ? "dir" : info(d.name).kind,
                    };
                } catch {
                    return null;
                }
            }),
        );
        for (const e of part) if (e) out.push(e);
    }
    return out;
}

// ---------- admin helpers ----------
/** Validate "root #i + relative sub path" and return the real directory to store as a grant. */
export async function resolveRootPath(
    rootIdx: number,
    rel: string,
): Promise<string> {
    const r = (await realRoots())[rootIdx];
    if (!r?.real) throw new Error("Unknown or unavailable root");
    const segs = rel
        .split("/")
        .map((x) => x.trim())
        .filter(Boolean);
    if (segs.some(badSeg)) throw new Error("Invalid path");
    const real = await rp(path.join(r.real, ...segs));
    if (!real || !within(r.real, real))
        throw new Error("Directory not found under that root");
    if (!(await isDir(real))) throw new Error("Not a directory");
    return real;
}

export async function describePath(real: string) {
    const roots = await realRoots();
    const exists = !!(await rp(real));
    const r = roots.find((x) => x.real && within(x.real, real));
    return {
        display: r
            ? [r.name, path.relative(r.real!, real)].filter(Boolean).join("/")
            : real,
        ok: exists && !!r,
    };
}

/** Sub-directory suggestions for the admin path box. */
export async function suggestDirs(
    rootIdx: number,
    q: string,
): Promise<string[]> {
    const r = (await realRoots())[rootIdx];
    if (!r?.real) return [];
    const parts = q.split("/");
    const prefix = (parts.pop() ?? "").toLowerCase();
    const parent = parts.filter(Boolean);
    if (parent.some(badSeg)) return [];
    const base = await rp(path.join(r.real, ...parent));
    if (!base || !within(r.real, base)) return [];
    const list = await fs
        .readdir(base, { withFileTypes: true })
        .catch(() => []);
    const dirs = list.filter(
        (d) =>
            !d.name.startsWith(".") &&
            d.name.toLowerCase().startsWith(prefix) &&
            (d.isDirectory() || d.isSymbolicLink()),
    );
    return dirs.slice(0, 50).map((d) => [...parent, d.name].join("/") + "/");
}
