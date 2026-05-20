/**
 * @fccview here
 * scraping is a crazy business. This shit is hard.
 * For example, our big G has very strict TLS policies, which means sometimes it'll
 * randomly block bun's fetch.
 *
 * The best solution I could come up with is to use curl binaries as fallback for requests.
 * Until/if bun implements TLS pinning, this is the best we can do.
 *
 * Also bun doesn't support socks5 proxies, so we use a separate library for that. How fun.
 *
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { fetch as bunFetch } from "bun";
import { resolveTransport } from "../extensions/transports/registry";
import type {
  ProxyAwareFetch,
  Transport,
  TransportContext,
  TransportFetchOptions,
} from "../types";
import { fetchViaHttpProxy } from "./http-proxy-fetch";
import { logger } from "./logger";
import { getBaseUrl } from "./base-url";
import { asBoolean, getSettings } from "./plugin-settings";
import { fetchViaSocks, isSocksProxy } from "./socks-fetch";

export type { TransportFetchOptions as OutgoingFetchOptions };

const DEGOOG_SETTINGS_ID = "degoog-settings";

export type OutgoingTransport = string;

export function parseOutgoingTransport(raw: string | undefined): string {
  return raw?.trim() || "fetch";
}

let allowedHosts: Set<string> | null = null;

const LOCAL_HOSTS = new Set([
  "localhost",
  "host.docker.internal",
  "gateway.docker.internal",
]);

/** @deprecated Legacy outgoing-fetch allowlist. Sign image URLs with ctx.signProxyUrl instead. */
export function setOutgoingAllowlist(hosts: string[]): void {
  if (!hosts || hosts.length === 0) {
    allowedHosts = new Set();
    return;
  }
  const normalized = hosts.map((h) => h.trim().toLowerCase()).filter(Boolean);
  const extra = process.env.DEGOOG_OUTGOING_ALLOWED_HOSTS ?? "";
  const fromEnv = extra
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  allowedHosts = new Set([...normalized, ...fromEnv]);
}

let proxyIndex = 0;

function parseProxyUrls(raw: string): string[] {
  if (!raw || typeof raw !== "string") return [];
  return raw
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseProxyUrlsList(rawList: string[]): string[] {
  const out: string[] = [];
  for (const raw of rawList) {
    if (typeof raw !== "string") continue;
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) out.push(trimmed);
    }
  }
  return out;
}

/** @deprecated Legacy outgoing-fetch allowlist. Sign image URLs with ctx.signProxyUrl instead. */
export function isUrlAllowedForOutgoing(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return false;
  } catch {
    return false;
  }
  if (!allowedHosts) return true;
  if (allowedHosts.size === 0) return false;
  if (allowedHosts.has("*")) return true;
  const host = new URL(url).hostname.toLowerCase();
  return allowedHosts.has(host);
}

function ipv4ToInt(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out = (out << 8) + n;
  }
  return out >>> 0;
}

function ipv4InCidr(address: string, base: string, bits: number): boolean {
  const ip = ipv4ToInt(address);
  const network = ipv4ToInt(base);
  if (ip === null || network === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ip & mask) === (network & mask);
}

function parseIpv6Groups(address: string): number[] | null {
  const zoneIndex = address.indexOf("%");
  const withoutZone = zoneIndex === -1 ? address : address.slice(0, zoneIndex);
  let normalized = withoutZone.toLowerCase();
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    const ipv4 = normalized.slice(lastColon + 1);
    const n = ipv4ToInt(ipv4);
    if (n === null) return null;
    normalized =
      normalized.slice(0, lastColon) +
      `:${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (missing < 0 || (halves.length === 1 && left.length !== 8)) return null;

  const rawGroups = [...left, ...Array(missing).fill("0"), ...right];
  const groups = rawGroups.map((part) => {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return -1;
    return parseInt(part, 16);
  });
  return groups.length === 8 && groups.every((n) => n >= 0) ? groups : null;
}

export function isPrivateIpAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const blockedRanges: [string, number][] = [
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["192.168.0.0", 16],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 4],
      ["240.0.0.0", 4],
    ];
    return blockedRanges.some(([base, bits]) =>
      ipv4InCidr(address, base, bits),
    );
  }

  if (isIP(address) !== 6) return true;
  const groups = parseIpv6Groups(address);
  if (!groups) return true;

  const mappedIpv4 =
    groups.slice(0, 5).every((n) => n === 0) && groups[5] === 0xffff;
  if (mappedIpv4) {
    return isPrivateIpAddress(
      `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`,
    );
  }

  const allZero = groups.every((n) => n === 0);
  const loopback =
    groups.slice(0, 7).every((n) => n === 0) && groups[7] === 1;
  return (
    allZero ||
    loopback ||
    (groups[0] & 0xfe00) === 0xfc00 ||
    (groups[0] & 0xffc0) === 0xfe80 ||
    (groups[0] & 0xff00) === 0xff00 ||
    (groups[0] === 0x2001 && groups[1] === 0x0db8)
  );
}

function hostnameLooksLocal(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return (
    LOCAL_HOSTS.has(host) ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  );
}

function isConfiguredSelfHost(hostname: string): boolean {
  const baseUrl = getBaseUrl();
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) return false;
  try {
    return new URL(baseUrl).hostname.toLowerCase() === hostname.toLowerCase();
  } catch {
    return false;
  }
}

export function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export async function isSafePublicUrlForOutgoing(url: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;

  const hostname = parsed.hostname;
  if (!hostname || hostnameLooksLocal(hostname) || isConfiguredSelfHost(hostname)) {
    return false;
  }

  const literalIpVersion = isIP(hostname);
  if (literalIpVersion) return !isPrivateIpAddress(hostname);

  try {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    return (
      addresses.length > 0 &&
      addresses.every((a) => !isPrivateIpAddress(a.address))
    );
  } catch {
    return false;
  }
}

function _buildProxyFetch(
  proxyUrl?: string,
  timeoutMs?: number,
): ProxyAwareFetch {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const redirect = init?.redirect ?? "follow";
    const signal = init?.signal ?? undefined;
    const headers = init?.headers as Record<string, string> | undefined;
    const body = typeof init?.body === "string" ? init.body : undefined;

    if (!proxyUrl) {
      return bunFetch(url, { method, redirect, signal, headers, body });
    }

    if (isSocksProxy(proxyUrl)) {
      return fetchViaSocks(
        url,
        proxyUrl,
        {
          method,
          redirect,
          signal,
          headers,
          body,
        },
        timeoutMs,
      );
    }

    return fetchViaHttpProxy(
      url,
      proxyUrl,
      {
        method,
        redirect,
        signal,
        headers,
        body,
      },
      timeoutMs,
    );
  };
}

async function buildTransportContext(
  transportName: string,
  opts?: {
    proxyOverrideEnabled?: boolean;
    proxyOverrideUrls?: string | string[];
  },
): Promise<{ transport: Transport; context: TransportContext }> {
  const settings = await getSettings(DEGOOG_SETTINGS_ID);
  const proxyOverrideEnabled = opts?.proxyOverrideEnabled === true;
  const proxyOverrideRaw = opts?.proxyOverrideUrls;

  const globalEnabled = asBoolean(settings.proxyEnabled);
  const globalProxyUrlsRaw = settings.proxyUrls;
  const globalUrls = parseProxyUrls(
    typeof globalProxyUrlsRaw === "string" ? globalProxyUrlsRaw : "",
  );

  const overrideUrls = Array.isArray(proxyOverrideRaw)
    ? parseProxyUrlsList(proxyOverrideRaw)
    : parseProxyUrls(typeof proxyOverrideRaw === "string" ? proxyOverrideRaw : "");

  const useProxy = proxyOverrideEnabled
    ? overrideUrls.length > 0
    : globalEnabled && globalUrls.length > 0;

  const urls = proxyOverrideEnabled ? overrideUrls : globalUrls;
  const proxyUrl = useProxy ? urls[proxyIndex++ % urls.length] : undefined;
  const transport = resolveTransport(transportName);
  return {
    transport,
    context: {
      proxyUrl,
      fetch: _buildProxyFetch(proxyUrl, transport.timeoutMs),
    },
  };
}

export async function outgoingFetch(
  url: string,
  options: TransportFetchOptions = {},
  transportName: string = "fetch",
  ctx?: {
    proxyOverrideEnabled?: boolean;
    proxyOverrideUrls?: string | string[];
  },
): Promise<Response> {
  const { transport, context } = await buildTransportContext(transportName, ctx);
  const host = new URL(url).hostname;
  if (context.proxyUrl) {
    logger.debug(
      "outgoing",
      `${transport.name} via ${context.proxyUrl} -> ${host}`,
    );
  } else {
    logger.debug("outgoing", `${transport.name} -> ${host}`);
  }
  return transport.fetch(url, options, context);
}
