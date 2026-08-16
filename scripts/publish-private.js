#!/usr/bin/env node

// Publishes every npm package in this repository to a private registry.
//
// The public release goes to npmjs.com through `npm publish` and needs nothing written down
// here. A private mirror is the other case: an organisation that cannot reach npmjs.com
// still needs these packages, and pointing `publishConfig.registry` at that organisation's
// Nexus would send the public release there too.
//
// So the registry and its credentials live outside the packages, in the environment:
//
//   PLUGWRIGHT_NPM_REGISTRY   registry URL (default: the HolyWorld Nexus mirror)
//   PLUGWRIGHT_NPM_USER       registry username, or NEXUS_USERNAME
//   PLUGWRIGHT_NPM_PASSWORD   registry password, or NEXUS_PASSWORD
//   PLUGWRIGHT_NPM_TAG        dist-tag to publish under (default: latest)
//
// Nexus answers a bearer `_authToken` with 401, so the credentials go in as the Basic
// `_auth` pair it does accept. They are written to a temporary npm config outside the
// working tree and passed with `--userconfig`, so nothing lands in a file the repository
// could commit.

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PACKAGES = [
    "runner-package",
    "auth-authme-package",
    "console-rcon-package",
];

const DEFAULT_REGISTRY = "https://repo.holyworld.me/repository/npm-public/";

function main() {
    const registry = process.env.PLUGWRIGHT_NPM_REGISTRY || DEFAULT_REGISTRY;
    const user = process.env.PLUGWRIGHT_NPM_USER || process.env.NEXUS_USERNAME;
    const password = process.env.PLUGWRIGHT_NPM_PASSWORD || process.env.NEXUS_PASSWORD;
    const tag = process.env.PLUGWRIGHT_NPM_TAG || "latest";

    if (!user || !password) {
        console.error(
            "No registry credentials. Set PLUGWRIGHT_NPM_USER and PLUGWRIGHT_NPM_PASSWORD " +
            "(or NEXUS_USERNAME and NEXUS_PASSWORD)."
        );
        process.exit(1);
    }

    const version = fs.readFileSync("version.txt", "utf8").trim();
    console.log(`Publishing ${version} to ${registry} under the "${tag}" tag\n`);

    // The path in the key has to match the registry's, minus the protocol — npm looks the
    // credentials up by that path and silently sends none when it does not match.
    const authKey = registry.replace(/^https?:/, "");
    const npmrc = [
        `registry=${registry}`,
        `${authKey}:_auth=${Buffer.from(`${user}:${password}`).toString("base64")}`,
        `${authKey}:always-auth=true`,
        "",
    ].join("\n");

    const configFile = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "plugwright-publish-")),
        "npmrc"
    );
    fs.writeFileSync(configFile, npmrc, { mode: 0o600 });

    try {
        for (const pkg of PACKAGES) {
            const name = JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf8")).name;
            console.log(`\n=== ${name}@${version}`);
            execFileSync(
                process.platform === "win32" ? "npm.cmd" : "npm",
                ["publish", "--userconfig", configFile, "--registry", registry, "--tag", tag],
                { cwd: pkg, stdio: "inherit" }
            );
        }
    } finally {
        // Credentials, so they go whether the publish worked or not.
        fs.rmSync(path.dirname(configFile), { recursive: true, force: true });
    }

    console.log(`\nPublished ${version} to ${registry}`);
}

main();
