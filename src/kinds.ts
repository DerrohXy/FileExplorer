export type Kind =
    | "dir"
    | "video"
    | "audio"
    | "image"
    | "pdf"
    | "text"
    | "other";

const T: Record<string, [Kind, string]> = {};
const add = (kind: Kind, items: Record<string, string>) => {
    for (const [e, m] of Object.entries(items)) T[e] = [kind, m];
};

add("video", {
    mp4: "video/mp4",
    m4v: "video/mp4",
    webm: "video/webm",
    ogv: "video/ogg",
    mov: "video/quicktime",
    mkv: "video/x-matroska",
    avi: "video/x-msvideo",
    wmv: "video/x-ms-wmv",
    flv: "video/x-flv",
    ts: "video/mp2t",
    mpg: "video/mpeg",
    mpeg: "video/mpeg",
    "3gp": "video/3gpp",
});

add("audio", {
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    aac: "audio/aac",
    wav: "audio/wav",
    flac: "audio/flac",
    ogg: "audio/ogg",
    oga: "audio/ogg",
    opus: "audio/ogg",
    weba: "audio/webm",
    wma: "audio/x-ms-wma",
});

add("image", {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    bmp: "image/bmp",
    svg: "image/svg+xml",
    ico: "image/x-icon",
});

add("pdf", { pdf: "application/pdf" });

add("text", {
    txt: "text/plain",
    md: "text/plain",
    log: "text/plain",
    json: "text/plain",
    csv: "text/plain",
    nfo: "text/plain",
    srt: "text/plain",
    vtt: "text/plain",
    yml: "text/plain",
    yaml: "text/plain",
    ini: "text/plain",
    xml: "text/plain",
});

export const extOf = (name: string) =>
    name.includes(".")
        ? name.slice(name.lastIndexOf(".") + 1).toLowerCase()
        : "";

/** Files with an unknown extension are "other": listed, but never served. */
export function info(name: string): { kind: Kind; mime: string } {
    const t = T[extOf(name)];
    return t
        ? { kind: t[0], mime: t[1] }
        : { kind: "other", mime: "application/octet-stream" };
}
