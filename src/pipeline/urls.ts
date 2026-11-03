// What a URL in a pipeline may be: https, a public name, nothing else. The first line of defence; the
// proxy's allowlist and its own address check are the second.

const IPV4 = /^[0-9.]+$/;
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home.arpa"];

export function urlProblem(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return `${text} is not a URL.`;
  }
  if (url.protocol !== "https:") return `${text} is not allowed: only https is.`;
  if (url.username !== "" || url.password !== "") return `${text} is not allowed: a URL cannot carry credentials.`;
  if (url.port !== "") return `${text} is not allowed: only the default https port is.`;
  const host = hostOf(url);
  if (host.startsWith("[") || IPV4.test(host)) return `${text} is not allowed: an IP address cannot be fetched, only a name.`;
  if (host === "localhost" || !host.includes(".") || LOCAL_SUFFIXES.some((s) => host.endsWith(s))) {
    return `${text} is not allowed: local and private names cannot be fetched.`;
  }
  return null;
}

export function hostOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/\.$/, "");
}

export function hostOfUrl(text: string): string {
  return hostOf(new URL(text));
}

// Addresses the proxy refuses even when an allowed name resolves to them.
export function isPrivateAddress(address: string): boolean {
  const mapped = address.toLowerCase().replace(/^::ffff:/, "");
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(mapped);
  if (v4) {
    const [a, b, c] = [Number(v4[1]), Number(v4[2]), Number(v4[3])];
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  // IPv6 is public only in global unicast, minus the forms that embed an IPv4 address or are for
  // documentation. An allowlist, because the embedded forms (::a.b.c.d, 64:ff9b::, …) keep multiplying.
  if (!/^[23]/.test(mapped)) return true;
  const firstGroup = mapped.split(":")[0]!.padStart(4, "0");
  const secondGroup = (mapped.split(":")[1] ?? "").padStart(4, "0");
  return firstGroup === "2002" || (firstGroup === "2001" && (secondGroup === "0000" || secondGroup === "0db8"));
}
