/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { makeLazy } from "@utils/lazy";
import { PluginNative } from "@utils/types";

const Native = VencordNative?.pluginHelpers?.EmbedMoreImages as PluginNative<typeof import("./native")> | undefined;

interface HeifImage {
    get_width(): number;
    get_height(): number;
    display(target: ImageData, callback: (result: ImageData | null) => void): void;
    free(): void;
}

interface LibHeif {
    HeifDecoder: new () => {
        decode(data: ArrayBuffer): HeifImage[];
    };
}

const getLibHeif = makeLazy(async () => {
    // @ts-expect-error remote module has no types
    const factory = await import("https://cdn.jsdelivr.net/npm/libheif-js@1.19.8/libheif-wasm/libheif-bundle.mjs");
    return await factory.default() as LibHeif;
});

const objectUrls = new Map<string, string>();
const inFlight = new Map<string, Promise<string>>();
export const failedUrls = new Map<string, string>();
const controllers = new Set<AbortController>();
let queue: Promise<unknown> = Promise.resolve();

export function getDecoded(url: string) {
    return objectUrls.get(url);
}

export function decodeHeic(url: string): Promise<string> {
    const cached = objectUrls.get(url);
    if (cached) return Promise.resolve(cached);

    const pending = inFlight.get(url);
    if (pending) return pending;

    queue = queue.catch(() => { }).then(() => doDecode(url));
    const promise = (queue as Promise<string>)
        .then(objectUrl => {
            objectUrls.set(url, objectUrl);
            return objectUrl;
        })
        .catch(error => {
            failedUrls.set(url, error instanceof Error ? error.message : String(error));
            throw error;
        })
        .finally(() => inFlight.delete(url));

    inFlight.set(url, promise);
    return promise;
}

async function doDecode(url: string): Promise<string> {
    const libheif = await getLibHeif();
    const blob = await fetchAttachment(url);
    const [image] = new libheif.HeifDecoder().decode(await blob.arrayBuffer());
    if (!image) throw new Error("No image found in HEIF file");

    try {
        const width = image.get_width();
        const height = image.get_height();
        const imageData = await new Promise<ImageData>((resolve, reject) => {
            image.display(new ImageData(width, height), result => {
                if (result) resolve(result);
                else reject(new Error("Failed to decode HEIF image"));
            });
        });

        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Could not create canvas context");
        ctx.putImageData(imageData, 0, 0);

        return URL.createObjectURL(await canvas.convertToBlob({ type: "image/webp", quality: 0.9 }));
    } finally {
        image.free();
    }
}

async function fetchAttachment(url: string): Promise<Blob> {
    const attachmentPath = getDiscordAttachmentPath(url);
    if (Native && attachmentPath) {
        const res = await Native.fetchDiscordAttachment(attachmentPath);
        if (!res.success || !res.data) throw new Error(res.error ?? "Failed to fetch attachment");
        return new Blob([res.data]);
    }

    const controller = new AbortController();
    controllers.add(controller);
    try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`Failed to fetch attachment (${res.status})`);
        return res.blob();
    } finally {
        controllers.delete(controller);
    }
}

function getDiscordAttachmentPath(url: string): string | null {
    try {
        const parsedUrl = new URL(url);
        if (parsedUrl.protocol !== "https:") return null;
        if (parsedUrl.hostname !== "cdn.discordapp.com") return null;
        if (!parsedUrl.pathname.startsWith("/attachments/")) return null;

        return `${parsedUrl.pathname.slice("/attachments/".length)}${parsedUrl.search}`;
    } catch {
        return null;
    }
}

export function clearDecodeCache() {
    for (const controller of controllers) controller.abort();
    controllers.clear();
    for (const objectUrl of objectUrls.values()) URL.revokeObjectURL(objectUrl);
    objectUrls.clear();
    inFlight.clear();
    failedUrls.clear();
}
