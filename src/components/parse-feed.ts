// `parse_feed`: RSS 2.0, Atom 1.0 and RSS 1.0 into one message per entry. HTML becomes plain text; the
// raw HTML is not kept. Runs in the run process, so no Intl.

import { createHash } from "node:crypto";
import { StepError, type Message } from "../executor/messages.ts";
import { pointerGet } from "../pipeline/pointer.ts";
import type { Processor } from "./runtime.ts";
import { decodeXmlEntities, parseXml, type XmlNode } from "./xml.ts";

const DEFAULT_MAX_ENTRIES = 100;

const HTML_ENTITIES = new Map(Object.entries({
  nbsp: " ", ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•", middot: "·",
  copy: "©", reg: "®", trade: "™", laquo: "«", raquo: "»", eacute: "é", egrave: "è", agrave: "à", ccedil: "ç", uuml: "ü", ouml: "ö", auml: "ä",
}));
const BLOCK_END = /^(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/blockquote)\b/i;
const RAW_ELEMENT = /^(script|style)\b/i;

// One pass, no regex over the whole text: `<<<<`, `<!--<!--` and `<script><script>` in megabytes of
// content must stay linear. What has no end is treated as a browser would, or kept as text.
function stripMarkup(html: string): string {
  const out: string[] = [];
  let at = 0;
  while (at < html.length) {
    const open = html.indexOf("<", at);
    if (open === -1) {
      out.push(html.slice(at));
      break;
    }
    out.push(html.slice(at, open));
    if (html.startsWith("<!--", open)) {
      const end = html.indexOf("-->", open + 4);
      if (end === -1) break;
      out.push(" ");
      at = end + 3;
      continue;
    }
    const end = html.indexOf(">", open + 1);
    if (end === -1) {
      out.push(html.slice(open));
      break;
    }
    const start = html.slice(open + 1, Math.min(end, open + 16));
    const raw = RAW_ELEMENT.exec(start);
    if (raw) {
      const closer = new RegExp(`</${raw[1]}\\s*>`, "gi");
      closer.lastIndex = end + 1;
      const match = closer.exec(html);
      if (!match) break;
      out.push(" ");
      at = match.index + match[0].length;
      continue;
    }
    if (BLOCK_END.test(start)) out.push("\n");
    at = end + 1;
  }
  return out.join("");
}

export function htmlToText(html: string): string {
  return decodeXmlEntities(stripMarkup(html).replace(/&([a-zA-Z]+);/g, (all, name: string) => HTML_ENTITIES.get(name) ?? all))
    .replace(/[ \t\r\f\v ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function textOf(node: XmlNode | undefined): string {
  if (!node) return "";
  // Keeps inline markup, so htmlToText sees the same thing for xhtml as for escaped html.
  return node.children.map((c) => (typeof c === "string" ? c : `<${c.name}>${textOf(c)}</${c.name}>`)).join("");
}

function local(name: string): string {
  const colon = name.indexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}

function elements(node: XmlNode): XmlNode[] {
  return node.children.filter((c): c is XmlNode => typeof c !== "string");
}

function find(node: XmlNode, ...names: string[]): XmlNode | undefined {
  const kids = elements(node);
  for (const name of names) {
    const hit = kids.find((c) => c.name === name);
    if (hit) return hit;
  }
  return undefined;
}

function plain(node: XmlNode | undefined): string {
  return htmlToText(textOf(node));
}

function isoDate(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const ms = Date.parse(trimmed);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function resolveLink(link: string, base: string): string {
  const trimmed = link.trim();
  if (trimmed === "") return "";
  try {
    const url = new URL(trimmed, base || undefined);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function atomLink(entry: XmlNode, base: string): string {
  const links = elements(entry).filter((c) => local(c.name) === "link" && c.attrs.href !== undefined);
  const alternate = links.find((l) => l.attrs.rel === undefined || l.attrs.rel === "alternate") ?? links[0];
  return alternate ? resolveLink(alternate.attrs.href!, base) : "";
}

interface RawEntry {
  id: string;
  title: string;
  link: string;
  published: string | null;
  summary: string;
  content: string;
  author: string;
}

function rssEntry(item: XmlNode, base: string, feedAuthor: string): RawEntry {
  const guid = textOf(find(item, "guid")).trim();
  const link = resolveLink(textOf(find(item, "link")), base);
  const authorNode = find(item, "dc:creator", "author");
  return {
    id: guid,
    title: plain(find(item, "title")),
    link,
    published: isoDate(textOf(find(item, "pubDate", "dc:date"))),
    summary: plain(find(item, "description")),
    content: plain(find(item, "content:encoded")),
    author: plain(authorNode) || feedAuthor,
  };
}

function atomEntry(entry: XmlNode, base: string, feedAuthor: string): RawEntry {
  const authorNode = find(entry, "author");
  return {
    id: textOf(find(entry, "id")).trim(),
    title: plain(find(entry, "title")),
    link: atomLink(entry, base),
    published: isoDate(textOf(find(entry, "published", "updated"))),
    summary: plain(find(entry, "summary")),
    content: plain(find(entry, "content")),
    author: (authorNode && plain(find(authorNode, "name"))) || feedAuthor,
  };
}

export interface ParsedFeed {
  title: string;
  entries: RawEntry[];
}

export function parseFeedText(text: string, url: string): ParsedFeed {
  const root = parseXml(text);
  const rootName = root ? local(root.name) : "";
  if (root && rootName === "rss") {
    const channel = find(root, "channel");
    if (!channel) throw new Error("The rss document has no channel.");
    const author = plain(find(channel, "dc:creator", "managingEditor"));
    return { title: plain(find(channel, "title")), entries: elements(channel).filter((c) => c.name === "item").map((i) => rssEntry(i, url, author)) };
  }
  if (root && rootName === "feed") {
    const authorNode = find(root, "author");
    const author = authorNode ? plain(find(authorNode, "name")) : "";
    return { title: plain(find(root, "title")), entries: elements(root).filter((c) => local(c.name) === "entry").map((e) => atomEntry(e, url, author)) };
  }
  if (root && rootName === "RDF") {
    const channel = elements(root).find((c) => local(c.name) === "channel");
    const items = elements(root).filter((c) => local(c.name) === "item");
    return { title: channel ? plain(find(channel, "title")) : "", entries: items.map((i) => rssEntry(i, url, "")) };
  }
  throw new Error(root ? `The root element is ${root.name.slice(0, 80)}, which is not a feed.` : "The body is not XML.");
}

function entryId(entry: RawEntry): string {
  if (entry.id) return entry.id;
  if (entry.link) return entry.link;
  return createHash("sha256").update(`${entry.title}\n${entry.published ?? ""}`).digest("hex").slice(0, 32);
}

export const parseFeed: Processor = async (config, batch, ctx) => {
  const limit = config.max_entries ?? DEFAULT_MAX_ENTRIES;
  const out: Message[] = [];
  for (const message of batch) {
    const body = pointerGet(message.data, "/body");
    const url = message.meta.source_url ?? (typeof message.data?.url === "string" ? message.data.url : "");
    try {
      if (!body.found || typeof body.value !== "string") throw new Error("There is no text at /body.");
      const feed = parseFeedText(body.value, url);
      if (feed.entries.length > limit) ctx.warn(message.id, "feed_truncated", `${url} has ${feed.entries.length} entries; only the first ${limit} were read.`);
      feed.entries.slice(0, limit).forEach((entry, i) => {
        out.push({
          id: `${message.id}.${i}`,
          data: {
            id: entryId(entry),
            title: entry.title,
            link: entry.link,
            published: entry.published,
            summary: entry.summary,
            content: entry.content,
            author: entry.author,
            feed: { title: feed.title, url },
          },
          meta: { ...message.meta },
        });
      });
    } catch (err) {
      const text = `${url || `Message ${message.id}`} could not be read as a feed: ${(err as Error).message}`;
      ctx.unitFailed(message, new StepError("feed_invalid", text, { message_id: message.id }));
    }
  }
  return out;
};
