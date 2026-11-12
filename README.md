# File Explorer

Read-only web file & media explorer: Express + TypeScript, rendered with `swiftssr`, SQLite for users, grants and the audit log.
Video/audio play with video.js (self-hosted, so it works offline on a LAN).

## Run
```bash
cp .env.example .env      # set MEDIA_ROOTS, ROOT_USERNAME, ROOT_PASSWORD
npm install
npm run dev               # or: npm run build && npm start   (Node >= 20.6)
```
On start it prints the Local and **Network** (LAN) URLs, vite-style. It listens on all interfaces (`HOST=0.0.0.0`);
set `HOST=127.0.0.1` to restrict it to the machine.

## Access model
- `MEDIA_ROOTS` lists the only directories that can ever be exposed (`Label=/path,Label2=/path2`).
- Admins see every root and manage users. Grants are **directories**: a granted folder includes everything below it.
- A user's home page shows only their top-most granted folders; they browse from there and nothing above is visible.
- Grants are checked on every request and nothing is cached: revoke a grant and the whole subtree disappears at once;
  files added/removed on disk show up within seconds (the listing live-refreshes).
- Symlinks are followed only while they stay inside the granted folder; ones leaving it are invisible and blocked.
  Dotfiles are hidden and unreachable. `..` and path tricks resolve to 404.
- No upload/delete/rename/copy actions exist. Browser-viewable types (images, PDF, text, audio, video) open inline;
  every other file type is sent as a download.

## Players, tracks and unsupported formats
- With **ffmpeg/ffprobe** installed, the Tracks panel lists all video/audio/subtitle streams, embedded text subtitles
  (and sidecar `Name.en.srt/.vtt/.ass`) appear in the CC menu, and **audio tracks** can be switched. Audio switching and
  formats the browser can't decode (HEVC/AVI/some MKV) play through a server-side converted stream (H.264 is copied, otherwise
  re-encoded; seeking uses a slider; image-based subtitles are not supported). Without ffmpeg, basic playback and sidecar
  `.srt/.vtt` subtitles still work.
- **Copy link** (viewer page) makes `/raw/<id>/<path>?t=<user>.<expiry>.<signature>` for VLC/mpv etc. The signature binds it to
  one user, one file and an expiry (1 h - 30 d). It still obeys the user's *current* access, so revoking the grant or deleting
  the user kills the link. Anyone holding the link can open that one file until it expires, and over plain `http` it is visible
  on the network, so use HTTPS beyond a trusted LAN. Changing `LINK_SECRET` invalidates every link.

## Activity log
Every file view, download, compatibility stream and link creation/use is stored in `access_log` (user, action, session/link,
path, IP, user agent). Admins: **Activity** (all, or per user). Users: **My activity** on the account page. Player range
requests and bursts collapse into one entry per user/file/action per 30 s. Rows are kept when a user is deleted.

## Docker
```bash
cp .env.example .env      # set ROOT_USERNAME / ROOT_PASSWORD, MOVIES_DIR / MUSIC_DIR (host paths), MEDIA_ROOTS
docker compose up -d --build
```
Media is mounted read-only; state lives in the `file-explorer-data` volume. Other devices use `http://<host-LAN-IP>:3000`
(inside a container the banner can only show the container's IP). Use `--build-arg WITH_FFMPEG=0` to skip ffmpeg.
