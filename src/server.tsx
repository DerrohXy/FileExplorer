import express, {
    type Request,
    type Response,
    type NextFunction,
} from "express";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Render, SendHTML } from "swiftssr";
import * as D from "./db";
import {
    loadSession,
    csrfCheck,
    requireAuth,
    requireAdmin,
    loginBlocked,
    loginFailed,
    loginOk,
} from "./auth";
import * as F from "./fsguard";
import * as M from "./media";
import { info } from "./kinds";
import { makeToken, verifyToken } from "./links";
import * as V from "./views";

D.ensureRootUser();

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", process.env.TRUST_PROXY === "true");

const CSP =
    "default-src 'self'; img-src 'self' data:; media-src 'self' blob:; " +
    "style-src 'self' 'unsafe-inline'; script-src 'self'; " +
    "font-src 'self' data:; frame-src 'self'; connect-src 'self' blob:; " +
    "worker-src 'self' blob:; object-src 'none'; base-uri 'none'; " +
    "frame-ancestors 'self'; form-action 'self'";

app.use((req, res, next) => {
    res.set({
        "X-Frame-Options": "SAMEORIGIN",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "same-origin",
    });
    if (!req.path.startsWith("/raw/")) res.set("Content-Security-Policy", CSP);
    // /raw sets its own per file type
    next();
});

const NM = path.resolve("node_modules");

app.use("/vendor/videojs", express.static(path.join(NM, "video.js/dist")));

app.use(
    "/vendor/bootstrap",
    express.static(path.join(NM, "bootstrap/dist/css")),
);

app.use("/static", express.static(path.resolve("public")));

app.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
}); // listings must always be live

app.use(express.urlencoded({ extended: false, limit: "1mb" }));

app.use(loadSession);

app.use(csrfCheck);

// ---------- helpers ----------
const P = (req: Request) => req.params as Record<string, any>;
const s = (v: unknown) => (typeof v === "string" ? v : "");
const body = (req: Request) => (req.body ?? {}) as Record<string, string>;
const errMsg = (e: any) => String(e?.message ?? "Unexpected error");
const ctxOf = (req: Request): V.Ctx => ({
    user: req.user,
    csrf: req.csrf,
    ok: s(req.query.ok) || undefined,
    err: s(req.query.err) || undefined,
});

const send = (
    req: Request,
    res: Response,
    title: string,
    content: any,
    status = 200,
    opts: { player?: boolean } = {},
) => SendHTML(res, V.page(ctxOf(req), title, content, opts), status);

const enc = encodeURIComponent;

const urlOf = (prefix: string, gid: string, segs: string[]) =>
    `/${prefix}/${gid}${segs.map((x) => "/" + enc(x)).join("")}`;
const segsOf = (req: Request): string[] => {
    const r = P(req).rel;
    return Array.isArray(r) ? r : r ? String(r).split("/") : [];
};
const coll = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
});

function flash(res: Response, dest: string, kind: "ok" | "err", msg: string) {
    const u = new URL(/^\/(?!\/)/.test(dest) ? dest : "/", "http://x");
    u.searchParams.delete("ok");
    u.searchParams.delete("err");
    u.searchParams.set(kind, msg);
    res.redirect(u.pathname + u.search);
}

const act =
    (
        dflt: (req: Request) => string,
        fn: (req: Request, res: Response) => unknown,
    ) =>
    async (req: Request, res: Response) => {
        const dest = body(req).ret || dflt(req);
        try {
            const m = await fn(req, res);
            if (!res.headersSent)
                flash(res, dest, "ok", typeof m === "string" ? m : "Done");
        } catch (e) {
            flash(res, dest, "err", errMsg(e));
        }
    };

/** Resolve the requested grant + path for the current user; throws NotFound for anything not permitted. */
async function target(req: Request) {
    const gid = String(P(req).gid),
        segs = segsOf(req);
    const loc = await F.locate(req.user!, gid);
    if (!loc) throw new F.NotFound();
    const { real, st } = await F.resolveIn(loc, segs);
    return { gid, loc, segs, real, st };
}

type Target = Awaited<ReturnType<typeof target>>;

function logFile(req: Request, res: Response, action: D.LogAction, t: Target) {
    const range = req.headers.range;
    if (range && !/^bytes=0-/.test(range)) return; // seeks inside a playing file aren't new accesses
    D.logAccess({
        user: req.user!,
        action,
        via: res.locals.via === "link" ? "link" : "session",
        file: t.real,
        shown: [t.loc.label, ...t.segs].join("/"),
        ip: req.ip,
        ua: req.get("user-agent"),
    });
}

// ---------- auth / account ----------
app.get("/login", (req, res) =>
    req.user ? res.redirect("/") : send(req, res, "Sign in", <V.LoginPage />),
);

app.post("/login", (req, res) => {
    const ip = req.ip ?? "?";
    if (loginBlocked(ip))
        return flash(
            res,
            "/login",
            "err",
            "Too many attempts. Try again later.",
        );
    const user = D.authenticate(s(body(req).username), s(body(req).password));
    if (!user) {
        loginFailed(ip);
        return flash(res, "/login", "err", "Invalid username or password");
    }
    loginOk(ip);
    const { token, maxAge } = D.createSession(user.id);
    res.cookie("sid", token, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.COOKIE_SECURE === "true",
        maxAge,
        path: "/",
    });
    res.redirect("/");
});

app.post("/logout", (req, res) => {
    if (req.sid) D.deleteSession(req.sid);
    res.clearCookie("sid", { path: "/" });
    res.redirect("/login");
});

app.get("/account", requireAuth, (req, res) =>
    send(req, res, "Account", <V.AccountPage ctx={ctxOf(req)} />),
);

app.post(
    "/account",
    requireAuth,
    act(
        () => "/account",
        (req) => {
            const b = body(req),
                u = req.user!;
            if (!D.checkUserPassword(u.id, s(b.current_password)))
                throw new Error("Current password is incorrect");
            if (b.username && b.username !== u.username)
                D.setUsername(u.id, b.username.trim());
            if (b.new_password) {
                if (b.new_password !== b.confirm)
                    throw new Error("New passwords don't match");
                D.setPassword(u.id, b.new_password);
                D.deleteOtherSessions(u.id, req.sid!);
            }
            return "Account updated";
        },
    ),
);

// ---------- activity logs ----------
const LOG_PAGE = 100;

function logPage(
    req: Request,
    res: Response,
    userId: number | null,
    title: string,
    base: string,
    admin: boolean,
) {
    const pg = Math.max(1, Math.floor(Number(req.query.page)) || 1);
    const { total, rows } = D.listLog(userId, LOG_PAGE, (pg - 1) * LOG_PAGE);
    send(
        req,
        res,
        title,
        <V.LogPage
            title={title}
            rows={rows}
            admin={admin}
            showUser={userId === null}
            page={pg}
            pages={Math.max(1, Math.ceil(total / LOG_PAGE))}
            base={base}
        />,
    );
}

app.get("/account/log", requireAuth, (req, res) =>
    logPage(req, res, req.user!.id, "My activity", "/account/log", false),
);

app.get("/admin/log", requireAdmin, (req, res) => {
    const uid = req.query.user ? Number(req.query.user) : null;
    const u = uid !== null ? D.getUser(uid) : null;
    logPage(
        req,
        res,
        uid,
        u ? `Activity: ${u.username}` : "All activity",
        uid !== null ? `/admin/log?user=${uid}` : "/admin/log",
        true,
    );
});

// ---------- home ----------
app.get("/", requireAuth, async (req, res) => {
    const locs = await F.topLocations(req.user!);
    const tiles: V.Tile[] = await Promise.all(
        locs.map(async (l) => {
            const st = await fsp.statfs(l.real).catch(() => null);
            return {
                gid: l.gid,
                label: l.label,
                total: st ? st.blocks * st.bsize : undefined,
                free: st ? st.bavail * st.bsize : undefined,
            };
        }),
    );
    send(
        req,
        res,
        "Locations",
        <V.HomePage tiles={tiles} admin={req.user!.is_admin} />,
    );
});

// ---------- browse / view ----------
app.get("/b/:gid{/*rel}", requireAuth, async (req, res) => {
    const t = await target(req);
    const crumbs = [
        { name: t.loc.label, href: urlOf("b", t.gid, []) },
        ...t.segs.map((n, i) => ({
            name: n,
            href: urlOf("b", t.gid, t.segs.slice(0, i + 1)),
        })),
    ];

    if (t.st.isDirectory()) {
        const q = req.query,
            key = ["name", "size", "mtime"].includes(s(q.sort))
                ? s(q.sort)
                : "name",
            desc = q.dir === "desc";
        const entries = await F.listDir(t.loc, t.real);
        entries.sort((a, b) => {
            if (a.isDir !== b.isDir) return a.isDir ? -1 : 1; // folders always first
            let c =
                key === "size"
                    ? a.size - b.size
                    : key === "mtime"
                      ? a.mtime - b.mtime
                      : coll.compare(a.name, b.name);
            if (c === 0) c = coll.compare(a.name, b.name);
            return desc ? -c : c;
        });
        const PER = 300,
            pages = Math.max(1, Math.ceil(entries.length / PER));
        const pg = Math.min(
            Math.max(1, Math.floor(Number(q.page)) || 1),
            pages,
        );
        const props: V.ListProps = {
            base: urlOf("b", t.gid, t.segs),
            entries: entries.slice((pg - 1) * PER, pg * PER),
            dirs: entries.filter((e) => e.isDir).length,
            files: entries.filter((e) => !e.isDir).length,
            sort: key,
            dir: desc ? "desc" : "asc",
            page: pg,
            pages,
        };
        if (q.partial)
            return void res.type("html").send(Render(<V.Listing {...props} />));
        return send(
            req,
            res,
            t.segs.at(-1) ?? t.loc.label,
            <V.BrowsePage crumbs={crumbs} listing={<V.Listing {...props} />} />,
        );
    }

    // a file
    const name = t.segs.at(-1)!,
        { kind } = info(name);
    if (kind === "other") return void res.redirect(urlOf("raw", t.gid, t.segs)); // can't be shown in a browser: download
    const parentSegs = t.segs.slice(0, -1);
    const parent = await F.resolveIn(t.loc, parentSegs);
    const siblings = await F.listDir(t.loc, parent.real);
    const same = siblings
        .filter((e) => !e.isDir && e.kind === kind)
        .sort((a, b) => coll.compare(a.name, b.name));
    const i = same.findIndex((e) => e.name === name);
    const nav = (e?: F.Entry) =>
        e && { name: e.name, href: urlOf("b", t.gid, [...parentSegs, e.name]) };
    const rawUrl = urlOf("raw", t.gid, t.segs);
    const props: V.ViewerProps = {
        ctx: ctxOf(req),
        crumbs,
        name,
        kind,
        rawUrl,
        size: t.st.size,
        mtime: t.st.mtimeMs,
        prev: nav(same[i - 1]),
        next: nav(same[i + 1]),
    };
    if (kind === "text") {
        const fh = await fsp.open(t.real, "r");
        try {
            const buf = Buffer.alloc(Math.min(t.st.size, 524288));
            await fh.read(buf, 0, buf.length, 0);
            props.text = {
                body: buf.toString("utf8"),
                truncated: t.st.size > 524288,
            };
        } finally {
            await fh.close();
        }
        logFile(req, res, "view", t);
    }
    if (kind === "video" || kind === "audio") {
        props.linkAction = urlOf("link", t.gid, t.segs);
        props.cfg = {
            kind,
            name,
            src: rawUrl,
            mime: info(name).mime,
            ffmpeg: M.ffmpegAvailable(),
            probeUrl: urlOf("probe", t.gid, t.segs),
            subBase: urlOf("sub", t.gid, t.segs),
            streamUrl: urlOf("stream", t.gid, t.segs),
            subs: M.findSidecars(
                name,
                siblings.map((e) => e.name),
            ).map((sc) => ({
                label: sc.label,
                lang: sc.lang,
                url: `${urlOf("sub", t.gid, t.segs)}?side=${enc(sc.file)}`,
            })),
        };
    }
    send(req, res, name, <V.ViewerPage {...props} />, 200, {
        player: kind === "video" || kind === "audio",
    });
});

// ---------- raw bytes: inline for viewable types, attachment (download) for everything else ----------
function rawAuth(req: Request, res: Response, next: NextFunction) {
    const t = s(req.query.t);
    if (!t) return requireAuth(req, res, next);
    const uid = verifyToken(t, String(P(req).gid), segsOf(req));
    const u = uid !== null ? D.getUser(uid) : undefined;
    if (!u)
        return void res.status(403).send("This link is invalid or has expired");
    req.user = u;
    res.locals.via = "link";
    next();
}

app.get("/raw/:gid{/*rel}", rawAuth, async (req, res, next) => {
    const t = await target(req);
    if (!t.st.isFile()) throw new F.NotFound();
    const name = t.segs.at(-1)!,
        { kind, mime } = info(name);
    res.set({
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-cache",
    });
    if (kind === "other") {
        res.attachment(name); // Content-Disposition: attachment -> the browser downloads it
        res.setHeader("Content-Type", "application/octet-stream");
        res.set("Content-Security-Policy", "sandbox");
    } else {
        res.setHeader(
            "Content-Type",
            mime + (kind === "text" ? "; charset=utf-8" : ""),
        );
        res.set("Content-Disposition", "inline");
        res.set(
            "Content-Security-Policy",
            kind === "pdf"
                ? "frame-ancestors 'self'"
                : kind === "video" || kind === "audio"
                  ? "default-src 'none'"
                  : "sandbox; default-src 'none'; style-src 'unsafe-inline'",
        );
    }
    logFile(req, res, kind === "other" ? "download" : "view", t);
    res.sendFile(t.real, { dotfiles: "allow", cacheControl: false }, (err) => {
        if (err && !res.headersSent) next(err);
    });
});

// ---------- shareable link (for players that can't decode a format in the browser) ----------
app.post("/link/:gid{/*rel}", requireAuth, async (req, res) => {
    const t = await target(req);
    if (!t.st.isFile()) throw new F.NotFound();
    const { token, exp } = makeToken(
        req.user!.id,
        t.gid,
        t.segs,
        Number(body(req).ttl) || 86400,
    );
    D.logAccess({
        user: req.user!,
        action: "link_created",
        via: "session",
        file: t.real,
        shown: [t.loc.label, ...t.segs].join("/"),
        ip: req.ip,
        ua: req.get("user-agent"),
    });
    res.json({
        url: `${req.protocol}://${req.get("host")}${urlOf("raw", t.gid, t.segs)}?t=${token}`,
        expires: exp * 1000,
    });
});

// ---------- media tooling: probe / subtitles / compatibility stream ----------
async function avTarget(req: Request) {
    const t = await target(req);
    const k = info(t.segs.at(-1) ?? "").kind;
    if (!t.st.isFile() || (k !== "video" && k !== "audio"))
        throw new F.NotFound();
    return t;
}

app.get("/probe/:gid{/*rel}", requireAuth, async (req, res) => {
    const t = await avTarget(req);
    if (!M.ffmpegAvailable())
        return void res
            .status(501)
            .json({ error: "ffprobe is not installed on the server" });
    try {
        res.json(await M.probe(t.real));
    } catch {
        res.status(502).json({ error: "Could not read this file's tracks" });
    }
});

app.get("/sub/:gid{/*rel}", requireAuth, async (req, res) => {
    const t = await avTarget(req),
        q = req.query,
        shift = Math.max(0, Number(q.shift) || 0);
    try {
        let vtt: Buffer | string;
        if (q.s !== undefined) {
            if (!M.ffmpegAvailable())
                return void res.status(501).send("ffmpeg is not installed");
            const idx = Number(q.s);
            const st = (await M.probe(t.real)).streams.find(
                (x) => x.index === idx && x.type === "subtitle" && x.textSub,
            );
            if (!Number.isInteger(idx) || !st)
                return void res.status(400).send("Not a text subtitle stream");
            vtt = await M.toVtt(t.real, idx, shift);
        } else {
            const sideName = s(q.side),
                ext = sideName.split(".").pop()!.toLowerCase();
            if (
                F.badSeg(sideName) ||
                !["srt", "vtt", "ass", "ssa"].includes(ext)
            )
                return void res.status(400).send("Bad subtitle");
            const sc = await F.resolveIn(t.loc, [
                ...t.segs.slice(0, -1),
                sideName,
            ]); // same access rules as any file
            if (!sc.st.isFile() || sc.st.size > 5_000_000)
                throw new F.NotFound();
            if (M.ffmpegAvailable()) vtt = await M.toVtt(sc.real, null, shift);
            else if (ext === "vtt" || ext === "srt") {
                const txt = await fsp.readFile(sc.real, "utf8");
                vtt = ext === "vtt" ? txt : M.srtToVtt(txt);
            } else
                return void res
                    .status(501)
                    .send("ffmpeg is required for this subtitle format");
        }
        res.set("Content-Type", "text/vtt; charset=utf-8").send(vtt);
    } catch (e: any) {
        if (e instanceof F.NotFound) throw e;
        res.status(502).send("Could not convert subtitle");
    }
});

app.get("/stream/:gid{/*rel}", requireAuth, async (req, res) => {
    const t = await avTarget(req),
        q = req.query;
    if (!M.ffmpegAvailable())
        return void res.status(501).send("ffmpeg is not installed");
    const start = Math.max(0, Number(q.start) || 0);
    let pi: M.ProbeInfo;
    try {
        pi = await M.probe(t.real);
    } catch {
        return void res.status(502).send("Could not read this file");
    }
    let audio: number | null = null;
    if (q.a !== undefined && q.a !== "") {
        audio = Number(q.a);
        if (!pi.streams.some((x) => x.type === "audio" && x.index === audio))
            return void res.status(400).send("No such audio track");
    }
    if (!M.acquire())
        return void res
            .status(503)
            .send("Too many active streams, try again shortly");
    if (start === 0) logFile(req, res, "stream", t);
    const v = pi.streams.find((x) => x.type === "video" && !x.attachedPic);
    const p = M.startRemux(t.real, audio, start, v?.codec === "h264");
    let released = false;
    const done = () => {
        if (!released) {
            released = true;
            M.release();
        }
    };
    p.on("exit", () => {
        done();
        res.end();
    });
    p.on("error", () => {
        done();
        if (!res.headersSent) res.status(500).end();
        else res.end();
    });
    res.on("close", () => p.kill("SIGKILL"));
    res.set({ "Content-Type": "video/mp4", "Cache-Control": "no-store" });
    p.stdout!.pipe(res);
});

// ---------- admin: users & grants ----------
app.get("/admin/users", requireAdmin, (req, res) =>
    send(
        req,
        res,
        "Users",
        <V.UsersPage ctx={ctxOf(req)} users={D.listUsers()} />,
    ),
);

app.post(
    "/admin/users",
    requireAdmin,
    act(
        () => "/admin/users",
        (req) => {
            D.createUser(
                s(body(req).username).trim(),
                s(body(req).password),
                !!body(req).is_admin,
            );
            return "User created";
        },
    ),
);

app.get("/admin/users/:id", requireAdmin, async (req, res) => {
    const u = D.getUser(Number(P(req).id));
    if (!u)
        return send(
            req,
            res,
            "Not found",
            <V.ErrorPage code={404} message="User not found" />,
            404,
        );
    const grants = await Promise.all(
        D.grantsOf(u.id).map(async (g) => ({
            id: g.id,
            ...(await F.describePath(g.path)),
        })),
    );
    const roots = (await F.realRoots()).flatMap((r, idx) =>
        r.real ? [{ idx, name: r.name }] : [],
    );
    send(
        req,
        res,
        u.username,
        <V.UserEditPage ctx={ctxOf(req)} u={u} grants={grants} roots={roots} />,
    );
});

const userUrl = (req: Request) => `/admin/users/${P(req).id}`;

app.post(
    "/admin/users/:id",
    requireAdmin,
    act(userUrl, (req) => {
        const id = Number(P(req).id),
            b = body(req);
        if (!D.getUser(id)) throw new Error("User not found");
        if (id !== req.user!.id) D.setAdmin(id, !!b.is_admin);
        if (b.new_password) D.setPassword(id, b.new_password);
        return "Saved";
    }),
);

app.post(
    "/admin/users/:id/grant",
    requireAdmin,
    act(userUrl, async (req) => {
        const real = await F.resolveRootPath(
            Number(body(req).root),
            s(body(req).path),
        );
        D.addGrant(Number(P(req).id), real);
        return "Access granted";
    }),
);

app.post(
    "/admin/users/:id/revoke",
    requireAdmin,
    act(userUrl, (req) => {
        D.removeGrant(Number(P(req).id), Number(body(req).grant_id));
        return "Access revoked";
    }),
);

app.post(
    "/admin/users/:id/delete",
    requireAdmin,
    act(
        () => "/admin/users",
        (req) => {
            const id = Number(P(req).id);
            if (id === req.user!.id)
                throw new Error("You can't delete yourself");
            D.deleteUser(id);
            return "User deleted";
        },
    ),
);

app.get("/admin/dirs", requireAdmin, async (req, res) =>
    res.json(await F.suggestDirs(Number(req.query.root), s(req.query.q))),
);

// ---------- errors ----------
app.use((req, res) =>
    send(
        req,
        res,
        "Not found",
        <V.ErrorPage code={404} message="Page not found" />,
        404,
    ),
);

app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    const nf =
        err instanceof F.NotFound ||
        err?.code === "ENOENT" ||
        err?.code === "ENOTDIR";
    if (!nf) console.error(err);
    const code = nf ? 404 : err?.code === "EACCES" ? 403 : 500;
    send(
        req,
        res,
        "Error",
        <V.ErrorPage
            code={code}
            message={
                nf
                    ? "Not found, or you don't have access"
                    : code === 403
                      ? "The server can't read this"
                      : "Something went wrong"
            }
        />,
        code,
    );
});

// ---------- start (all interfaces, like a dev server) ----------
const port = Number(process.env.PORT ?? 3000),
    host = process.env.HOST ?? "0.0.0.0";
// detect ffmpeg first so the banner and the viewer know what is available
M.detectFfmpeg().then(() =>
    app.listen(port, host, () => {
        const nets = Object.values(os.networkInterfaces())
            .flat()
            .filter(
                (n): n is os.NetworkInterfaceInfo =>
                    !!n &&
                    (n.family === "IPv4" || (n.family as unknown) === 4) &&
                    !n.internal,
            );
        const inDocker = fs.existsSync("/.dockerenv");
        console.log("\n  File Explorer is running\n");
        console.log(`  ➜  Local:    http://localhost:${port}/`);
        if (host === "0.0.0.0" || host === "::") {
            if (inDocker)
                console.log(
                    `  ➜  Network:  inside Docker; open http://<this machine's LAN IP>:` +
                        `<published port>/ (container IP: ${nets.map((n) => n.address).join(", ") || "n/a"})`,
                );
            else
                for (const n of nets)
                    console.log(`  ➜  Network:  http://${n.address}:${port}/`);
            if (!nets.length && !inDocker)
                console.log("  ➜  Network:  no LAN interface found");
        } else console.log(`  ➜  Bound to ${host} only`);
        console.log(
            `\n  Roots: ${F.ROOTS.map((r) => `${r.name}=${r.path}`).join(", ")}`,
        );
        console.log(
            `  ffmpeg/ffprobe: ${M.ffmpegAvailable() ? "available (tracks, embedded subtitles, compatibility stream)" : "not found (basic playback only)"}\n`,
        );
    }),
);
