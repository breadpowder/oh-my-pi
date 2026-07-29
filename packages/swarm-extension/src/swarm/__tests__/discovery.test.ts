import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { discoverSwarmYaml, resolveSwarmYamlPath, substituteVars } from "../discovery";

// ============================================================================
// A1 — Named-workflow → ~/.omp/agent/swarms/<name>.yaml
// ============================================================================
describe("resolveSwarmYamlPath — Option A discovery", () => {
	it("resolves a named workflow (no slash, no extension) to user-level path", () => {
		const resolved = resolveSwarmYamlPath("my-workflow");
		expect(resolved).toContain(".omp/agent/swarms/my-workflow.yaml");
	});

	it("treats an absolute path as-is (no discovery)", () => {
		const resolved = resolveSwarmYamlPath("/tmp/my-workflow.yaml");
		expect(resolved).toBe("/tmp/my-workflow.yaml");
	});

	it("treats a .yaml path as-is (no discovery)", () => {
		const resolved = resolveSwarmYamlPath("./my-workflow.yaml");
		expect(resolved).toBe("./my-workflow.yaml");
	});

	it("resolves name with dots and hyphens", () => {
		const resolved = resolveSwarmYamlPath("dev-workflow.v2");
		expect(resolved).toContain(".omp/agent/swarms/dev-workflow.v2.yaml");
	});
});

// ============================================================================
// A2 — ${VAR} substitution
// ============================================================================
describe("substituteVars — ${VAR} substitution", () => {
	it("substitutes PROJECT_DIR", () => {
		const yaml = "workspace: ${PROJECT_DIR}/src";
		const result = substituteVars(yaml, { PROJECT_DIR: "/tmp/proj" });
		expect(result).toBe("workspace: /tmp/proj/src");
	});

	it("substitutes WORKFLOW_NAME", () => {
		const yaml = 'name: "${WORKFLOW_NAME}"';
		const result = substituteVars(yaml, { WORKFLOW_NAME: "auth-impl" });
		expect(result).toBe('name: "auth-impl"');
	});

	it("substitutes multiple variables", () => {
		const yaml = 'name: "${WORKFLOW_NAME}"\nworkspace: ${PROJECT_DIR}/wt';
		const result = substituteVars(yaml, {
			PROJECT_DIR: "/tmp/proj",
			WORKFLOW_NAME: "auth-impl",
		});
		expect(result).toContain('name: "auth-impl"');
		expect(result).toContain("workspace: /tmp/proj/wt");
	});

	it("leaves unmatched ${VAR} literal", () => {
		const yaml = "task: review ${OTHER_VAR} code";
		const result = substituteVars(yaml, { PROJECT_DIR: "/tmp" });
		expect(result).toBe("task: review ${OTHER_VAR} code");
	});

	it("handles variables inside quoted strings", () => {
		const yaml = 'task: "Use ${PROJECT_DIR} as base"';
		const result = substituteVars(yaml, { PROJECT_DIR: "/tmp/proj" });
		expect(result).toBe('task: "Use /tmp/proj as base"');
	});

	it("handles variables in YAML values without quotes", () => {
		const yaml = "workspace: ${PROJECT_DIR}/wt/auth";
		const result = substituteVars(yaml, { PROJECT_DIR: "/tmp/proj" });
		expect(result).toBe("workspace: /tmp/proj/wt/auth");
	});
});

// ============================================================================
// A3 — Discovery → Schema (combined end-to-end)
// ============================================================================
describe("discoverSwarmYaml — end-to-end discovery + substitution + parsing", () => {
	it("resolves named workflow, substitutes vars, and parses to typed SwarmAgent[]", async () => {
		const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-discovery-test-"));
		try {
			const swarmDir = path.join(tmpHome, ".omp", "agent", "swarms");
			await fs.mkdir(swarmDir, { recursive: true });
			const yamlPath = path.join(swarmDir, "test-dev-workflow.yaml");

			const yamlContent = [
				"swarm:",
				'  name: "${WORKFLOW_NAME}"',
				"  workspace: ${PROJECT_DIR}/.swarm_test",
				"  mode: pipeline",
				"  target_count: 1",
				"  agents:",
				"    coder:",
				'      role: "developer"',
				'      task: "Implement feature in ${PROJECT_DIR}/src"',
			].join("\n");
			await fs.writeFile(yamlPath, yamlContent);

			const def = await discoverSwarmYaml("test-dev-workflow", {
				homeOverride: tmpHome,
				projectDir: "/tmp/test-proj",
				workflowName: "run-1",
			});

			expect(def.name).toBe("run-1");
			expect(def.workspace).toBe("/tmp/test-proj/.swarm_test");

			const coder = def.agents.get("coder");
			expect(coder).toBeDefined();
			expect(coder?.task).toBe("Implement feature in /tmp/test-proj/src");
		} finally {
			await fs.rm(tmpHome, { recursive: true, force: true });
		}
	});

	it("project-level decoy is never read (A1 acceptance)", async () => {
		const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-discovery-test-"));
		try {
			const swarmDir = path.join(tmpHome, ".omp", "agent", "swarms");
			await fs.mkdir(swarmDir, { recursive: true });
			const yamlPath = path.join(swarmDir, "decoy-test.yaml");

			const realYaml = [
				"swarm:",
				'  name: "real"',
				"  workspace: /tmp/real",
				"  mode: pipeline",
				"  target_count: 1",
				"  agents:",
				"    coder:",
				'      role: "developer"',
				'      task: "real task"',
			].join("\n");
			await fs.writeFile(yamlPath, realYaml);

			const decoyDir = "/tmp/decoy-project/.omp/swarms";
			const decoyPath = path.join(decoyDir, "decoy-test.yaml");
			const decoyYaml = [
				"swarm:",
				'  name: "decoy"',
				"  workspace: /tmp/decoy",
				"  mode: pipeline",
				"  target_count: 1",
				"  agents:",
				"    coder:",
				'      role: "developer"',
				'      task: "decoy task"',
			].join("\n");
			await fs.mkdir(decoyDir, { recursive: true });
			await fs.writeFile(decoyPath, decoyYaml);

			try {
				const def = await discoverSwarmYaml("decoy-test", {
					homeOverride: tmpHome,
					projectDir: "/tmp/decoy-project",
				});

				expect(def.name).toBe("real");
				expect(def.workspace).toBe("/tmp/real");
				expect(def.agents.get("coder")?.task).toBe("real task");
			} finally {
				try {
					await fs.unlink(decoyPath);
				} catch {
					// ignore
				}
			}
		} finally {
			await fs.rm(tmpHome, { recursive: true, force: true });
		}
	});
});
