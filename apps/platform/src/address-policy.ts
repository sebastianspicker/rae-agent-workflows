/** Purpose: the one classifier for non-global (private, loopback, reserved) IP literals. */
import * as net from "node:net";

function ipv4Number(address: string) {
  return address.split(".").reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0);
}

function ipv4Prefix(base: string, prefixLength: number) {
  const shift = 32 - prefixLength;
  const mask = prefixLength === 0 ? 0 : (0xffffffff << shift) >>> 0;
  return { network: (ipv4Number(base) & mask) >>> 0, mask };
}

const NON_GLOBAL_IPV4_PREFIXES = (
  [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] satisfies [string, number][]
).map(([base, prefixLength]) => ipv4Prefix(base, prefixLength));

function privateIpv4(address: string) {
  const value = ipv4Number(address);
  return NON_GLOBAL_IPV4_PREFIXES.some(({ network, mask }) => (value & mask) >>> 0 === network);
}

function ipv6Words(address: string) {
  let value = address.toLowerCase().split("%", 1)[0];
  const dottedTail = /(?:^|:)(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (dottedTail) {
    const ipv4 = ipv4Number(dottedTail[1]);
    value = `${value.slice(0, -dottedTail[1].length)}${(ipv4 >>> 16).toString(16)}:${(
      ipv4 & 0xffff
    ).toString(16)}`;
  }
  const halves = value.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const zeroCount = halves.length === 2 ? 8 - left.length - right.length : 0;
  return [...left, ...Array(zeroCount).fill("0"), ...right].map((word) =>
    Number.parseInt(word, 16),
  );
}

function ipv6Prefix(base: string, prefixLength: number) {
  return { words: ipv6Words(base), prefixLength };
}

const NON_GLOBAL_IPV6_PREFIXES = (
  [
    ["::", 96],
    ["::ffff:0:0", 96],
    ["64:ff9b::", 96],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001::", 23],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["3fff::", 20],
    ["5f00::", 16],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
  ] satisfies [string, number][]
).map(([base, prefixLength]) => ipv6Prefix(base, prefixLength));

function hasIpv6Prefix(words: number[], prefix: { words: number[]; prefixLength: number }) {
  const wholeWords = Math.floor(prefix.prefixLength / 16);
  const remainder = prefix.prefixLength % 16;
  for (let index = 0; index < wholeWords; index += 1) {
    if (words[index] !== prefix.words[index]) return false;
  }
  if (remainder === 0) return true;
  const mask = (0xffff << (16 - remainder)) & 0xffff;
  return (words[wholeWords] & mask) === (prefix.words[wholeWords] & mask);
}

function privateIpv6(address: string) {
  const words = ipv6Words(address);
  return NON_GLOBAL_IPV6_PREFIXES.some((prefix) => hasIpv6Prefix(words, prefix));
}

export function publicAddress(address: string) {
  if (net.isIPv4(address)) return !privateIpv4(address);
  if (net.isIPv6(address)) return !privateIpv6(address);
  return false;
}
