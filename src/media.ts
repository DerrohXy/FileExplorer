import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);

export const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
let available = false;

export const ffmpegAvailable = () => available;

export async function detectFfmpeg() {
    try {
        await run(FFPROBE, ["-version"]);
        await run(FFMPEG, ["-version"]);
        available = true;
    } catch {
        available = false;
    }
    return available;
}

// limit concurrent ffmpeg jobs
let active = 0;
const MAX = Number(process.env.MAX_FFMPEG || 3);

export const acquire = () => (active < MAX ? (active++, true) : false);
export const release = () => {
    active = Math.max(0, active - 1);
};

export interface Stream {
    index: number;
    type: "video" | "audio" | "subtitle";
    codec: string;
    lang: string;
    title: string;
    default: boolean;
    detail: string;
    textSub: boolean;
    attachedPic: boolean;
}
export interface ProbeInfo {
    duration: number | null;
    format: string;
    title?: string;
    artist?: string;
    album?: string;
    streams: Stream[];
}

const TEXT_SUBS = new Set([
    "subrip",
    "srt",
    "ass",
    "ssa",
    "webvtt",
    "mov_text",
    "text",
    "subviewer",
]);

export async function probe(file: string): Promise<ProbeInfo> {
    const { stdout } = await run(
        FFPROBE,
        [
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_streams",
            "-show_format",
            file,
        ],
        { timeout: 20_000, maxBuffer: 8e6 },
    );
    const j = JSON.parse(stdout);
    const streams: Stream[] = (j.streams ?? []).flatMap((s: any): Stream[] => {
        const type =
            s.codec_type === "subtitle"
                ? "subtitle"
                : s.codec_type === "audio"
                  ? "audio"
                  : s.codec_type === "video"
                    ? "video"
                    : null;
        if (!type) return [];
        const fps =
            s.avg_frame_rate && s.avg_frame_rate !== "0/0"
                ? (() => {
                      const [a, b] = s.avg_frame_rate.split("/").map(Number);
                      return b ? Math.round((a / b) * 100) / 100 : 0;
                  })()
                : 0;
        const detail =
            type === "video"
                ? [
                      s.width && `${s.width}x${s.height}`,
                      fps && `${fps} fps`,
                      s.profile,
                  ]
                      .filter(Boolean)
                      .join(" · ")
                : type === "audio"
                  ? [
                        s.channel_layout || (s.channels && `${s.channels} ch`),
                        s.sample_rate && `${s.sample_rate} Hz`,
                    ]
                        .filter(Boolean)
                        .join(" · ")
                  : "";
        return [
            {
                index: s.index,
                type,
                codec: s.codec_name ?? "?",
                lang: s.tags?.language ?? "",
                title: s.tags?.title ?? "",
                default: !!s.disposition?.default,
                detail,
                textSub: type === "subtitle" && TEXT_SUBS.has(s.codec_name),
                attachedPic: !!s.disposition?.attached_pic,
            },
        ];
    });
    const t = j.format?.tags ?? {};
    const pick = (k: string) => t[k] ?? t[k.toUpperCase()];
    return {
        duration: j.format?.duration ? Number(j.format.duration) : null,
        format: j.format?.format_long_name ?? "",
        title: pick("title"),
        artist: pick("artist"),
        album: pick("album"),
        streams,
    };
}

/** Convert a subtitle (embedded stream index, or the first stream of a sidecar file) to WebVTT. */
export async function toVtt(
    file: string,
    streamIndex: number | null,
    shift: number,
): Promise<Buffer> {
    const args = [
        "-nostdin",
        "-v",
        "error",
        ...(shift > 0 ? ["-ss", String(shift)] : []),
        "-i",
        file,
        "-map",
        streamIndex === null ? "0:s:0" : `0:${streamIndex}`,
        "-f",
        "webvtt",
        "pipe:1",
    ];
    const { stdout } = await run(FFMPEG, args, {
        encoding: "buffer",
        timeout: 120_000,
        maxBuffer: 20e6,
    });
    return stdout as unknown as Buffer;
}

export const srtToVtt = (t: string) =>
    "WEBVTT\n\n" +
    t
        .replace(/^\uFEFF/, "")
        .replace(/\r\n?/g, "\n")
        .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");

/** Fragmented-MP4 stream with a chosen audio track.
 * Video is copied when already H.264, otherwise re-encoded. */
export function startRemux(
    file: string,
    audioIndex: number | null,
    start: number,
    copyVideo: boolean,
): ChildProcess {
    const args = [
        "-nostdin",
        "-v",
        "error",
        ...(start > 0 ? ["-ss", String(start)] : []),
        "-i",
        file,
        "-map",
        "0:v:0?",
        "-map",
        audioIndex === null ? "0:a:0?" : `0:${audioIndex}`,
        "-sn",
        "-dn",
        "-c:v",
        ...(copyVideo
            ? ["copy"]
            : [
                  "libx264",
                  "-preset",
                  "veryfast",
                  "-crf",
                  "23",
                  "-pix_fmt",
                  "yuv420p",
              ]),
        "-c:a",
        "aac",
        "-ac",
        "2",
        "-b:a",
        "192k",
        "-movflags",
        "frag_keyframe+empty_moov+default_base_moof",
        "-f",
        "mp4",
        "pipe:1",
    ];
    return spawn(FFMPEG, args, { stdio: ["ignore", "pipe", "ignore"] });
}

export interface Sidecar {
    file: string;
    label: string;
    lang: string;
}

/** Subtitle files next to a video: "Movie.srt", "Movie.en.srt", "Movie.fr.forced.vtt" ... */
export function findSidecars(videoName: string, names: string[]): Sidecar[] {
    const stem = videoName.replace(/\.[^.]+$/, "");
    return names
        .filter(
            (n) =>
                /\.(srt|vtt|ass|ssa)$/i.test(n) &&
                n.toLowerCase().startsWith(stem.toLowerCase() + "."),
        )
        .map((n) => {
            const mid = n.slice(stem.length + 1).replace(/\.[^.]+$/, "");
            const lang = /^[a-z]{2,3}(-[A-Za-z]+)?$/.test(mid.split(".")[0])
                ? mid.split(".")[0]
                : "";
            return { file: n, label: mid || "Subtitles", lang };
        });
}
