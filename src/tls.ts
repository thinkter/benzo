import { createHash, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createSecureContext } from "node:tls";

export function gatewayTransport(gateway, cwd) {
  if (!gateway.tls) return { identity: "http", protocol: "http" };
  let cert, key;
  try {
    cert = readFileSync(resolve(cwd, gateway.tls.certFile), "utf8");
    key = readFileSync(resolve(cwd, gateway.tls.keyFile), "utf8");
    const certificate = new X509Certificate(cert);
    if (
      Date.now() < Date.parse(certificate.validFrom) ||
      Date.now() > Date.parse(certificate.validTo)
    )
      throw new Error();
    createSecureContext({ cert, key, minVersion: "TLSv1.2" });
  } catch {
    throw new Error(
      "Cannot load gateway TLS certificate/key. Supply readable, currently valid, matching PEM files; encrypted keys are not supported.",
    );
  }
  return {
    protocol: "https",
    identity: `https:${createHash("sha256").update(cert).digest("hex")}`,
    tls: { cert, key, minVersion: "TLSv1.2" },
  };
}
