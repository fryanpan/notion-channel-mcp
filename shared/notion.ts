/**
 * Thin Notion API client for the two things the bridge needs to do:
 *   1. Fetch full comment/page/user details (Notion webhook payloads
 *      are metadata-only — you have to re-fetch to get the text).
 *   2. Walk the page ancestry chain, one API call per parent hop.
 *
 * No caching — the comment volume is low enough (dozens/day) that the
 * extra round-trips don't matter, and caching introduces invalidation
 * pain on page moves.
 */

import type { NotionComment, NotionPage } from "./types.ts";

const API_BASE = "https://api.notion.com/v1";
const API_VERSION = "2022-06-28";
const MAX_ANCESTRY_DEPTH = 20;

function getToken(): string {
  const token = process.env.NOTION_INTEGRATION_TOKEN;
  if (!token) {
    throw new Error(
      "NOTION_INTEGRATION_TOKEN is not set. Copy .env.example to .env and paste the Internal Integration Secret from https://www.notion.so/my-integrations.",
    );
  }
  return token;
}

function buildHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${getToken()}`,
    "Notion-Version": API_VERSION,
    "Content-Type": "application/json",
  };
}

async function apiGet<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { headers: buildHeaders() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Notion API ${res.status} on GET ${path}: ${body.slice(0, 300)}`,
    );
  }
  return (await res.json()) as T;
}

export async function fetchComment(commentId: string): Promise<NotionComment> {
  const data = (await apiGet(`/comments/${commentId}`)) as {
    id: string;
    parent: { page_id?: string; block_id?: string };
    rich_text: Array<{ plain_text?: string }>;
    created_by: { id?: string };
    created_time: string;
  };
  const text = (data.rich_text ?? [])
    .map((rt) => rt.plain_text ?? "")
    .join("");
  const authorId = data.created_by?.id ?? "unknown";
  const authorName = await fetchUserName(authorId).catch(() => "unknown");
  return {
    id: data.id,
    page_id: data.parent?.page_id ?? data.parent?.block_id ?? "",
    author_id: authorId,
    author_name: authorName,
    text,
    created_at: data.created_time ?? "",
  };
}

export async function fetchPage(pageId: string): Promise<NotionPage> {
  const data = (await apiGet(`/pages/${pageId}`)) as {
    id: string;
    parent: {
      type?: string;
      page_id?: string;
      database_id?: string;
      block_id?: string;
    };
    properties?: Record<string, unknown>;
  };
  const parentType = (data.parent?.type ?? "workspace") as NotionPage["parent_type"];
  const parentId =
    parentType === "page_id"
      ? (data.parent?.page_id ?? null)
      : parentType === "database_id"
        ? (data.parent?.database_id ?? null)
        : parentType === "block_id"
          ? (data.parent?.block_id ?? null)
          : null;
  return {
    id: data.id,
    title: extractTitle(data.properties ?? {}),
    parent_id: parentId,
    parent_type: parentType,
  };
}

function extractTitle(props: Record<string, unknown>): string {
  for (const value of Object.values(props)) {
    const v = value as {
      type?: string;
      title?: Array<{ plain_text?: string }>;
    };
    if (v.type === "title" && Array.isArray(v.title)) {
      const t = v.title.map((rt) => rt.plain_text ?? "").join("");
      if (t) return t;
    }
  }
  return "(untitled)";
}

async function fetchUserName(userId: string): Promise<string> {
  const data = (await apiGet(`/users/${userId}`)) as { name?: string };
  return data.name ?? "unknown";
}

/**
 * Walk up the ancestry chain, returning every ancestor page_id up to
 * the root. Stops at workspace root, a database, a block, or a cycle.
 * Hard cap at MAX_ANCESTRY_DEPTH to avoid pathological pages.
 */
export async function getAncestors(pageId: string): Promise<string[]> {
  const ancestors: string[] = [];
  const seen = new Set<string>([pageId]);
  let current = pageId;
  for (let depth = 0; depth < MAX_ANCESTRY_DEPTH; depth++) {
    let page: NotionPage;
    try {
      page = await fetchPage(current);
    } catch {
      break;
    }
    if (page.parent_type !== "page_id" || !page.parent_id) break;
    if (seen.has(page.parent_id)) break;
    ancestors.push(page.parent_id);
    seen.add(page.parent_id);
    current = page.parent_id;
  }
  return ancestors;
}
