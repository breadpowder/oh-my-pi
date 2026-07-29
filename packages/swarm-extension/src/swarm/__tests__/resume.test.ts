import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent";
import * as taskExecutor from "@oh-my-pi/pi-coding-agent";
import * as executorModule from "../executor";
import { PipelineController } from "../pipeline";
import type { SwarmDefinition } from "../schema";
import { StateTracker } from "../state";

// ============================================================================
// Shared helpers
// ============================================================================

const makeMockResult = (overrides: Partial<SingleResult> = {}): SingleResult =>
	({
		index: 0,
		id: "test-agent-0",
		agent: "test",
		agentSource: "project",
		task: "test task",
		exitCode: 0,
		output: "ok",
		stderr: "",
		truncated: false,
		durationMs: 100,
		tokens: 0,
		requests: 0,
		...overrides,
	}) as SingleResult;

let workspace: string;

beforeEach(async () => {
	workspace = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-resume-test-"));
});

afterEach(async () => {
	vi.restoreAllMocks();
	await fs.rm(workspace, { recursive: true, force: true });
});

// ============================================================================
// StateTracker.load() returns previously saved state
// ============================================================================

describe("StateTracker.load()", () => {
	it("returns null when no pipeline.json exists", async () => {
		const tracker = new StateTracker(workspace, "test-swarm");
		const result = await tracker.load();
		expect(result).toBeNull();
	});

	it("returns previously saved state after init + updates", async () => {
		const tracker = new StateTracker(workspace, "test-swarm");
		await tracker.init(["coder", "reviewer"], 2, "sequential");
		await tracker.updateAgent("coder", {
			status: "completed",
			iteration: 0,
			wave: 0,
			completedAt: Date.now(),
		});
		await tracker.updatePipeline({ iteration: 1, status: "running" });

		// Create a new tracker pointing at the same dir and load
		const tracker2 = new StateTracker(workspace, "test-swarm");
		const loaded = await tracker2.load();

		expect(loaded).not.toBeNull();
		expect(loaded!.name).toBe("test-swarm");
		expect(loaded!.status).toBe("running");
		expect(loaded!.iteration).toBe(1);
		expect(loaded!.agents.coder.status).toBe("completed");
		expect(loaded!.agents.coder.iteration).toBe(0);
		expect(loaded!.agents.reviewer.status).toBe("pending");
	});
});

// ============================================================================
// PipelineController resume: skip completed agents on iteration 0
// ============================================================================

describe("PipelineController — resume from checkpoint", () => {
	const buildDef = (): SwarmDefinition => ({
		name: "resume-swarm",
		workspace,
		mode: "sequential",
		targetCount: 1,
		agents: new Map([
			[
				"coder",
				{
					name: "coder",
					role: "coder",
					task: "write code",
					reportsTo: [],
					waitsFor: [],
				},
			],
			[
				"reviewer",
				{
					name: "reviewer",
					role: "reviewer",
					task: "review code",
					reportsTo: [],
					waitsFor: ["coder"],
				},
			],
		]),
		agentOrder: ["coder", "reviewer"],
	});

	it("skips completed agents on iteration 0 when fromAgent is set", async () => {
		// Mock executeSwarmAgent to track calls
		const executeSpy = vi
			.spyOn(executorModule, "executeSwarmAgent")
			.mockResolvedValue(makeMockResult({ agent: "reviewer", output: "reviewed" }));

		// Create a state tracker and simulate a prior run where coder completed
		const tracker = new StateTracker(workspace, "resume-swarm");
		await tracker.init(["coder", "reviewer"], 1, "sequential");
		await tracker.updateAgent("coder", {
			status: "completed",
			iteration: 0,
			wave: 0,
			completedAt: Date.now(),
		});
		// reviewer is still pending

		const def = buildDef();
		const controller = new PipelineController(def, [["coder"], ["reviewer"]], tracker);
		await controller.run({ workspace, fromAgent: "coder" });

		// executeSwarmAgent should NOT have been called for coder
		// It should have been called only for reviewer
		const agentNamesCalled = executeSpy.mock.calls.map((call) => call[0].name);
		expect(agentNamesCalled).not.toContain("coder");
		expect(agentNamesCalled).toContain("reviewer");
	});

	it("does NOT skip completed agents on iteration > 0", async () => {
		const executeSpy = vi
			.spyOn(executorModule, "executeSwarmAgent")
			.mockResolvedValue(makeMockResult({ agent: "coder", output: "rerun" }));

		const tracker = new StateTracker(workspace, "resume-swarm");
		await tracker.init(["coder"], 2, "sequential");
		// Mark coder as completed on iteration 0
		await tracker.updateAgent("coder", {
			status: "completed",
			iteration: 0,
			wave: 0,
			completedAt: Date.now(),
		});
		// Advance pipeline to iteration 1
		await tracker.updatePipeline({ iteration: 1 });

		const def = buildDef();
		def.targetCount = 2;
		const controller = new PipelineController(def, [["coder"]], tracker);
		await controller.run({ workspace, fromAgent: "coder" });

		// On iteration > 0, even completed agents should be re-executed
		// The spy should have been called for iteration 1
		const coderCalls = executeSpy.mock.calls.filter((call) => call[0].name === "coder");
		expect(coderCalls.length).toBeGreaterThan(0);
	});

	it("does NOT skip when fromAgent is undefined", async () => {
		const executeSpy = vi
			.spyOn(executorModule, "executeSwarmAgent")
			.mockResolvedValue(makeMockResult({ agent: "coder", output: "fresh" }));

		const tracker = new StateTracker(workspace, "resume-swarm");
		await tracker.init(["coder", "reviewer"], 1, "sequential");
		// Mark coder as completed (simulating some prior state)
		await tracker.updateAgent("coder", {
			status: "completed",
			iteration: 0,
			wave: 0,
			completedAt: Date.now(),
		});

		const def = buildDef();
		const controller = new PipelineController(def, [["coder"], ["reviewer"]], tracker);
		// No fromAgent — should run everything
		await controller.run({ workspace });

		// Both agents should have been executed
		const agentNamesCalled = executeSpy.mock.calls.map((call) => call[0].name);
		expect(agentNamesCalled).toContain("coder");
		expect(agentNamesCalled).toContain("reviewer");
	});

	it("returns cached result for skipped completed agent", async () => {
		const executeSpy = vi
			.spyOn(executorModule, "executeSwarmAgent")
			.mockResolvedValue(makeMockResult({ agent: "reviewer", output: "reviewed" }));

		const tracker = new StateTracker(workspace, "resume-swarm");
		await tracker.init(["coder", "reviewer"], 1, "sequential");
		await tracker.updateAgent("coder", {
			status: "completed",
			iteration: 0,
			wave: 0,
			completedAt: Date.now(),
		});

		const def = buildDef();
		const controller = new PipelineController(def, [["coder"], ["reviewer"]], tracker);
		const result = await controller.run({ workspace, fromAgent: "coder" });

		// The skipped agent should still have a result in agentResults
		const coderResults = result.agentResults.get("coder");
		expect(coderResults).not.toBeNull();
		expect(coderResults!.length).toBe(1);
		expect(coderResults![0].exitCode).toBe(0);
	});
});
