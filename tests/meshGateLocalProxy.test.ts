import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

function runHook(hook: string, input: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [hook], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(stdout) : reject(new Error(`hook exited ${code}: ${stderr}`)));
    child.stdin.end(input);
  });
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("Claude mesh gate local proxy", () => {
  it("sends only the local token to Praxis and emits a bounded advisory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mesh-gate-hook-"));
    roots.push(root);
    const tokenFile = path.join(root, "local-token");
    await writeFile(tokenFile, "L".repeat(43), { mode: 0o600 });
    let requestUrl = "";
    let authorization = "";
    const server = createServer((request, response) => {
      requestUrl = request.url ?? "";
      authorization = request.headers.authorization ?? "";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        conflict: true,
        path: "src/team.ts",
        conflicts: [{ person: "Ada", kind: "active_edit", detail: "editing the same path", ts: new Date().toISOString() }],
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const hook = path.resolve("hooks/mesh-gate.sh");
      const stdout = await runHook(hook, JSON.stringify({
          session_id: "session-1", cwd: "/work/team", tool_name: "Edit",
          tool_input: { file_path: "/work/team/src/team.ts" },
        }), {
          ...process.env,
          TMPDIR: root,
          PRAXIS_STUDIO_URL: `http://127.0.0.1:${port}`,
          PRAXIS_LOCAL_TOKEN_FILE: tokenFile,
          // These hostile inherited values must be ignored by the hook.
          MESH_URL: "https://attacker.invalid/",
          MESH_TOKEN: "hosted-secret-must-not-leave",
          MESH_PERSON: "hosted-person",
      });
      const output = JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
      expect(output.hookSpecificOutput.permissionDecision).toBe("ask");
      expect(output.hookSpecificOutput.permissionDecisionReason).toContain("Ada");
      expect(authorization).toBe(`Bearer ${"L".repeat(43)}`);
      const target = new URL(requestUrl, `http://127.0.0.1:${port}`);
      expect(target.pathname).toBe("/api/mesh/gate");
      expect(target.searchParams.get("cwd")).toBe("/work/team");
      expect(target.searchParams.get("path")).toBe("/work/team/src/team.ts");
      expect(requestUrl).not.toContain("hosted-secret");
      expect(await readFile(hook, "utf8")).not.toMatch(/MESH_(?:URL|TOKEN|PERSON)/);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
