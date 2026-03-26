/**
 * Self-hosted storage backend for Excalidraw.
 *
 * Replaces Firebase Firestore + Storage with HTTP calls to
 * excalidraw-storage-backend (alswl/excalidraw-storage-backend).
 *
 * API routes used:
 *   PUT  /rooms/:id   — save room scene (binary)
 *   GET  /rooms/:id   — load room scene (binary)
 *   PUT  /files/:id   — save file (binary)
 *   GET  /files/:id   — load file (binary)
 *
 * The file is named firebase.ts to avoid changing every import across
 * the codebase — all exports maintain the same signatures.
 */

import { reconcileElements } from "@excalidraw/excalidraw";
import { MIME_TYPES, toBrandedType } from "@excalidraw/common";
import { decompressData } from "@excalidraw/excalidraw/data/encode";
import {
  encryptData,
  decryptData,
} from "@excalidraw/excalidraw/data/encryption";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";
import { getSceneVersion } from "@excalidraw/element";

import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import type {
  ExcalidrawElement,
  FileId,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFileMetadata,
  DataURL,
} from "@excalidraw/excalidraw/types";

import { getSyncableElements } from ".";

import type { SyncableExcalidrawElement } from ".";
import type Portal from "../collab/Portal";
import type { Socket } from "socket.io-client";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const HTTP_STORAGE_BACKEND_URL =
  import.meta.env.VITE_APP_HTTP_STORAGE_BACKEND_URL;

// ---------------------------------------------------------------------------
// Encryption helpers (unchanged from original)
// ---------------------------------------------------------------------------

const encryptElements = async (
  key: string,
  elements: readonly ExcalidrawElement[],
): Promise<{ ciphertext: ArrayBuffer; iv: Uint8Array }> => {
  const json = JSON.stringify(elements);
  const encoded = new TextEncoder().encode(json);
  const { encryptedBuffer, iv } = await encryptData(key, encoded);
  return { ciphertext: encryptedBuffer, iv };
};

/**
 * Stored format: [4-byte IV length][IV bytes][ciphertext bytes]
 * This is a simple binary envelope so we can store everything in a single
 * opaque blob on the HTTP storage backend (which only does key→bytes).
 */
const packSceneBlob = (
  sceneVersion: number,
  iv: Uint8Array,
  ciphertext: ArrayBuffer,
): Uint8Array => {
  // Header: 4 bytes sceneVersion (uint32) + 4 bytes IV length (uint32)
  const header = new ArrayBuffer(8);
  const view = new DataView(header);
  view.setUint32(0, sceneVersion);
  view.setUint32(4, iv.byteLength);

  const result = new Uint8Array(
    header.byteLength + iv.byteLength + ciphertext.byteLength,
  );
  result.set(new Uint8Array(header), 0);
  result.set(iv, 8);
  result.set(new Uint8Array(ciphertext), 8 + iv.byteLength);
  return result;
};

const unpackSceneBlob = (
  buffer: ArrayBuffer,
): { sceneVersion: number; iv: Uint8Array; ciphertext: Uint8Array } => {
  const view = new DataView(buffer);
  const sceneVersion = view.getUint32(0);
  const ivLength = view.getUint32(4);
  const iv = new Uint8Array(buffer, 8, ivLength);
  const ciphertext = new Uint8Array(buffer, 8 + ivLength);
  return { sceneVersion, iv, ciphertext };
};

const decryptElements = async (
  iv: Uint8Array,
  ciphertext: Uint8Array,
  roomKey: string,
): Promise<readonly ExcalidrawElement[]> => {
  const decrypted = await decryptData(
    iv as Uint8Array<ArrayBuffer>,
    ciphertext as Uint8Array<ArrayBuffer>,
    roomKey,
  );
  const decodedData = new TextDecoder("utf-8").decode(
    new Uint8Array(decrypted),
  );
  return JSON.parse(decodedData);
};

// ---------------------------------------------------------------------------
// Scene version cache (unchanged logic from original)
// ---------------------------------------------------------------------------

class SceneVersionCache {
  private static cache = new WeakMap<Socket, number>();
  static get = (socket: Socket) => SceneVersionCache.cache.get(socket);
  static set = (
    socket: Socket,
    elements: readonly SyncableExcalidrawElement[],
  ) => {
    SceneVersionCache.cache.set(socket, getSceneVersion(elements));
  };
}

// ---------------------------------------------------------------------------
// Public API — same signatures as original firebase.ts
// ---------------------------------------------------------------------------

/** @deprecated — only kept for ExportToExcalidrawPlus compat. Returns null. */
export const loadFirebaseStorage = async () => {
  return null;
};

export const isSavedToFirebase = (
  portal: Portal,
  elements: readonly ExcalidrawElement[],
): boolean => {
  if (portal.socket && portal.roomId && portal.roomKey) {
    const sceneVersion = getSceneVersion(elements);
    return SceneVersionCache.get(portal.socket) === sceneVersion;
  }
  return true;
};

// ---------------------------------------------------------------------------
// saveFilesToFirebase → HTTP PUT /files/:id
// ---------------------------------------------------------------------------

export const saveFilesToFirebase = async ({
  prefix,
  files,
}: {
  prefix: string;
  files: { id: FileId; buffer: Uint8Array }[];
}) => {
  const erroredFiles: FileId[] = [];
  const savedFiles: FileId[] = [];

  await Promise.all(
    files.map(async ({ id, buffer }) => {
      try {
        // Flatten the prefix + id into a single key (no slashes)
        // e.g. prefix="/files/rooms/abc" + id="xyz" → "files__rooms__abc__xyz"
        const storageKey = `${prefix}/${id}`
          .replace(/^\//, "")
          .replace(/\//g, "__");
        const response = await fetch(
          `${HTTP_STORAGE_BACKEND_URL}/files/${storageKey}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/octet-stream" },
            body: new Blob([buffer] as BlobPart[]),
          },
        );
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        savedFiles.push(id);
      } catch (error: any) {
        erroredFiles.push(id);
        console.error(`Failed to save file ${id}:`, error);
      }
    }),
  );

  return { savedFiles, erroredFiles };
};

// ---------------------------------------------------------------------------
// saveToFirebase → HTTP PUT /rooms/:roomId
// ---------------------------------------------------------------------------

export const saveToFirebase = async (
  portal: Portal,
  elements: readonly SyncableExcalidrawElement[],
  appState: AppState,
) => {
  const { roomId, roomKey, socket } = portal;
  if (!roomId || !roomKey || !socket || isSavedToFirebase(portal, elements)) {
    return null;
  }

  // Fetch existing room data for reconciliation
  let reconciledElements: readonly SyncableExcalidrawElement[] = elements;

  try {
    const existingResponse = await fetch(
      `${HTTP_STORAGE_BACKEND_URL}/rooms/${roomId}`,
    );

    if (existingResponse.ok) {
      const existingBuffer = await existingResponse.arrayBuffer();
      const { iv, ciphertext } = unpackSceneBlob(existingBuffer);
      const prevStoredElements = getSyncableElements(
        restoreElements(
          await decryptElements(iv, ciphertext, roomKey),
          null,
        ),
      );

      reconciledElements = getSyncableElements(
        reconcileElements(
          elements,
          prevStoredElements as OrderedExcalidrawElement[] as RemoteExcalidrawElement[],
          appState,
        ),
      );
    }
    // If 404, no existing data — just save as new
  } catch (error) {
    // If fetch fails, save the current elements anyway
    console.warn("Could not fetch existing room data for reconciliation:", error);
  }

  const sceneVersion = getSceneVersion(reconciledElements);
  const { ciphertext, iv } = await encryptElements(
    roomKey,
    reconciledElements,
  );
  const blob = packSceneBlob(sceneVersion, iv, ciphertext);

  const saveResponse = await fetch(
    `${HTTP_STORAGE_BACKEND_URL}/rooms/${roomId}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Blob([blob] as BlobPart[]),
    },
  );

  if (!saveResponse.ok) {
    throw new Error(`Failed to save room: HTTP ${saveResponse.status}`);
  }

  // Decrypt what we saved to return to caller (matches original behavior)
  const storedElements = getSyncableElements(
    restoreElements(
      await decryptElements(iv, new Uint8Array(ciphertext), roomKey),
      null,
    ),
  );

  SceneVersionCache.set(socket, storedElements);

  return toBrandedType<RemoteExcalidrawElement[]>(storedElements);
};

// ---------------------------------------------------------------------------
// loadFromFirebase → HTTP GET /rooms/:roomId
// ---------------------------------------------------------------------------

export const loadFromFirebase = async (
  roomId: string,
  roomKey: string,
  socket: Socket | null,
): Promise<readonly SyncableExcalidrawElement[] | null> => {
  try {
    const response = await fetch(
      `${HTTP_STORAGE_BACKEND_URL}/rooms/${roomId}`,
    );

    if (!response.ok) {
      // 404 means room doesn't exist yet — not an error
      return null;
    }

    const buffer = await response.arrayBuffer();
    const { iv, ciphertext } = unpackSceneBlob(buffer);

    const elements = getSyncableElements(
      restoreElements(
        await decryptElements(iv, ciphertext, roomKey),
        null,
        { deleteInvisibleElements: true },
      ),
    );

    if (socket) {
      SceneVersionCache.set(socket, elements);
    }

    return elements;
  } catch (error) {
    console.error("Failed to load room from storage backend:", error);
    return null;
  }
};

// ---------------------------------------------------------------------------
// loadFilesFromFirebase → HTTP GET /files/:id
// ---------------------------------------------------------------------------

export const loadFilesFromFirebase = async (
  prefix: string,
  decryptionKey: string,
  filesIds: readonly FileId[],
) => {
  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();

  await Promise.all(
    [...new Set(filesIds)].map(async (id) => {
      try {
        const storageKey = `${prefix}/${id}`
          .replace(/^\//, "")
          .replace(/\//g, "__");
        const response = await fetch(
          `${HTTP_STORAGE_BACKEND_URL}/files/${storageKey}`,
        );

        if (response.ok) {
          const arrayBuffer = await response.arrayBuffer();

          const { data, metadata } = await decompressData<BinaryFileMetadata>(
            new Uint8Array(arrayBuffer),
            {
              decryptionKey,
            },
          );

          const dataURL = new TextDecoder().decode(data) as DataURL;

          loadedFiles.push({
            mimeType: metadata.mimeType || MIME_TYPES.binary,
            id,
            dataURL,
            created: metadata?.created || Date.now(),
            lastRetrieved: metadata?.created || Date.now(),
          });
        } else {
          erroredFiles.set(id, true);
        }
      } catch (error: any) {
        erroredFiles.set(id, true);
        console.error(error);
      }
    }),
  );

  return { loadedFiles, erroredFiles };
};
