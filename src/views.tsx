import { Document, JsonScript } from "swiftssr";
import type { User, LogRow } from "./db";
import type { Entry } from "./fsguard";
import type { Kind } from "./kinds";

type C = any;

export interface Ctx {
    user?: User;
    csrf?: string;
    ok?: string;
    err?: string;
}
export interface Crumb {
    name: string;
    href: string;
}

const enc = encodeURIComponent;
const ICON: Record<Kind, string> = {
    dir: "📁",
    video: "🎬",
    audio: "🎵",
    image: "🖼️",
    pdf: "📕",
    text: "📄",
    other: "📦",
};

export const fmtSize = (n: number) => {
    if (n < 1024) return `${n} B`;
    const u = ["KB", "MB", "GB", "TB"];
    let i = -1;
    do {
        n /= 1024;
        i++;
    } while (n >= 1024 && i < u.length - 1);
    return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
};

export const fmtDate = (ms: number) =>
    new Date(ms).toISOString().slice(0, 16).replace("T", " ");

export function page(
    ctx: Ctx,
    title: string,
    body: C,
    opts: { player?: boolean } = {},
): string {
    const u = ctx.user;
    return Document({
        title: `${title} · File Explorer`,
        htmlProps: { "data-bs-theme": "dark" },
        head: [
            <link
                rel="stylesheet"
                href="/vendor/bootstrap/bootstrap.min.css"
            />,
            opts.player ? (
                <link
                    rel="stylesheet"
                    href="/vendor/videojs/video-js.min.css"
                />
            ) : null,
            <link rel="stylesheet" href="/static/app.css" />,
        ],
        body: (
            <>
                <nav className="navbar navbar-expand bg-body-tertiary border-bottom px-3">
                    <a className="navbar-brand fw-semibold" href="/">
                        📂 File Explorer
                    </a>
                    {u && (
                        <>
                            <ul className="navbar-nav me-auto">
                                {u.is_admin && (
                                    <li className="nav-item">
                                        <a
                                            className="nav-link"
                                            href="/admin/users"
                                        >
                                            Users
                                        </a>
                                    </li>
                                )}
                                {u.is_admin && (
                                    <li className="nav-item">
                                        <a
                                            className="nav-link"
                                            href="/admin/log"
                                        >
                                            Activity
                                        </a>
                                    </li>
                                )}
                            </ul>
                            <a className="nav-link me-3" href="/account">
                                {u.username}
                                {u.is_admin ? " (admin)" : ""}
                            </a>
                            <Form ctx={ctx} action="/logout">
                                <button className="btn btn-sm btn-outline-secondary">
                                    Sign out
                                </button>
                            </Form>
                        </>
                    )}
                </nav>
                <main className="container-fluid py-4 px-4">
                    {ctx.ok && (
                        <div className="alert alert-success">{ctx.ok}</div>
                    )}
                    {ctx.err && (
                        <div className="alert alert-danger">{ctx.err}</div>
                    )}
                    {body}
                </main>
                {opts.player && (
                    <script src="/vendor/videojs/video.min.js"></script>
                )}
                {opts.player && <script src="/static/player.js"></script>}
                <script src="/static/app.js"></script>
            </>
        ),
    });
}

export function Form(p: {
    ctx: Ctx;
    action: string;
    ret?: string;
    confirm?: string;
    cls?: string;
    id?: string;
    children?: C;
}) {
    return (
        <form
            method="post"
            action={p.action}
            className={p.cls}
            id={p.id}
            data-confirm={p.confirm}
        >
            <input type="hidden" name="_csrf" value={p.ctx.csrf ?? ""} />
            {p.ret && <input type="hidden" name="ret" value={p.ret} />}
            {p.children}
        </form>
    );
}

const Field = (p: { label: string; children?: C }) => (
    <div className="mb-3">
        <label className="form-label fw-semibold">{p.label}</label>
        {p.children}
    </div>
);

const Card = (p: { title: string; children?: C }) => (
    <div className="card shadow-sm mb-4">
        <div className="card-header fw-semibold">{p.title}</div>
        <div className="card-body">{p.children}</div>
    </div>
);

export const Crumbs = (p: { items: Crumb[] }) => (
    <nav className="mb-3 text-body-secondary">
        <a href="/">Locations</a>
        {p.items.map((c, i) => (
            <>
                {" "}
                /{" "}
                {i === p.items.length - 1 ? (
                    <strong>{c.name}</strong>
                ) : (
                    <a href={c.href}>{c.name}</a>
                )}
            </>
        ))}
    </nav>
);

// ---------------- auth / account ----------------
export const LoginPage = () => (
    <div className="row justify-content-center">
        <div className="col-md-4 mt-5">
            <Card title="Sign in">
                <form method="post" action="/login">
                    <Field label="Username">
                        <input
                            className="form-control"
                            name="username"
                            autocomplete="username"
                            required
                            autofocus
                        />
                    </Field>
                    <Field label="Password">
                        <input
                            className="form-control"
                            type="password"
                            name="password"
                            autocomplete="current-password"
                            required
                        />
                    </Field>
                    <button className="btn btn-primary w-100">Sign in</button>
                </form>
            </Card>
        </div>
    </div>
);

export const AccountPage = (p: { ctx: Ctx }) => (
    <div className="row">
        <div className="col-md-5">
            <Card title="Account settings">
                <Form ctx={p.ctx} action="/account">
                    <Field label="Username">
                        <input
                            className="form-control"
                            name="username"
                            value={p.ctx.user!.username}
                            required
                        />
                    </Field>
                    <Field label="New password (leave blank to keep)">
                        <input
                            className="form-control"
                            type="password"
                            name="new_password"
                            autocomplete="new-password"
                        />
                    </Field>
                    <Field label="Confirm new password">
                        <input
                            className="form-control"
                            type="password"
                            name="confirm"
                            autocomplete="new-password"
                        />
                    </Field>
                    <hr />
                    <Field label="Current password (required)">
                        <input
                            className="form-control"
                            type="password"
                            name="current_password"
                            autocomplete="current-password"
                            required
                        />
                    </Field>
                    <button className="btn btn-primary me-2">Save</button>
                    <a className="btn btn-link" href="/account/log">
                        My activity
                    </a>
                </Form>
            </Card>
        </div>
    </div>
);

// ---------------- home / browse ----------------
export interface Tile {
    gid: string;
    label: string;
    total?: number;
    free?: number;
}

export const HomePage = (p: { tiles: Tile[]; admin: boolean }) => (
    <>
        <h4 className="mb-3">Your locations</h4>
        {!p.tiles.length && (
            <div className="alert alert-info">
                {p.admin
                    ? "None of the configured MEDIA_ROOTS exist on this server."
                    : "You haven't been granted access to any folders yet. Ask an admin."}
            </div>
        )}
        <div className="row g-3">
            {p.tiles.map((t) => {
                const used = t.total
                    ? Math.round(((t.total - (t.free ?? 0)) / t.total) * 100)
                    : null;
                return (
                    <div className="col-md-4 col-xl-3">
                        <a
                            className="card shadow-sm text-decoration-none h-100"
                            href={`/b/${t.gid}`}
                        >
                            <div className="card-body">
                                <div className="fs-5">📁 {t.label}</div>
                                {used !== null && (
                                    <>
                                        <div
                                            className="progress my-2"
                                            style={{ height: "6px" }}
                                        >
                                            <div
                                                className="progress-bar"
                                                style={{ width: `${used}%` }}
                                            ></div>
                                        </div>
                                        <div className="small text-body-secondary">
                                            {fmtSize(t.free ?? 0)} free of{" "}
                                            {fmtSize(t.total!)}
                                        </div>
                                    </>
                                )}
                            </div>
                        </a>
                    </div>
                );
            })}
        </div>
    </>
);

export interface ListProps {
    base: string;
    entries: Entry[];
    dirs: number;
    files: number;
    sort: string;
    dir: string;
    page: number;
    pages: number;
}

export function Listing(p: ListProps) {
    const qs = (o: Record<string, string | number>) =>
        "?" +
        new URLSearchParams(
            Object.entries({
                sort: p.sort,
                dir: p.dir,
                page: p.page,
                ...o,
            }).map(([k, v]) => [k, String(v)]),
        ).toString();
    const th = (key: string, label: string, cls = "") => (
        <th className={cls}>
            <a
                className="text-reset text-decoration-none"
                href={qs({
                    sort: key,
                    dir: p.sort === key && p.dir === "asc" ? "desc" : "asc",
                    page: 1,
                })}
            >
                {label}
                {p.sort === key ? (p.dir === "asc" ? " ▲" : " ▼") : ""}
            </a>
        </th>
    );
    return (
        <>
            <table className="table table-hover align-middle mb-2">
                <thead>
                    <tr>
                        {th("name", "Name")}
                        {th("size", "Size", "text-end")}
                        {th("mtime", "Modified")}
                    </tr>
                </thead>
                <tbody>
                    {p.entries.map((e) => (
                        <tr data-name={e.name.toLowerCase()}>
                            <td>
                                <a
                                    className="text-decoration-none"
                                    href={`${p.base}/${enc(e.name)}`}
                                >
                                    {ICON[e.kind]} {e.name}
                                </a>
                                {e.kind === "other" && (
                                    <span className="badge text-bg-secondary ms-2">
                                        download
                                    </span>
                                )}
                            </td>
                            <td className="text-end text-nowrap">
                                {e.isDir ? "" : fmtSize(e.size)}
                            </td>
                            <td className="text-nowrap">{fmtDate(e.mtime)}</td>
                        </tr>
                    ))}
                    {!p.entries.length && (
                        <tr>
                            <td colspan={3} className="text-body-secondary">
                                This folder is empty
                            </td>
                        </tr>
                    )}
                </tbody>
            </table>
            <div className="d-flex gap-3 align-items-center small text-body-secondary">
                <span>
                    {p.dirs} folder(s), {p.files} file(s)
                </span>
                {p.page > 1 && <a href={qs({ page: p.page - 1 })}>‹ Prev</a>}
                {p.pages > 1 && (
                    <span>
                        Page {p.page} / {p.pages}
                    </span>
                )}
                {p.page < p.pages && (
                    <a href={qs({ page: p.page + 1 })}>Next ›</a>
                )}
            </div>
        </>
    );
}

export const BrowsePage = (p: { crumbs: Crumb[]; listing: C }) => (
    <>
        <Crumbs items={p.crumbs} />
        <div className="d-flex gap-2 mb-3">
            <input
                id="filter"
                className="form-control w-auto"
                placeholder="Filter this page…"
                autocomplete="off"
            />
            <span
                id="live"
                className="small text-body-secondary align-self-center"
            >
                live: refreshes automatically
            </span>
        </div>
        <div id="listing">{p.listing}</div>
    </>
);

// ---------------- viewer ----------------
export interface ViewerProps {
    ctx: Ctx;
    crumbs: Crumb[];
    name: string;
    kind: Kind;
    rawUrl: string;
    size: number;
    mtime: number;
    prev?: Crumb;
    next?: Crumb;
    text?: { body: string; truncated: boolean };
    cfg?: unknown;
    linkAction?: string;
}

export function ViewerPage(p: ViewerProps) {
    const av = p.kind === "video" || p.kind === "audio";
    return (
        <>
            <Crumbs items={p.crumbs} />
            <div className="d-flex flex-wrap gap-2 align-items-center mb-3">
                <h5 className="mb-0 me-auto">{p.name}</h5>
                <span className="small text-body-secondary">
                    {fmtSize(p.size)} · {fmtDate(p.mtime)}
                </span>
                {p.prev && (
                    <a
                        className="btn btn-sm btn-outline-secondary"
                        href={p.prev.href}
                        title={p.prev.name}
                    >
                        ‹ Previous
                    </a>
                )}
                {p.next && (
                    <a
                        className="btn btn-sm btn-outline-secondary"
                        href={p.next.href}
                        title={p.next.name}
                    >
                        Next ›
                    </a>
                )}
            </div>
            {p.kind === "image" && (
                <div className="text-center">
                    <img
                        className="img-fluid rounded"
                        src={p.rawUrl}
                        alt={p.name}
                    />
                </div>
            )}
            {p.kind === "pdf" && (
                <iframe
                    className="w-100 border rounded"
                    style={{ height: "80vh" }}
                    src={p.rawUrl}
                    title={p.name}
                ></iframe>
            )}
            {p.kind === "text" && p.text && (
                <>
                    <pre
                        className="p-3 border rounded bg-body-tertiary"
                        style={{ whiteSpace: "pre-wrap" }}
                    >
                        {p.text.body}
                    </pre>
                    {p.text.truncated && (
                        <div className="text-body-secondary small">
                            Showing the first 512 KB.
                        </div>
                    )}
                </>
            )}
            {av && (
                <div className="row g-3">
                    <div className="col-lg-9">
                        {p.kind === "video" ? (
                            <video
                                id="player"
                                className="video-js vjs-big-play-centered vjs-fluid"
                                controls
                                preload="metadata"
                                playsinline
                            ></video>
                        ) : (
                            <audio
                                id="player"
                                className="video-js"
                                controls
                                preload="metadata"
                            ></audio>
                        )}
                        <div
                            id="notice"
                            className="alert alert-warning mt-3 d-none"
                        ></div>
                        <div
                            id="remux-seek"
                            className="d-none mt-2 d-flex gap-2 align-items-center"
                        >
                            <span className="small">Seek</span>
                            <input
                                id="remux-range"
                                type="range"
                                min="0"
                                max="0"
                                step="1"
                                className="form-range"
                            />
                            <span
                                id="remux-time"
                                className="small text-nowrap"
                            ></span>
                        </div>
                        <div className="mt-3">
                            <Form
                                ctx={p.ctx}
                                action={p.linkAction!}
                                id="link-form"
                                cls="d-flex flex-wrap gap-2 align-items-center"
                            >
                                <span className="small text-body-secondary">
                                    Can't play it here? Copy a link for an
                                    external player (VLC, mpv…):
                                </span>
                                <select
                                    name="ttl"
                                    className="form-select form-select-sm w-auto"
                                >
                                    <option value="3600">valid 1 hour</option>
                                    <option value="86400" selected>
                                        valid 24 hours
                                    </option>
                                    <option value="604800">valid 7 days</option>
                                    <option value="2592000">
                                        valid 30 days
                                    </option>
                                </select>
                                <button className="btn btn-sm btn-outline-primary">
                                    Copy link
                                </button>
                            </Form>
                            <div id="link-out" className="d-none mt-2">
                                <input
                                    id="link-url"
                                    className="form-control form-control-sm font-monospace"
                                    readonly
                                />
                                <div
                                    id="link-msg"
                                    className="small text-body-secondary mt-1"
                                ></div>
                            </div>
                        </div>
                    </div>
                    <div className="col-lg-3">
                        <div className="card">
                            <div className="card-header fw-semibold">
                                Tracks
                            </div>
                            <div className="card-body small" id="tracks">
                                Loading track info…
                            </div>
                        </div>
                    </div>
                    {JsonScript(p.cfg as object, { id: "player-cfg" })}
                </div>
            )}
        </>
    );
}

// ---------------- admin ----------------
export const UsersPage = (p: { ctx: Ctx; users: User[] }) => (
    <div className="row">
        <div className="col-md-8">
            <table className="table table-hover align-middle">
                <thead>
                    <tr>
                        <th>User</th>
                        <th>Role</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody>
                    {p.users.map((u) => (
                        <tr>
                            <td>{u.username}</td>
                            <td>
                                {u.is_admin ? (
                                    <span className="badge bg-danger">
                                        admin
                                    </span>
                                ) : (
                                    <span className="badge bg-secondary">
                                        user
                                    </span>
                                )}
                            </td>
                            <td className="text-end text-nowrap">
                                <a
                                    className="btn btn-sm btn-outline-secondary me-1"
                                    href={`/admin/users/${u.id}`}
                                >
                                    Access
                                </a>
                                <a
                                    className="btn btn-sm btn-outline-secondary me-1"
                                    href={`/admin/log?user=${u.id}`}
                                >
                                    Activity
                                </a>
                                {u.id !== p.ctx.user!.id && (
                                    <Form
                                        ctx={p.ctx}
                                        action={`/admin/users/${u.id}/delete`}
                                        cls="d-inline"
                                        confirm={`Delete user ${u.username}?`}
                                    >
                                        <button className="btn btn-sm btn-outline-danger">
                                            Delete
                                        </button>
                                    </Form>
                                )}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
        <div className="col-md-4">
            <Card title="Add user">
                <Form ctx={p.ctx} action="/admin/users">
                    <Field label="Username">
                        <input
                            className="form-control"
                            name="username"
                            required
                        />
                    </Field>
                    <Field label="Password (min 8)">
                        <input
                            className="form-control"
                            type="password"
                            name="password"
                            autocomplete="new-password"
                            required
                        />
                    </Field>
                    <div className="form-check mb-3">
                        <input
                            className="form-check-input"
                            type="checkbox"
                            name="is_admin"
                            id="isadm"
                        />
                        <label className="form-check-label" htmlFor="isadm">
                            Administrator (sees every root)
                        </label>
                    </div>
                    <button className="btn btn-primary">Create</button>
                </Form>
            </Card>
        </div>
    </div>
);

export interface GrantView {
    id: number;
    display: string;
    ok: boolean;
}

export const UserEditPage = (p: {
    ctx: Ctx;
    u: User;
    grants: GrantView[];
    roots: { idx: number; name: string }[];
}) => {
    const self = p.u.id === p.ctx.user!.id,
        act = `/admin/users/${p.u.id}`;
    return (
        <>
            <h4 className="mb-3">
                <a href="/admin/users">Users</a> / {p.u.username}
            </h4>
            <div className="row">
                <div className="col-md-4">
                    <Card title="Role &amp; password">
                        <Form ctx={p.ctx} action={act}>
                            <div className="form-check mb-3">
                                <input
                                    className="form-check-input"
                                    type="checkbox"
                                    name="is_admin"
                                    id="a"
                                    checked={p.u.is_admin}
                                    disabled={self}
                                />
                                <label className="form-check-label" htmlFor="a">
                                    Administrator
                                </label>
                            </div>
                            <Field label="Reset password (optional)">
                                <input
                                    className="form-control"
                                    type="password"
                                    name="new_password"
                                    autocomplete="new-password"
                                />
                            </Field>
                            <button className="btn btn-primary">Save</button>
                        </Form>
                    </Card>
                </div>
                <div className="col-md-8">
                    <Card title="Folder access">
                        {p.u.is_admin && (
                            <div className="text-body-secondary small mb-2">
                                Admins see every configured root; grants below
                                are ignored while the user is an admin.
                            </div>
                        )}
                        <div className="small text-body-secondary mb-2">
                            A granted folder includes everything beneath it.
                            Remove the grant and all of it disappears for the
                            user immediately.
                        </div>
                        <table className="table table-sm align-middle">
                            <thead>
                                <tr>
                                    <th>Folder</th>
                                    <th></th>
                                </tr>
                            </thead>
                            <tbody>
                                {p.grants.map((g) => (
                                    <tr>
                                        <td className="font-monospace">
                                            {g.display}
                                            {!g.ok && (
                                                <span className="badge text-bg-warning ms-2">
                                                    missing / outside roots
                                                </span>
                                            )}
                                        </td>
                                        <td className="text-end">
                                            <Form
                                                ctx={p.ctx}
                                                action={`${act}/revoke`}
                                                cls="d-inline"
                                            >
                                                <input
                                                    type="hidden"
                                                    name="grant_id"
                                                    value={String(g.id)}
                                                />
                                                <button className="btn btn-sm btn-outline-danger py-0">
                                                    Revoke
                                                </button>
                                            </Form>
                                        </td>
                                    </tr>
                                ))}
                                {!p.grants.length && (
                                    <tr>
                                        <td
                                            colspan={2}
                                            className="text-body-secondary"
                                        >
                                            No folders granted
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                        <Form ctx={p.ctx} action={`${act}/grant`} cls="row g-2">
                            <div className="col-md-3">
                                <select
                                    id="grant-root"
                                    className="form-select"
                                    name="root"
                                >
                                    {p.roots.map((r) => (
                                        <option value={String(r.idx)}>
                                            {r.name}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <div className="col-md-6">
                                <input
                                    id="grant-path"
                                    className="form-control"
                                    name="path"
                                    list="dirs"
                                    placeholder="sub/folder (blank = whole root)"
                                    autocomplete="off"
                                />
                                <datalist id="dirs"></datalist>
                            </div>
                            <div className="col-md-3">
                                <button className="btn btn-primary w-100">
                                    Grant
                                </button>
                            </div>
                        </Form>
                    </Card>
                </div>
            </div>
        </>
    );
};

export const LogPage = (p: {
    title: string;
    rows: LogRow[];
    admin: boolean;
    showUser: boolean;
    page: number;
    pages: number;
    base: string;
}) => (
    <>
        <h4 className="mb-3">{p.title}</h4>
        <div className="table-responsive">
            <table className="table table-sm table-hover align-middle">
                <thead>
                    <tr>
                        <th>Time</th>
                        {p.showUser && <th>User</th>}
                        <th>Action</th>
                        <th>Via</th>
                        <th>File</th>
                        <th>IP</th>
                    </tr>
                </thead>
                <tbody>
                    {p.rows.map((r) => (
                        <tr>
                            <td className="text-nowrap">{fmtDate(r.ts)}</td>
                            {p.showUser && <td>{r.username}</td>}
                            <td>
                                <span
                                    className={`badge text-bg-${r.action === "download" ? "warning" : r.action === "link_created" ? "info" : "secondary"}`}
                                >
                                    {r.action}
                                </span>
                            </td>
                            <td>{r.via}</td>
                            <td className="font-monospace small">
                                {p.admin ? r.file : r.shown}
                            </td>
                            <td className="small">{r.ip}</td>
                        </tr>
                    ))}
                    {!p.rows.length && (
                        <tr>
                            <td colspan={6} className="text-body-secondary">
                                No activity recorded
                            </td>
                        </tr>
                    )}
                </tbody>
            </table>
        </div>
        <div className="d-flex gap-3 small">
            {p.page > 1 && (
                <a
                    href={`${p.base}${p.base.includes("?") ? "&" : "?"}page=${p.page - 1}`}
                >
                    ‹ Newer
                </a>
            )}
            <span>
                Page {p.page} / {p.pages}
            </span>
            {p.page < p.pages && (
                <a
                    href={`${p.base}${p.base.includes("?") ? "&" : "?"}page=${p.page + 1}`}
                >
                    Older ›
                </a>
            )}
        </div>
    </>
);

export const ErrorPage = (p: { code: number; message: string }) => (
    <div className="text-center mt-5">
        <h1>{p.code}</h1>
        <p className="text-body-secondary">{p.message}</p>
        <a href="/">Home</a>
    </div>
);
