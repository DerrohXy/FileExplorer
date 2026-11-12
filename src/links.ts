import crypto from "node:crypto";
import { linkSecret } from "./db";

/**
 * Shareable resource links: /raw/<gid>/<path>?t=<userId>.<expiry>.<signature>
 * The signature binds user + expiry + exact resource,
 * so a link opens only that one file, only until it expires,
 * and only while that user still has access to it (grants are re-checked on every request).
 */
const sig = (userId: number, exp: number, gid: string, rel: string) =>
    crypto
        .createHmac("sha256", linkSecret())
        .update(`${userId}|${exp}|${gid}|${rel}`)
        .digest("base64url");

export function makeToken(
    userId: number,
    gid: string,
    segs: string[],
    ttlSec: number,
) {
    const exp =
        Math.floor(Date.now() / 1000) +
        Math.min(Math.max(ttlSec, 60), 30 * 86400);

    return {
        token: `${userId}.${exp}.${sig(userId, exp, gid, segs.join("/"))}`,
        exp,
    };
}

/** Returns the user id the token was issued to, or null if invalid/expired/for another resource. */
export function verifyToken(
    token: string,
    gid: string,
    segs: string[],
): number | null {
    const [u, e, s] = token.split(".");
    const userId = Number(u),
        exp = Number(e);
    if (
        !Number.isInteger(userId) ||
        !Number.isInteger(exp) ||
        !s ||
        exp < Date.now() / 1000
    )
        return null;
    const want = Buffer.from(sig(userId, exp, gid, segs.join("/"))),
        got = Buffer.from(s);
    return want.length === got.length && crypto.timingSafeEqual(want, got)
        ? userId
        : null;
}
