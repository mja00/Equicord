/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { EquicordDevs } from "@utils/constants";
import { classNameFactory } from "@utils/css";
import { openImageModal } from "@utils/discord";
import { parseUrl } from "@utils/misc";
import definePlugin, { OptionType } from "@utils/types";
import { MaskedLink, useEffect, useState } from "@webpack/common";

import { clearDecodeCache, decodeHeic, failedUrls, getDecoded } from "./decoder";
import managedStyle from "./style.css?managed";

const cl = classNameFactory("vc-emi-");

const NATIVE_EXTENSIONS = new Set(["bmp", "ico", "cur", "jfif", "jif", "jfi", "jpe", "apng"]);
const HEIC_EXTENSIONS = new Set(["heic", "heif"]);
const ATTACHMENT_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

const settings = definePluginSettings({
    nativeFormats: {
        type: OptionType.BOOLEAN,
        description: "Embed formats your browser can display but Discord doesn't preview, like bmp, ico and jfif.",
        default: true,
        restartNeeded: true
    },
    heicFormats: {
        type: OptionType.BOOLEAN,
        description: "Decode and embed HEIC and HEIF photos. The decoder is downloaded on first use.",
        default: true,
        restartNeeded: true,
        target: "DESKTOP"
    },
    autoDecodeLimit: {
        type: OptionType.SLIDER,
        description: "Largest HEIC file in MB to decode automatically. Bigger files need a click to load. 0 means always click to load.",
        markers: [0, 4, 8, 16, 32, 64, 128],
        default: 32,
        stickToMarkers: false
    }
});

interface AttachmentProps {
    fileName?: string;
    fileSize?: number;
    url?: string;
    item?: {
        downloadUrl?: string;
        originalItem?: {
            filename?: string;
            size?: number;
            url?: string;
        };
    };
}

interface InlineImageProps {
    fileName: string;
    url: string;
    size: number;
    mode: "native" | "heic";
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function InlineImage({ fileName, url, size, mode }: InlineImageProps) {
    const isSpoiler = fileName.startsWith("SPOILER_");
    const [revealed, setRevealed] = useState(!isSpoiler);

    const capBytes = settings.store.autoDecodeLimit * 1024 * 1024;
    const autoDecode = capBytes > 0 && size <= capBytes;
    const initialSrc = mode === "native" ? url : getDecoded(url);
    const [src, setSrc] = useState(initialSrc);
    const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">(
        initialSrc ? "done" : autoDecode ? "loading" : "idle"
    );

    useEffect(() => {
        if (!revealed || status !== "loading" || src) return;
        let cancelled = false;
        decodeHeic(url).then(
            objectUrl => {
                if (cancelled) return;
                setSrc(objectUrl);
                setStatus("done");
            },
            () => {
                if (!cancelled) setStatus("error");
            }
        );
        return () => {
            cancelled = true;
        };
    }, [revealed, status]);

    if (!revealed) {
        return (
            <div className={cl("placeholder", "clickable")} onClick={() => setRevealed(true)}>
                <span className={cl("spoiler-pill")}>Spoiler</span>
                <span className={cl("name")}>{fileName}</span>
            </div>
        );
    }

    if (status === "idle") {
        return (
            <div className={cl("placeholder", "clickable")} onClick={() => setStatus("loading")}>
                <span className={cl("name")}>{fileName}</span>
                <span className={cl("hint")}>{formatBytes(size)} · Click to load preview</span>
            </div>
        );
    }

    if (status === "loading") {
        return (
            <div className={cl("placeholder")}>
                <span className={cl("name")}>{fileName}</span>
                <span className={cl("hint")}>Decoding…</span>
            </div>
        );
    }

    if (status === "error") {
        return (
            <div className={cl("error")}>
                Couldn't preview <MaskedLink href={url}>{fileName}</MaskedLink>
            </div>
        );
    }

    return (
        <img
            className={cl("image")}
            src={src}
            alt={fileName}
            onClick={e => openImageModal({
                url: `${e.currentTarget.src}#`,
                width: e.currentTarget.naturalWidth,
                height: e.currentTarget.naturalHeight
            })}
            onError={() => setStatus("error")}
        />
    );
}

const SafeInlineImage = ErrorBoundary.wrap(InlineImage, { noop: true });

export default definePlugin({
    name: "EmbedMoreImages",
    description: "Embeds image formats Discord won't preview, like HEIC, BMP and ICO, directly in chat.",
    authors: [EquicordDevs.mart],
    tags: ["Media", "Chat"],
    searchTerms: ["heic", "heif", "bmp", "ico", "jfif", "embed"],
    managedStyle,
    settings,

    patches: [
        {
            find: "#{intl::IMG_ALT_ATTACHMENT_FILE_TYPE}",
            replacement: {
                match: /(?=(?:let|var|const)\{[^}]{0,300}renderAdjacentContent:\i\}=(\i);)/,
                replace: "const vcEmiPreview=$self.renderInlineImage($1);if(vcEmiPreview)return vcEmiPreview;"
            }
        }
    ],

    stop() {
        clearDecodeCache();
    },

    renderInlineImage(props: AttachmentProps) {
        const fileName = props.fileName ?? props.item?.originalItem?.filename;
        const url = props.url ?? props.item?.downloadUrl ?? props.item?.originalItem?.url;
        if (!fileName || !url || failedUrls.has(url)) return null;

        const host = parseUrl(url)?.hostname;
        if (!host || !ATTACHMENT_HOSTS.has(host)) return null;

        const extension = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase();
        if (!extension) return null;

        let mode: InlineImageProps["mode"];
        if (HEIC_EXTENSIONS.has(extension)) {
            if (IS_WEB || !settings.store.heicFormats) return null;
            mode = "heic";
        } else if (NATIVE_EXTENSIONS.has(extension)) {
            if (!settings.store.nativeFormats) return null;
            mode = "native";
        } else {
            return null;
        }

        const size = props.fileSize ?? props.item?.originalItem?.size ?? 0;
        return <SafeInlineImage fileName={fileName} url={url} size={size} mode={mode} />;
    }
});
