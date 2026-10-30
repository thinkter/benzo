import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createGateway } from "../src/core.js";
import { tlsFixture } from "./tls-fixture.js";

const exec = promisify(execFile);
const cli = resolve("src/cli.js");
const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server) =>
  new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
async function freePort() {
  const server = createServer();
  await listen(server);
  const port = server.address().port;
  await close(server);
  return port;
}
async function waitFor(check) {
  const deadline = Date.now() + 15000;
  let error;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (value) {
      error = value;
    }
    await delay(80);
  }
  throw error ?? new Error("Client fixture readiness timed out");
}
function get(port, host = "localhost") {
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: "127.0.0.1", port, headers: { host, connection: "close" } },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      },
    );
    req.setTimeout(2000, () =>
      req.destroy(new Error("Client fixture request timeout")),
    );
    req.on("error", reject);
    req.end();
  });
}

test(
  "Go client verifies the HTTPS certificate and hostname without insecure TLS options",
  { timeout: 120000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "benzo-go-client-"));
    let app, gateway;
    try {
      const version = await exec("go", ["version"]);
      t.diagnostic(version.stdout.trim());
      const tls = await tlsFixture(directory);
      const source = join(directory, "client.go");
      const binary = join(
        directory,
        process.platform === "win32" ? "client.exe" : "client",
      );
      await writeFile(
        source,
        `package main
import("context";"crypto/tls";"crypto/x509";"fmt";"io";"net";"net/http";"os";"time")
func main(){
 pool:=x509.NewCertPool()
 if os.Args[4]=="trusted" { pem,err:=os.ReadFile(os.Args[1]);if err!=nil||!pool.AppendCertsFromPEM(pem){fmt.Fprintln(os.Stderr,"invalid test CA");os.Exit(1)} }
 transport:=&http.Transport{TLSClientConfig:&tls.Config{RootCAs:pool,MinVersion:tls.VersionTLS12},DialContext:func(ctx context.Context,network,addr string)(net.Conn,error){return (&net.Dialer{}).DialContext(ctx,"tcp",os.Args[3])}}
 defer transport.CloseIdleConnections()
 client:=&http.Client{Transport:transport,Timeout:5*time.Second}
 response,err:=client.Get(os.Args[2]);if err!=nil{fmt.Fprintln(os.Stderr,err);os.Exit(1)}
 defer response.Body.Close();if response.StatusCode!=200{os.Exit(2)};io.Copy(os.Stdout,response.Body)
}
`,
      );
      await exec("go", ["build", "-o", binary, source], {
        timeout: 90000,
        env: { ...process.env, GOTOOLCHAIN: "local" },
      });
      app = createServer((req, res) =>
        res.end(
          JSON.stringify({
            host: req.headers.host,
            protocol: req.headers["x-forwarded-proto"],
          }),
        ),
      );
      await listen(app);
      gateway = createGateway({
        port: 0,
        tls: { cert: tls.cert, key: tls.key },
        routes: new Map([["feature.localhost", app.address().port]]),
      });
      await gateway.listen();
      const port = gateway.server.address().port;
      const origin = `https://feature.localhost:${port}`;
      const dial = `127.0.0.1:${port}`;
      const trusted = await exec(binary, [
        tls.certFile,
        origin,
        dial,
        "trusted",
      ]);
      assert.deepEqual(JSON.parse(trusted.stdout), {
        host: `feature.localhost:${port}`,
        protocol: "https",
      });
      await assert.rejects(
        exec(binary, [tls.certFile, origin, dial, "untrusted"]),
        /unknown authority/,
      );
      await assert.rejects(
        exec(binary, [
          tls.certFile,
          `https://wrong.localhost:${port}`,
          dial,
          "trusted",
        ]),
        /not wrong.localhost/,
      );
    } finally {
      await gateway?.close();
      if (app) await close(app);
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "Python original baseline and two bare Benzo launches preserve content, isolation and cleanup",
  { timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "benzo-python-client-"));
    const first = join(root, "a", "site"),
      second = join(root, "b", "site");
    const home = join(root, "benzo-home");
    const children = [];
    const env = { ...process.env, BENZO_HOME: home };
    const call = (cwd, ...args) =>
      exec(process.execPath, [cli, ...args], { cwd, env, timeout: 10000 });
    function start(command, args, cwd) {
      const child = spawn(command, args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(child);
      child.stdout.resume();
      child.stderr.resume();
      child.done = new Promise((resolve) => {
        child.once("exit", (code) => resolve(code));
        child.once("error", (error) => resolve(error));
      });
      return child;
    }
    try {
      t.diagnostic((await exec("python3", ["--version"])).stdout.trim());
      for (const [directory, content] of [
        [first, "first"],
        [second, "second"],
      ]) {
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "index.html"), content);
      }
      const baselinePort = await freePort();
      const baseline = start(
        "python3",
        ["-m", "http.server", String(baselinePort), "--bind", "127.0.0.1"],
        first,
      );
      assert.equal((await waitFor(() => get(baselinePort))).body, "first");
      baseline.kill("SIGTERM");
      await baseline.done;
      await assert.rejects(get(baselinePort));
      const port = await freePort();
      const manifest = join(root, "python.json");
      await writeFile(
        manifest,
        JSON.stringify({
          gateway: { port },
          services: [
            {
              name: "web",
              command: "python3",
              args: ["-m", "http.server", "{port}", "--bind", "127.0.0.1"],
            },
          ],
        }),
      );
      for (const cwd of [first, second])
        await call(cwd, "link", "--config", manifest);
      const one = start(process.execPath, [cli], first);
      const descriptor = async (cwd) => {
        const value = JSON.parse(
          (await call(cwd, "describe", "--json")).stdout,
        );
        return value?.status === "ready" ? value : undefined;
      };
      const a = await waitFor(() => descriptor(first));
      const two = start(process.execPath, [cli], second);
      const b = await waitFor(() => descriptor(second));
      assert.equal(a.name, "site");
      assert.equal(b.name, "site-2");
      const webA = a.services[0],
        webB = b.services[0];
      assert.notEqual(webA.origin, webB.origin);
      assert.notEqual(webA.upstream.port, webB.upstream.port);
      assert.equal((await get(port, new URL(webA.origin).host)).body, "first");
      assert.equal((await get(port, new URL(webB.origin).host)).body, "second");
      await writeFile(join(first, "index.html"), "updated");
      assert.equal(
        (await get(port, new URL(webA.origin).host)).body,
        "updated",
      );
      assert.equal((await get(port, new URL(webB.origin).host)).body, "second");
      await writeFile(join(first, "index.html"), "first");
      await call(first, "stop");
      assert.equal(await one.done, 0);
      await assert.rejects(get(webA.upstream.port));
      assert.equal((await get(port, new URL(webB.origin).host)).body, "second");
      await call(second, "stop");
      assert.equal(await two.done, 0);
      await waitFor(async () => {
        try {
          await get(port);
          return false;
        } catch {
          return true;
        }
      });
      for (const [directory, content] of [
        [first, "first"],
        [second, "second"],
      ]) {
        assert.deepEqual(await readdir(directory), ["index.html"]);
        assert.equal(
          await readFile(join(directory, "index.html"), "utf8"),
          content,
        );
      }
    } finally {
      for (const cwd of [first, second])
        await call(cwd, "stop").catch(() => {});
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGTERM");
        await child.done;
      }
      await delay(1000);
      await rm(root, { recursive: true, force: true });
    }
  },
);
