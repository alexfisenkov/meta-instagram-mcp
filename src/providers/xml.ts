export interface AppiumXmlNode {
  tag: string;
  attributes: Readonly<Record<string, string>>;
  children: AppiumXmlNode[];
  text: string;
}
export interface AppiumXmlLimits { maxBytes?: number; maxDepth?: number; maxNodes?: number }

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Small non-validating XML reader for bounded Appium page-source snapshots. */
export function parseAppiumXml(xml: string, limits: AppiumXmlLimits = {}): AppiumXmlNode {
  const maxBytes = limits.maxBytes ?? 1_000_000;
  const maxDepth = limits.maxDepth ?? 64;
  const maxNodes = limits.maxNodes ?? 20_000;
  if (typeof xml !== "string" || Buffer.byteLength(xml, "utf8") > maxBytes) throw new Error("Appium XML exceeds size limit");
  if (/<!(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw new Error("DTD and entity declarations are not allowed");
  const stack: AppiumXmlNode[] = [];
  const roots: AppiumXmlNode[] = [];
  let nodes = 0;
  let cursor = 0;
  while (cursor < xml.length) {
    const open = xml.indexOf("<", cursor);
    const textEnd = open === -1 ? xml.length : open;
    if (textEnd > cursor) {
      const text = decodeEntities(xml.slice(cursor, textEnd));
      if (stack.length) stack[stack.length - 1]!.text += text;
      else if (text.trim()) throw new Error("text outside XML root");
    }
    if (open === -1) { cursor = xml.length; break; }
    if (xml.startsWith("<!--", open)) {
      const end = xml.indexOf("-->", open + 4);
      if (end === -1) throw new Error("unterminated XML comment");
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", open)) {
      const end = xml.indexOf("]]>", open + 9);
      if (end === -1) throw new Error("unterminated XML CDATA");
      if (stack.length) stack[stack.length - 1]!.text += xml.slice(open + 9, end);
      else if (xml.slice(open + 9, end).trim()) throw new Error("CDATA outside XML root");
      cursor = end + 3;
      continue;
    }
    const close = findTagEnd(xml, open + 1);
    if (close === -1) throw new Error("unterminated XML tag");
    const source = xml.slice(open + 1, close).trim();
    cursor = close + 1;
    if (source.startsWith("?")) {
      if (stack.length || roots.length || !/^\?xml\s/i.test(source)) throw new Error("unsupported XML processing instruction");
      continue;
    }
    if (source.startsWith("!")) throw new Error("unsupported XML declaration");
    if (source.startsWith("/")) {
      const name = source.slice(1).trim();
      if (!/^[A-Za-z_][\w:.-]*$/.test(name) || stack.pop()?.tag !== name) throw new Error("mismatched XML closing tag");
      continue;
    }
    const selfClosing = source.endsWith("/");
    const body = selfClosing ? source.slice(0, -1).trim() : source;
    const { tag, attributes } = parseOpenTag(body);
    if (stack.length + 1 > maxDepth) throw new Error("Appium XML exceeds depth limit");
    if (++nodes > maxNodes) throw new Error("Appium XML exceeds node limit");
    const node: AppiumXmlNode = { tag, attributes, children: [], text: "" };
    if (stack.length) stack[stack.length - 1]!.children.push(node);
    else roots.push(node);
    if (!selfClosing) {
      stack.push(node);
    }
  }
  if (stack.length || roots.length !== 1) throw new Error("Appium XML must have one complete root");
  return roots[0]!;
}

export function appiumXmlValues(root: AppiumXmlNode): string[] {
  const values: string[] = [];
  const visit = (node: AppiumXmlNode) => {
    for (const key of ["label", "name", "value", "content-desc", "text", "resource-id"]) {
      const value = node.attributes[key]?.trim();
      if (value && !values.includes(value)) values.push(value);
    }
    if (node.text.trim() && !values.includes(node.text.trim())) values.push(node.text.trim());
    node.children.forEach(visit);
  };
  visit(root);
  return values;
}

export function appiumXmlFind(root: AppiumXmlNode, predicate: (node: AppiumXmlNode) => boolean): AppiumXmlNode[] {
  const matches: AppiumXmlNode[] = [];
  const visit = (node: AppiumXmlNode) => { if (predicate(node)) matches.push(node); node.children.forEach(visit); };
  visit(root);
  return matches;
}

function parseOpenTag(source: string): { tag: string; attributes: Record<string, string> } {
  const match = source.match(/^([A-Za-z_][\w:.-]*)/);
  if (!match) throw new Error("invalid XML tag name");
  const tag = match[1]!;
  const attributes: Record<string, string> = Object.create(null) as Record<string, string>;
  let cursor = match[0].length;
  while (cursor < source.length) {
    while (/\s/.test(source[cursor] ?? "")) cursor++;
    if (cursor >= source.length) break;
    const rest = source.slice(cursor);
    const attr = rest.match(/^([A-Za-z_][\w:.-]*)\s*=\s*(["'])/);
    if (!attr) throw new Error("malformed XML attribute");
    const name = attr[1]!;
    if (Object.hasOwn(attributes, name)) throw new Error("duplicate XML attribute");
    const quote = attr[2]!;
    cursor += attr[0].length;
    const end = source.indexOf(quote, cursor);
    if (end === -1) throw new Error("unterminated XML attribute");
    attributes[name] = decodeEntities(source.slice(cursor, end));
    cursor = end + 1;
  }
  return { tag, attributes };
}

function findTagEnd(xml: string, cursor: number): number {
  let quote = "";
  for (let i = cursor; i < xml.length; i++) {
    const char = xml[i]!;
    if (quote) { if (char === quote) quote = ""; }
    else if (char === "'" || char === '"') quote = char;
    else if (char === ">") return i;
  }
  return -1;
}

function decodeEntities(value: string): string {
  if (value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, "").includes("&")) throw new Error("malformed XML entity");
  const decoded = value.replace(/&([^;]+);/g, (_all, name: string) => {
    if (Object.hasOwn(ENTITIES, name)) return ENTITIES[name]!;
    const code = name.startsWith("#x") ? Number.parseInt(name.slice(2), 16) : name.startsWith("#") ? Number.parseInt(name.slice(1), 10) : NaN;
    if (!Number.isInteger(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new Error("unsupported XML entity");
    return String.fromCodePoint(code);
  });
  return decoded;
}
