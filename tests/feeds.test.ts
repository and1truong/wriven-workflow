import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeBody } from "../src/components/http-fetch.ts";
import { htmlToText, parseFeedText } from "../src/components/parse-feed.ts";
import { parseXml } from "../src/components/xml.ts";
import { REPO } from "./helpers.ts";

const FEEDS = join(REPO, "fixtures", "feeds");
const load = (name: string) => decodeBody(new Uint8Array(readFileSync(join(FEEDS, name))), "application/xml");
const URL_ = "https://feeds.example.org/feed.xml";

describe("corpus", () => {
  const expected: Record<string, number> = {
    "wordpress-rss2.xml": 2,
    "atom-static-site.xml": 2,
    "rss1-rdf.xml": 2,
    "video-atom.xml": 1,
    "newsletter-rss2.xml": 1,
    "latin1-rss2.xml": 1,
    "bom-rss2.xml": 1,
    "no-ids-relative-links.xml": 3,
    "entity-doctype.xml": 1,
  };
  for (const file of readdirSync(FEEDS).filter((f) => f.endsWith(".xml"))) {
    if (file.includes(".invalid.")) {
      test(`${file} is rejected`, () => expect(() => parseFeedText(load(file), URL_)).toThrow());
    } else {
      test(`${file} parses`, () => {
        const feed = parseFeedText(load(file), URL_);
        expect(feed.entries.length).toBe(expected[file]!);
        for (const entry of feed.entries) expect(entry.title.length).toBeGreaterThan(0);
      });
    }
  }
});

describe("entries", () => {
  test("RSS 2.0: CDATA, content:encoded, dc:creator, guid; scripts and styles go", () => {
    const feed = parseFeedText(load("wordpress-rss2.xml"), URL_);
    expect(feed.title).toBe("A Small Blog – Notes");
    const first = feed.entries[0]!;
    expect(first.id).toBe("https://blog.example.org/?p=1042");
    expect(first.title).toBe("Why we moved to “boring” tech");
    expect(first.link).toBe("https://blog.example.org/2026/11/boring-tech/");
    expect(first.author).toBe("Sam Lee");
    expect(first.published).toBe("2026-11-02T21:14:05.000Z");
    expect(first.content).toBe("We replaced three services with one.\nLatency fell & so did the bill.");
    expect(first.content).not.toContain("tracker");
    expect(first.summary).toStartWith("We replaced three services with one. Here is what happened…");
  });

  test("Atom: relative alternate link, xhtml content, html summary, feed author, updated as a fallback", () => {
    const feed = parseFeedText(load("atom-static-site.xml"), "https://news.example.net/atom.xml");
    const [first, second] = feed.entries;
    expect(first!.link).toBe("https://news.example.net/posts/first/");
    expect(first!.id).toBe("urn:uuid:1225c695-cfb8-4ebb-aaaa-80da344efa6a");
    expect(first!.title).toBe("First & foremost");
    expect(first!.summary).toBe("A short summary.");
    expect(first!.content).toBe("The whole story.\nSecond paragraph.");
    expect(first!.author).toBe("The Editors");
    expect(first!.published).toBe("2026-11-01T23:30:00.000Z");
    expect(second!.title).toBe("Second thing");
    expect(second!.author).toBe("Alex Kim");
    expect(second!.published).toBe("2026-11-01T12:00:00.000Z");
  });

  test("RSS 1.0: items beside the channel, dc:date", () => {
    const feed = parseFeedText(load("rss1-rdf.xml"), URL_);
    expect(feed.title).toBe("Old Reliable");
    expect(feed.entries[0]).toMatchObject({ title: "Item A", id: "", link: "https://example.com/a", author: "Pat", published: "2026-10-31T01:02:03.000Z" });
  });

  test("encodings: the XML declaration decides; a BOM goes", () => {
    expect(parseFeedText(load("latin1-rss2.xml"), URL_).entries[0]!.title).toBe("Déjà vu");
    expect(parseFeedText(load("bom-rss2.xml"), URL_).entries[0]!.id).toBe("bom-1");
  });

  test("relative links resolve, bad dates are null, javascript links are dropped", () => {
    const feed = parseFeedText(load("no-ids-relative-links.xml"), URL_);
    expect(feed.entries[0]!.link).toBe("https://feeds.example.org/posts/1");
    expect(feed.entries[0]!.published).toBeNull();
    expect(feed.entries[2]!.link).toBe("");
  });

  test("custom and external entities are not expanded", () => {
    const feed = parseFeedText(load("entity-doctype.xml"), URL_);
    expect(feed.title).toBe("Entities &lol2;");
    expect(feed.entries[0]!.title).toBe("Not expanded &xxe;");
  });
});

describe("the XML reader under hostile input", () => {
  test("very deep nesting is an error, not a crash", () => {
    expect(() => parseXml("<a>".repeat(100_000))).toThrow("nests too deeply");
  });
  test("a truncated document does not throw", () => {
    expect(parseXml("<rss><channel><title>x")?.name).toBe("rss");
    expect(parseXml('<rss version="2')).toBeNull();
  });
  test("html to text", () => {
    expect(htmlToText("<p>a</p><p>b &amp; c</p>")).toBe("a\nb & c");
    expect(htmlToText("x<br/>y&nbsp;z")).toBe("x\ny z");
  });
});
