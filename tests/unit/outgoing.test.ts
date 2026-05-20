import { describe, test, expect, beforeEach } from "bun:test";
import {
  isPrivateIpAddress,
  isSafePublicUrlForOutgoing,
  setOutgoingAllowlist,
  isUrlAllowedForOutgoing,
} from "../../src/server/utils/outgoing";

describe("outgoing", () => {
  beforeEach(() => {
    const prev = process.env.DEGOOG_OUTGOING_ALLOWED_HOSTS;
    setOutgoingAllowlist([]);
    if (prev !== undefined) process.env.DEGOOG_OUTGOING_ALLOWED_HOSTS = prev;
  });

  describe("setOutgoingAllowlist", () => {
    test("empty or null list clears to empty set", () => {
      setOutgoingAllowlist(["example.com"]);
      setOutgoingAllowlist([]);
      expect(isUrlAllowedForOutgoing("https://example.com")).toBe(false);
    });
  });

  describe("isUrlAllowedForOutgoing", () => {
    test("returns false for non-http(s) protocols", () => {
      setOutgoingAllowlist(["*"]);
      expect(isUrlAllowedForOutgoing("ftp://host.com")).toBe(false);
      expect(isUrlAllowedForOutgoing("file:///local")).toBe(false);
    });

    test("returns false for invalid URL", () => {
      setOutgoingAllowlist(["*"]);
      expect(isUrlAllowedForOutgoing("not-a-url")).toBe(false);
    });

    test("when allowlist is null (unset), allows any http(s) URL", () => {
      setOutgoingAllowlist([]);
      expect(isUrlAllowedForOutgoing("https://any.com")).toBe(false);
      setOutgoingAllowlist(["other.com"]);
      expect(isUrlAllowedForOutgoing("https://allowed.com")).toBe(false);
    });

    test("when allowlist has hosts, allows only those hosts", () => {
      setOutgoingAllowlist(["example.com", "api.example.org"]);
      expect(isUrlAllowedForOutgoing("https://example.com/path")).toBe(true);
      expect(isUrlAllowedForOutgoing("http://api.example.org")).toBe(true);
      expect(isUrlAllowedForOutgoing("https://other.com")).toBe(false);
    });

    test("host matching is case-insensitive", () => {
      setOutgoingAllowlist(["Example.COM"]);
      expect(isUrlAllowedForOutgoing("https://example.com")).toBe(true);
      expect(isUrlAllowedForOutgoing("https://EXAMPLE.COM")).toBe(true);
    });

    test("when allowlist has *, allows any http(s) URL", () => {
      setOutgoingAllowlist(["*"]);
      expect(isUrlAllowedForOutgoing("https://any.com")).toBe(true);
      expect(isUrlAllowedForOutgoing("http://other.org")).toBe(true);
    });

    test("empty allowlist denies all", () => {
      setOutgoingAllowlist([]);
      expect(isUrlAllowedForOutgoing("https://example.com")).toBe(false);
    });

    describe("isPrivateIpAddress", () => {
      test("detects private and loopback IPv4 ranges", () => {
        expect(isPrivateIpAddress("127.0.0.1")).toBe(true);
        expect(isPrivateIpAddress("10.0.0.8")).toBe(true);
        expect(isPrivateIpAddress("172.16.0.1")).toBe(true);
        expect(isPrivateIpAddress("192.168.1.1")).toBe(true);
        expect(isPrivateIpAddress("169.254.169.254")).toBe(true);
        expect(isPrivateIpAddress("8.8.8.8")).toBe(false);
      });

      test("detects private and loopback IPv6 ranges", () => {
        expect(isPrivateIpAddress("::1")).toBe(true);
        expect(isPrivateIpAddress("fc00::1")).toBe(true);
        expect(isPrivateIpAddress("fe80::1")).toBe(true);
        expect(isPrivateIpAddress("::ffff:127.0.0.1")).toBe(true);
        expect(isPrivateIpAddress("2606:4700:4700::1111")).toBe(false);
      });
    });

    describe("isSafePublicUrlForOutgoing", () => {
      test("rejects unsafe protocols and local hostnames", async () => {
        expect(await isSafePublicUrlForOutgoing("javascript:alert(1)")).toBe(false);
        expect(await isSafePublicUrlForOutgoing("file:///etc/passwd")).toBe(false);
        expect(await isSafePublicUrlForOutgoing("http://localhost/search")).toBe(false);
        expect(await isSafePublicUrlForOutgoing("http://service.local/search")).toBe(false);
      });

      test("rejects private IP literals and userinfo", async () => {
        expect(await isSafePublicUrlForOutgoing("http://127.0.0.1/")).toBe(false);
        expect(await isSafePublicUrlForOutgoing("http://[::1]/")).toBe(false);
        expect(await isSafePublicUrlForOutgoing("https://user@example.com/")).toBe(false);
      });
    });
  });
});
