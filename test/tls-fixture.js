import { request as httpsRequest } from "node:https";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function tlsFixture(directory, prefix = "test") {
  const certFile = join(directory, `${prefix}-cert.pem`);
  const keyFile = join(directory, `${prefix}-key.pem`);
  await promisify(execFile)(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyFile,
      "-out",
      certFile,
      "-days",
      "2",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,DNS:feature.localhost,DNS:second.localhost,DNS:api.feature.localhost,IP:127.0.0.1,IP:::1",
    ],
    { timeout: 10000 },
  );
  return {
    certFile,
    keyFile,
    cert: await readFile(certFile, "utf8"),
    key: await readFile(keyFile, "utf8"),
  };
}

export function secureRequest(
  port,
  cert,
  path = "/",
  hostname = "feature.localhost",
  extra = {},
) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: "127.0.0.1",
        servername: hostname,
        port,
        path,
        ca: cert,
        headers: { host: `${hostname}:${port}`, connection: "close" },
        ...extra,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body }),
        );
      },
    );
    req.on("error", reject);
    req.setTimeout(5000, () =>
      req.destroy(new Error("TLS test request timed out")),
    );
    req.end();
  });
}
