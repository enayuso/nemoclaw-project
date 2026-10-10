"use strict";
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// LOCAL PATCH (2026-08-05, nemoclaw-project) -- NOT upstream NemoClaw.
// Stock body was a single call:
//     return lookup(hostname, { all: true, verbatim: true });
// The unmodified file is kept beside this one as resolve.js.orig, and this
// patch is re-appliable via scripts/patch-nemoclaw-dns.sh in the
// nemoclaw-project repo (a NemoClaw upgrade will overwrite it).
//
// THE PROBLEM. `dns.lookup(..., {all:true})` returns every address in ONE
// getaddrinfo answer. api.githubcopilot.com's authoritative DNS hands back a
// single rotating A record per query, cycling through at least
// 140.82.{112,113,114}.{21,22}. So NemoClaw pins exactly one address into the
// generated MCP policy's allowed_ips, while OpenShell re-resolves on EVERY
// connection and usually lands on a different member of the pool:
//     NET:OPEN DENIED [engine:ssrf] [reason:... not in allowed_ips]
// `mcp restart` re-resolves and re-pins, but only ever to one member, so it
// just re-rolls which ~1-in-6 connections would have been allowed. This had
// GitHub MCP hard-down; the "restart 2-3 times" folklore is dice-rolling.
//
// WHY NOT JUST SAMPLE DNS REPEATEDLY. Tried first, and it does not work from
// this host: the local resolver serves a cached answer for far longer than
// the rotation interval, so 14 samples spread over 15s still returned one
// address. The sandbox sees rapid rotation only because it resolves through a
// different, uncached path. Host-side sampling therefore cannot discover the
// pool, and paying 15-35s per registration to learn nothing is worse than
// useless. dns.resolve4 is no help either -- there is no fuller RRset to
// fetch, the server genuinely returns one answer per query.
//
// THE FIX. Keep the stock lookup exactly as-is, then union in an explicit
// operator-supplied pool from EXTRA_IPS_PATH (below), keyed by hostname.
// Deterministic, adds no latency, and keeps IP pinning intact rather than
// disabling it -- allowed_ips still lists a closed set of known addresses, it
// is simply the COMPLETE set instead of one arbitrary member.
// mcp-bridge-policy-render.ts's allowedIpsForEndpoint already accepts and
// emits a list; it was only ever handed one entry.
//
// MAINTENANCE. If GitHub changes its address pool this fails the same visible
// way it did before -- an ssrf denial naming the unlisted IP. Add that IP to
// the JSON and `mcp restart`. Hosts absent from the file are untouched and
// behave exactly as stock.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveHostAddresses = resolveHostAddresses;
const promises_1 = __importDefault(require("node:dns/promises"));
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const EXTRA_IPS_PATH = path.join(os.homedir(), ".nemoclaw", "extra-allowed-ips.json");

function extraAddressesFor(hostname) {
    // Any failure here -- missing file, bad JSON, wrong shape -- must leave
    // stock behaviour intact rather than break MCP registration outright.
    // A malformed config should cost you the widened pin, not the ability to
    // register anything at all.
    try {
        const raw = fs.readFileSync(EXTRA_IPS_PATH, "utf8");
        const parsed = JSON.parse(raw);
        const entry = parsed && parsed[hostname];
        if (!Array.isArray(entry)) return [];
        return entry.filter((ip) => typeof ip === "string" && ip.length > 0);
    } catch {
        return [];
    }
}

async function resolveHostAddresses(hostname, lookup = promises_1.default.lookup) {
    const answers = await lookup(hostname, { all: true, verbatim: true });
    const extras = extraAddressesFor(hostname);
    if (extras.length === 0) return answers;

    const seen = new Map();
    // Resolved answers first so `verbatim: true`'s address-family ordering is
    // preserved for the addresses that actually came back from DNS; callers
    // treat the list as preference-ordered.
    for (const entry of answers) {
        if (entry && entry.address && !seen.has(entry.address)) seen.set(entry.address, entry);
    }
    for (const ip of extras) {
        if (!seen.has(ip)) seen.set(ip, { address: ip, family: ip.includes(":") ? 6 : 4 });
    }
    return [...seen.values()];
}
//# sourceMappingURL=resolve.js.map
