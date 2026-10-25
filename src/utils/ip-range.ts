import { isIPv4, isIPv6 } from "node:net";

/**
 * Whether an IP address is on the public internet, i.e. not loopback, private,
 * link-local, carrier-grade NAT, multicast, documentation or reserved space.
 *
 * Used to keep a caller-chosen URL from reaching the machine the server runs
 * on, its LAN, or a cloud metadata endpoint (169.254.169.254, fd00:ec2::254).
 * Anything that does not parse as an address is treated as not public.
 *
 * Addresses are compared as bytes, so every spelling of one address gets the
 * same answer: ::ffff:127.0.0.1 and ::ffff:7f00:1 are both loopback.
 */
export function isPublicAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "").split("%")[0];
  if (isIPv4(bare)) return isPublicV4(parseV4(bare));
  if (isIPv6(bare)) {
    const bytes = parseV6(bare);
    return bytes ? isPublicV6(bytes) : false;
  }
  return false;
}

type Prefix = [bytes: number[], bits: number];

// IANA IPv4 special-purpose registry, minus the few globally reachable
// anycast entries no file is served from.
const V4_BLOCKED: Prefix[] = [
  [[0], 8], // "this network"
  [[10], 8], // private (RFC 1918)
  [[100, 64], 10], // carrier-grade NAT (RFC 6598)
  [[127], 8], // loopback
  [[169, 254], 16], // link-local, including cloud metadata endpoints
  [[172, 16], 12], // private (RFC 1918)
  [[192, 0, 0], 24], // IETF protocol assignments
  [[192, 0, 2], 24], // documentation (TEST-NET-1)
  [[192, 88, 99], 24], // 6to4 relay anycast
  [[192, 168], 16], // private (RFC 1918)
  [[198, 18], 15], // benchmarking
  [[198, 51, 100], 24], // documentation (TEST-NET-2)
  [[203, 0, 113], 24], // documentation (TEST-NET-3)
  [[224], 4], // multicast
  [[240], 4], // reserved, and 255.255.255.255 broadcast
];

// Inside 2000::/3, the only IPv6 space allocated for global unicast. Everything
// outside it (::1, ::, fc00::/7, fe80::/10, ff00::/8, ...) is refused before
// this list is consulted.
const V6_BLOCKED: Prefix[] = [
  [[0x20, 0x01, 0x00, 0x00], 23], // IETF protocol assignments, Teredo included
  [[0x20, 0x01, 0x0d, 0xb8], 32], // documentation
  [[0x3f, 0xff], 20], // documentation (RFC 9637)
  [[0x5f, 0x00], 16], // SRv6 SIDs (RFC 9602)
];

function inPrefix(bytes: number[], [prefix, bits]: Prefix): boolean {
  for (let i = 0; i < bits; i++) {
    const mask = 0x80 >> (i & 7);
    if (((bytes[i >> 3] ?? 0) & mask) !== ((prefix[i >> 3] ?? 0) & mask)) return false;
  }
  return true;
}

function parseV4(address: string): number[] {
  return address.split(".").map(Number);
}

function isPublicV4(bytes: number[]): boolean {
  return !V4_BLOCKED.some((p) => inPrefix(bytes, p));
}

// 16 bytes, or undefined for a string isIPv6 accepted but this cannot read.
function parseV6(address: string): number[] | undefined {
  let text = address;
  // A dotted IPv4 tail (::ffff:10.0.0.1) is two more 16-bit groups.
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (!isIPv4(tail)) return undefined;
    const [a, b, c, d] = parseV4(tail);
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const groupsOf = (s: string) => (s === "" ? [] : s.split(":"));
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  let groups: string[];
  if (halves.length === 2) {
    const head = groupsOf(halves[0]);
    const rest = groupsOf(halves[1]);
    const fill = 8 - head.length - rest.length;
    if (fill < 0) return undefined;
    groups = [...head, ...Array<string>(fill).fill("0"), ...rest];
  } else {
    groups = groupsOf(text);
  }
  if (groups.length !== 8) return undefined;
  return groups.flatMap((g) => {
    const n = Number.parseInt(g, 16);
    return [n >> 8, n & 0xff];
  });
}

function isPublicV6(bytes: number[]): boolean {
  // An IPv4 address carried inside an IPv6 one reaches that IPv4 address, so
  // it gets the IPv4 answer: IPv4-mapped ::ffff:0:0/96 and NAT64 64:ff9b::/96.
  const mapped = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff];
  const nat64 = [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0];
  if (inPrefix(bytes, [mapped, 96]) || inPrefix(bytes, [nat64, 96])) {
    return isPublicV4(bytes.slice(12));
  }
  if (!inPrefix(bytes, [[0x20], 3])) return false;
  // 6to4 (2002::/16) embeds the IPv4 address of the far end in bytes 2-5.
  if (inPrefix(bytes, [[0x20, 0x02], 16])) return isPublicV4(bytes.slice(2, 6));
  return !V6_BLOCKED.some((p) => inPrefix(bytes, p));
}
