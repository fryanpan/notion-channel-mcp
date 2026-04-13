// Domain types shared between the receiver daemon and the per-session MCP server.

export type StableId = string;

export interface Subscription {
  id: number;
  peer_stable_id: StableId;
  page_id: string;
  include_descendants: boolean;
  created_at: string;
}

export interface NotionComment {
  id: string;
  page_id: string;
  author_id: string;
  author_name: string;
  text: string;
  created_at: string;
}

export interface NotionPage {
  id: string;
  title: string;
  parent_id: string | null;
  parent_type: "page_id" | "database_id" | "workspace" | "block_id";
}
