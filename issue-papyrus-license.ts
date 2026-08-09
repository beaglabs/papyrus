// issue-papyrus-license.ts
import {
  createPrivateKey,
  randomUUID,
  sign,
} from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

type NetworkProfile =
  | "commercial"
  | "niprnet-il4"
  | "siprnet-il6";

interface ActivationRequest {
  deploymentId: string;
  deploymentPublicKey: string;
  profile: NetworkProfile;
}

interface LicensePayload {
  licenseId: string;
  licensee: string;
  profile: NetworkProfile;
  deploymentId: string;
  issuedAt: string;
  expiresAt: string | null;
}

function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort();

  return `{${keys
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson(object[key])}`,
    )
    .join(",")}}`;
}

const requestPath = process.argv[2];
const outputPath = process.argv[3] ?? "papyrus-license.json";
const licensee = process.env.PAPYRUS_LICENSEE;
const privateKeyPath = process.env.PAPYRUS_LICENSE_PRIVATE_KEY;

if (!requestPath || !licensee || !privateKeyPath) {
  console.error(
    "Usage: PAPYRUS_LICENSE_PRIVATE_KEY=<path> " +
      "PAPYRUS_LICENSEE=<name> node --experimental-strip-types " +
      "issue-papyrus-license.ts <request.json> [output.json]",
  );
  process.exit(1);
}

const request = JSON.parse(
  readFileSync(requestPath, "utf8"),
) as ActivationRequest;

const issuedAt = new Date();
const expiresAt = new Date(issuedAt);
expiresAt.setUTCDate(expiresAt.getUTCDate() + 90);

const payload: LicensePayload = {
  licenseId: `papyrus-${randomUUID()}`,
  licensee,
  profile: request.profile,
  deploymentId: request.deploymentId,
  issuedAt: issuedAt.toISOString(),
  expiresAt: expiresAt.toISOString(),
};

const privateKey = createPrivateKey(
  readFileSync(privateKeyPath, "utf8"),
);

const signature = sign(
  null,
  Buffer.from(canonicalJson(payload), "utf8"),
  privateKey,
).toString("base64");

const license = {
  ...payload,
  signature,
};

writeFileSync(outputPath, JSON.stringify(license, null, 2), {
  encoding: "utf8",
  mode: 0o600,
});

console.log(`Issued: ${license.licenseId}`);
console.log(`Licensee: ${license.licensee}`);
console.log(`Profile: ${license.profile}`);
console.log(`Deployment: ${license.deploymentId}`);
console.log(`Expires: ${license.expiresAt}`);
console.log(`Output: ${outputPath}`);
