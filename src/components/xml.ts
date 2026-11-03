// A small, tolerant XML reader for feeds. No DTD, no external or custom entities, so there is nothing
// to expand and nothing to fetch. Written here because a feed parser is the one piece that faces
// hostile input and a dependency there is the worst place for one.

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: Array<XmlNode | string>;
}

const MAX_DEPTH = 64;
const NAMED = new Map([["amp", "&"], ["lt", "<"], ["gt", ">"], ["quot", '"'], ["apos", "'"]]);
const NAME_START = /[A-Za-z_:\u0080-\uffff]/;

export function decodeXmlEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (all, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    }
    return NAMED.get(body) ?? all;
  });
}

// One pass with no backtracking: a tag can be megabytes of garbage. Only name="value" pairs count.
function readAttributes(text: string): Record<string, string> {
  const attrs: Record<string, string> = Object.create(null);
  let at = 0;
  while (at < text.length) {
    const equals = text.indexOf("=", at);
    if (equals === -1) break;
    let nameEnd = equals;
    while (nameEnd > at && isSpace(text.charCodeAt(nameEnd - 1))) nameEnd--;
    let nameStart = nameEnd;
    while (nameStart > at && !isSpace(text.charCodeAt(nameStart - 1)) && text[nameStart - 1] !== "/") nameStart--;
    let valueStart = equals + 1;
    while (valueStart < text.length && isSpace(text.charCodeAt(valueStart))) valueStart++;
    const quote = text[valueStart];
    if (quote !== '"' && quote !== "'") {
      at = valueStart;
      continue;
    }
    const valueEnd = text.indexOf(quote, valueStart + 1);
    if (valueEnd === -1) break;
    if (nameEnd > nameStart) attrs[text.slice(nameStart, nameEnd)] = decodeXmlEntities(text.slice(valueStart + 1, valueEnd));
    at = valueEnd + 1;
  }
  return attrs;
}

function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13;
}

// Returns the root element, or null when the text holds no element at all.
export function parseXml(text: string): XmlNode | null {
  const root: XmlNode = { name: "#document", attrs: {}, children: [] };
  const stack: XmlNode[] = [root];
  const top = () => stack[stack.length - 1]!;
  let at = 0;
  while (at < text.length) {
    const open = text.indexOf("<", at);
    if (open === -1) {
      if (stack.length > 1) top().children.push(decodeXmlEntities(text.slice(at)));
      break;
    }
    if (open > at && stack.length > 1) top().children.push(decodeXmlEntities(text.slice(at, open)));
    if (text.startsWith("<![CDATA[", open)) {
      const end = text.indexOf("]]>", open + 9);
      const stop = end === -1 ? text.length : end;
      if (stack.length > 1) top().children.push(text.slice(open + 9, stop));
      at = end === -1 ? text.length : end + 3;
    } else if (text.startsWith("<!--", open)) {
      const end = text.indexOf("-->", open + 4);
      at = end === -1 ? text.length : end + 3;
    } else if (text.startsWith("<?", open)) {
      const end = text.indexOf("?>", open + 2);
      at = end === -1 ? text.length : end + 2;
    } else if (text.startsWith("<!", open)) {
      at = skipDeclaration(text, open);
    } else if (text[open + 1] === "/") {
      const end = text.indexOf(">", open);
      const name = text.slice(open + 2, end === -1 ? text.length : end).trim();
      // A close tag with no matching open is ignored; one that matches further up closes what is between.
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i]!.name === name) {
          stack.length = i;
          break;
        }
      }
      at = end === -1 ? text.length : end + 1;
    } else {
      // Before looking for the end of a tag: `< < < …` must not scan the rest of the text each time.
      if (!NAME_START.test(text[open + 1] ?? "")) {
        if (stack.length > 1) top().children.push("<");
        at = open + 1;
        continue;
      }
      const end = findTagEnd(text, open);
      if (end === -1) break;
      const selfClosing = text[end - 1] === "/";
      const inner = text.slice(open + 1, selfClosing ? end - 1 : end);
      const nameEnd = inner.search(/\s/);
      const name = nameEnd === -1 ? inner : inner.slice(0, nameEnd);
      const node: XmlNode = { name, attrs: nameEnd === -1 ? {} : readAttributes(inner.slice(nameEnd)), children: [] };
      top().children.push(node);
      if (!selfClosing) {
        if (stack.length >= MAX_DEPTH) throw new Error("The document nests too deeply.");
        stack.push(node);
      }
      at = end + 1;
    }
  }
  return root.children.find((c): c is XmlNode => typeof c !== "string") ?? null;
}

function findTagEnd(text: string, open: number): number {
  let quote: string | null = null;
  for (let i = open + 1; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return i;
    }
  }
  return -1;
}

// Skips <!DOCTYPE …> including an internal subset, whose contents are ignored.
function skipDeclaration(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "[") depth++;
    else if (text[i] === "]") depth--;
    else if (text[i] === ">" && depth <= 0) return i + 1;
  }
  return text.length;
}
