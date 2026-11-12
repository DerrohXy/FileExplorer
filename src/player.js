(function () {
    var cfgEl = document.getElementById("player-cfg");
    if (!cfgEl || !window.videojs) return;
    var cfg = JSON.parse(cfgEl.textContent);
    var $ = function (id) {
        return document.getElementById(id);
    };

    var player = videojs("player", {
        controls: true,
        preload: "metadata",
        fluid: cfg.kind === "video",
        playbackRates: [0.5, 0.75, 1, 1.25, 1.5, 2],
        html5: { nativeTextTracks: false }, // use video.js' own subtitle rendering + CC menu
    });

    // mode.remux: playing the server's compatibility stream (chosen audio track / unsupported container)
    var mode = { remux: false, audio: null, start: 0 };
    var info = null,
        triedCompat = false;

    function el(tag, text, cls) {
        var e = document.createElement(tag);
        if (text) e.textContent = text;
        if (cls) e.className = cls;
        return e;
    }

    function notice(msg) {
        var n = $("notice");
        n.textContent = msg || "";
        n.classList.toggle("d-none", !msg);
    }

    function absTime() {
        return (mode.remux ? mode.start : 0) + (player.currentTime() || 0);
    }

    function fmt(t) {
        t = Math.floor(t);
        var h = Math.floor(t / 3600),
            m = Math.floor((t % 3600) / 60),
            s = t % 60;
        return (
            (h ? h + ":" + String(m).padStart(2, "0") : m) +
            ":" +
            String(s).padStart(2, "0")
        );
    }

    function label(st) {
        return (
            [st.lang && st.lang.toUpperCase(), st.title, st.codec]
                .filter(Boolean)
                .join(" · ") || "Track " + st.index
        );
    }

    // ---- subtitles (sidecar files + embedded text streams) as video.js text tracks ----
    function shiftQ() {
        return mode.remux && mode.start > 0
            ? "&shift=" + Math.floor(mode.start)
            : "";
    }

    function addSub(name, lang, url) {
        player.addRemoteTextTrack(
            {
                kind: "subtitles",
                label: name,
                srclang: lang || "und",
                src: url,
            },
            false,
        );
    }

    function reloadSubs() {
        var t = player.remoteTextTracks();
        for (var i = t.length - 1; i >= 0; i--)
            player.removeRemoteTextTrack(t[i]);
        cfg.subs.forEach(function (sc) {
            addSub(sc.label + " (file)", sc.lang, sc.url + shiftQ());
        });
        if (info)
            info.streams.forEach(function (st) {
                if (st.type === "subtitle" && st.textSub)
                    addSub(
                        label(st),
                        st.lang,
                        cfg.subBase + "?s=" + st.index + shiftQ(),
                    );
            });
    }

    // ---- source handling ----
    function source() {
        if (!mode.remux) return { src: cfg.src, type: cfg.mime };
        return {
            src:
                cfg.streamUrl +
                "?start=" +
                Math.floor(mode.start) +
                (mode.audio !== null ? "&a=" + mode.audio : ""),
            type: "video/mp4",
        };
    }

    function load(play) {
        player.src(source());
        reloadSubs();
        renderPanel();
        toggleSeek();
        if (play) {
            var p = player.play();
            if (p && p.catch) p.catch(function () {});
        }
    }

    function enterRemux(audioIdx) {
        var t = absTime(),
            playing = !player.paused();
        mode = { remux: true, audio: audioIdx, start: t };
        load(playing);
    }

    function useOriginal() {
        var t = absTime(),
            playing = !player.paused();
        mode = { remux: false, audio: null, start: 0 };
        load(false);
        player.one("loadedmetadata", function () {
            player.currentTime(t);
            if (playing) player.play();
        });
    }

    // seek slider for the compatibility stream (a live-style stream has no native seek bar)
    function toggleSeek() {
        var dur = info && info.duration,
            box = $("remux-seek");
        box.classList.toggle("d-none", !(mode.remux && dur));
        if (dur) $("remux-range").max = Math.floor(dur);
    }
    $("remux-range").addEventListener("change", function () {
        mode.start = Number(this.value);
        load(true);
    });

    player.on("timeupdate", function () {
        if (!mode.remux) return;
        var r = $("remux-range"),
            t = absTime();
        if (document.activeElement !== r) r.value = Math.floor(t);
        $("remux-time").textContent =
            fmt(t) + (info && info.duration ? " / " + fmt(info.duration) : "");
    });

    // ---- tracks panel ----
    function currentAudio() {
        if (!info) return null;
        var a = info.streams.filter(function (s) {
            return s.type === "audio";
        });
        if (mode.remux)
            return mode.audio !== null ? mode.audio : a[0] && a[0].index;
        var d =
            a.filter(function (s) {
                return s.default;
            })[0] || a[0];
        return d && d.index;
    }

    function renderPanel() {
        var box = $("tracks");
        box.textContent = "";
        if (!info) return;
        if (info.title || info.artist || info.album) {
            var m = el(
                "div",
                [info.title, info.artist, info.album]
                    .filter(Boolean)
                    .join(" — "),
                "mb-2 text-body-secondary",
            );
            box.appendChild(m);
        }
        box.appendChild(
            el(
                "div",
                mode.remux
                    ? "Playing: server compatibility stream"
                    : "Playing: original file",
                "mb-2",
            ),
        );
        var groups = [
            ["Video", "video"],
            ["Audio", "audio"],
            ["Subtitles", "subtitle"],
        ];
        groups.forEach(function (g) {
            var list = info.streams.filter(function (s) {
                return s.type === g[1] && !s.attachedPic;
            });
            if (!list.length) return;
            box.appendChild(el("h6", g[0] + " (" + list.length + ")"));
            var ul = el("ul");
            list.forEach(function (st) {
                var li = el("li");
                if (g[1] === "audio") {
                    var cur = st.index === currentAudio();
                    var b = el(
                        "button",
                        (cur ? "● " : "○ ") +
                            label(st) +
                            (st.detail ? " · " + st.detail : ""),
                        "btn btn-link btn-sm p-0 text-start" +
                            (cur ? " cur" : ""),
                    );
                    b.type = "button";
                    b.title = cur ? "Playing" : "Switch to this audio track";
                    b.addEventListener("click", function () {
                        if (!cur) enterRemux(st.index);
                    });
                    li.appendChild(b);
                } else if (g[1] === "subtitle") {
                    li.textContent =
                        label(st) +
                        (st.textSub ? "" : " (image-based, not supported)");
                    if (st.textSub)
                        li.appendChild(
                            el(
                                "span",
                                " — use the CC menu",
                                "text-body-secondary",
                            ),
                        );
                } else
                    li.textContent =
                        label(st) + (st.detail ? " · " + st.detail : "");
                ul.appendChild(li);
            });
            box.appendChild(ul);
        });
        if (cfg.subs.length) {
            box.appendChild(
                el("h6", "Subtitle files (" + cfg.subs.length + ")"),
            );
            var ul2 = el("ul");
            cfg.subs.forEach(function (sc) {
                ul2.appendChild(el("li", sc.file || sc.label));
            });
            box.appendChild(ul2);
        }
        var aud = info.streams.filter(function (s) {
            return s.type === "audio";
        });
        if (aud.length > 1)
            box.appendChild(
                el(
                    "div",
                    "Switching audio plays a server-converted stream from the current position.",
                    "mt-2 text-body-secondary",
                ),
            );
        if (mode.remux) {
            var back = el(
                "button",
                "Back to original file",
                "btn btn-sm btn-outline-secondary mt-2",
            );
            back.type = "button";
            back.addEventListener("click", useOriginal);
            box.appendChild(back);
        }
    }

    // ---- playback failures: unsupported format/container -> server stream, else suggest an external player ----
    player.on("error", function () {
        if (!player.error()) return;
        if (!mode.remux && cfg.ffmpeg && !triedCompat) {
            triedCompat = true;
            notice(
                "Your browser can’t play this format directly, so the server is converting it on the fly (use the seek slider below the player).",
            );
            player.error(null);
            enterRemux(null);
        } else {
            notice(
                "This browser can’t play this file. Use “Copy link” below to open it in an external player such as VLC or mpv.",
            );
        }
    });

    // ---- initial load ----
    player.src(source());
    reloadSubs();

    fetch(cfg.probeUrl, { credentials: "same-origin" })
        .then(function (r) {
            if (!r.ok) throw new Error(r.status);
            return r.json();
        })
        .then(function (j) {
            info = j;
            reloadSubs();
            renderPanel();
            toggleSeek();
        })
        .catch(function (e) {
            $("tracks").textContent =
                String(e.message) === "501"
                    ? "Track details need ffmpeg/ffprobe on the server."
                    : "Track details unavailable.";
        });
})();
