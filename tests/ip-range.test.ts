import { describe, it, expect } from "vitest";
import { isPublicAddress } from "../src/utils/ip-range.js";

describe("isPublicAddress", () => {
  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "93.184.215.14",
    // The edges just outside the private and reserved blocks.
    "9.255.255.255",
    "11.0.0.0",
    "100.63.255.255",
    "100.128.0.0",
    "126.255.255.255",
    "128.0.0.0",
    "169.253.255.255",
    "169.255.0.0",
    "172.15.255.255",
    "172.32.0.0",
    "192.167.255.255",
    "192.169.0.0",
    "198.17.255.255",
    "198.20.0.0",
    "223.255.255.255",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
    "2a00:1450:4001:82a::200e",
    "[2606:4700::1]",
    // An IPv4 address inside an IPv6 one gets the IPv4 answer.
    "::ffff:8.8.8.8",
    "::ffff:808:808",
    "64:ff9b::8.8.8.8",
    "2002:808:808::1",
  ])("%s is public", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each([
    ["0.0.0.0", "this network"],
    ["0.1.2.3", "this network"],
    ["10.0.0.1", "private"],
    ["10.255.255.255", "private"],
    ["100.64.0.1", "carrier-grade NAT"],
    ["100.127.255.255", "carrier-grade NAT"],
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["169.254.169.254", "link-local, cloud metadata"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.0.0.8", "IETF protocol assignments"],
    ["192.0.2.1", "documentation"],
    ["192.88.99.1", "6to4 relay"],
    ["192.168.1.1", "private"],
    ["198.18.0.1", "benchmarking"],
    ["198.19.255.255", "benchmarking"],
    ["198.51.100.1", "documentation"],
    ["203.0.113.1", "documentation"],
    ["224.0.0.1", "multicast"],
    ["239.255.255.250", "multicast"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "broadcast"],
    ["::", "unspecified"],
    ["::1", "loopback"],
    ["[::1]", "loopback, bracketed"],
    ["fc00::1", "unique local"],
    ["fd00:ec2::254", "unique local, EC2 metadata"],
    ["fe80::1", "link-local"],
    ["fe80::1%en0", "link-local with a zone id"],
    ["ff02::1", "multicast"],
    ["::ffff:127.0.0.1", "IPv4-mapped loopback"],
    ["::ffff:7f00:1", "IPv4-mapped loopback, hex"],
    ["::ffff:169.254.169.254", "IPv4-mapped metadata"],
    ["::ffff:10.0.0.1", "IPv4-mapped private"],
    ["64:ff9b::127.0.0.1", "NAT64 loopback"],
    ["64:ff9b::a00:1", "NAT64 private"],
    ["::127.0.0.1", "IPv4-compatible, deprecated"],
    ["2002:7f00:1::1", "6to4 of loopback"],
    ["2002:a9fe:a9fe::1", "6to4 of the metadata address"],
    ["2001::1", "Teredo"],
    ["2001:db8::1", "documentation"],
    ["3fff::1", "documentation"],
    ["5f00::1", "SRv6"],
    ["4000::1", "outside 2000::/3"],
  ])("%s is not public (%s)", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["", "localhost", "example.com", "999.1.1.1", "1.2.3", "1.2.3.4.5", "::g", "1::2::3", "[]"])(
    "%j does not parse, so it is not public",
    (address) => {
      expect(isPublicAddress(address)).toBe(false);
    }
  );
});
