/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IpcMainInvokeEvent } from "electron";

const DISCORD_ATTACHMENT_BASE_URL = "https://cdn.discordapp.com/attachments/";
const MAX_BYTES = 128 * 1024 * 1024;

export async function fetchDiscordAttachment(
    _: IpcMainInvokeEvent,
    pathAndQuery: string
): Promise<{ success: boolean; data?: ArrayBuffer; error?: string; }> {
    try {
        const attachmentUrl = getDiscordAttachmentUrl(pathAndQuery);
        if (!attachmentUrl) return { success: false, error: "Invalid Discord attachment path" };

        const response = await fetch(attachmentUrl);
        if (!response.ok) return { success: false, error: `Fetch failed: ${response.status} ${response.statusText}` };

        return {
            success: true,
            data: await readLimitedResponse(response)
        };
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
    }
}

async function readLimitedResponse(response: Response): Promise<ArrayBuffer> {
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_BYTES) {
        throw new Error("File is too large to preview.");
    }

    if (!response.body) {
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > MAX_BYTES) throw new Error("File is too large to preview.");
        return buffer;
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;

        totalBytes += value.byteLength;
        if (totalBytes > MAX_BYTES) {
            await reader.cancel();
            throw new Error("File is too large to preview.");
        }

        chunks.push(value);
    }

    const result = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
    }

    return result.buffer;
}

function getDiscordAttachmentUrl(pathAndQuery: string): URL | null {
    if (!isValidDiscordAttachmentPathAndQuery(pathAndQuery)) return null;

    const url = new URL(pathAndQuery, DISCORD_ATTACHMENT_BASE_URL);
    return url.origin === "https://cdn.discordapp.com" && url.pathname.startsWith("/attachments/")
        ? url
        : null;
}

function isValidDiscordAttachmentPathAndQuery(pathAndQuery: string): boolean {
    if (
        pathAndQuery.includes("\\")
        || pathAndQuery.includes("..")
        || pathAndQuery.includes("://")
        || pathAndQuery.startsWith("/")
        || pathAndQuery.startsWith("//")
    ) {
        return false;
    }

    const path = pathAndQuery.split("?", 1)[0];
    const parts = path.split("/");

    return parts.length >= 3
        && /^\d+$/.test(parts[0])
        && /^\d+$/.test(parts[1])
        && parts.slice(2).every(part => part.length > 0);
}
