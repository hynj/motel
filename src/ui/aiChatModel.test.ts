import { describe, expect, it } from "bun:test"
import {
	buildChunks,
	type Chunk,
	isChunkExpanded,
	renderChunks,
	toggleChunkExpansion,
} from "./aiChatModel.ts"

const makeDetail = (messages: unknown, responseText: string | null = null) => ({
	promptMessages: messages,
	responseText,
})

const findByKind = (chunks: readonly Chunk[], kind: Chunk["kind"]) =>
	chunks.filter((c) => c.kind === kind)

describe("buildChunks", () => {
	it("returns no chunks for a null detail", () => {
		expect(buildChunks(null).length).toBe(0)
	})

	it("unwraps the `{ messages: [...] }` Vercel AI SDK shape", () => {
		const chunks = buildChunks(
			makeDetail({ messages: [{ role: "user", content: "hi" }] }),
		)
		expect(chunks.length).toBe(1)
		expect(chunks[0]!.kind).toBe("user-text")
		expect(chunks[0]!.body).toBe("hi")
	})

	it("accepts a bare message array", () => {
		const chunks = buildChunks(
			makeDetail([{ role: "assistant", content: "hello" }]),
		)
		expect(chunks[0]!.kind).toBe("assistant-text")
		expect(chunks[0]!.body).toBe("hello")
	})

	it("marks system prompts collapsible + default-collapsed", () => {
		const chunks = buildChunks(
			makeDetail([{ role: "system", content: "you are helpful" }]),
		)
		expect(chunks[0]!.kind).toBe("system")
		expect(chunks[0]!.collapsible).toBe(true)
		expect(chunks[0]!.collapsedByDefault).toBe(true)
	})

	it("builds a tool-call chunk with inline summary in the header", () => {
		const chunks = buildChunks(
			makeDetail([
				{
					role: "assistant",
					content: [
						{ type: "tool-call", toolName: "read", input: { filePath: "/tmp/x.ts" } },
					],
				},
			]),
		)
		const tc = findByKind(chunks, "tool-call")[0]!
		expect(tc.header).toContain("read")
		expect(tc.header).toContain("/tmp/x.ts")
		expect(tc.toolName).toBe("read")
	})

	it("strips noisy infra fields from bash tool summaries", () => {
		const chunks = buildChunks(
			makeDetail([
				{
					role: "assistant",
					content: [
						{
							type: "tool-call",
							toolName: "bash",
							input: {
								command: "git status --short",
								timeout: 120_000,
								workdir: "/home/me",
								description: "ignored",
							},
						},
					],
				},
			]),
		)
		const tc = findByKind(chunks, "tool-call")[0]!
		expect(tc.header).toContain("git status --short")
		expect(tc.header).not.toContain("timeout")
		expect(tc.header).not.toContain("workdir")
	})

	it("summarises todowrite with a count", () => {
		const chunks = buildChunks(
			makeDetail([
				{
					role: "assistant",
					content: [{ type: "tool-call", toolName: "todowrite", input: { todos: [{}, {}, {}] } }],
				},
			]),
		)
		expect(findByKind(chunks, "tool-call")[0]!.header).toContain("3 todos")
	})

	it("scrubs base64 data URLs from user content", () => {
		const big = "a".repeat(400)
		const chunks = buildChunks(
			makeDetail([
				{
					role: "user",
					content: [{ type: "text", text: `look at data:image/png;base64,${big} thanks` }],
				},
			]),
		)
		const body = chunks[0]!.body
		expect(body).not.toContain("aaaaaaaaaa")
		expect(body).toContain("[data:image/png base64")
	})

	it("collapses long tool results by default", () => {
		const longOutput = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n")
		const chunks = buildChunks(
			makeDetail([
				{
					role: "tool",
					content: [
						{
							type: "tool-result",
							toolName: "bash",
							output: { type: "text", value: longOutput },
						},
					],
				},
			]),
		)
		const tr = findByKind(chunks, "tool-result")[0]!
		expect(tr.collapsible).toBe(true)
		expect(tr.collapsedByDefault).toBe(true)
	})

	it("keeps short tool results expanded by default", () => {
		const chunks = buildChunks(
			makeDetail([
				{
					role: "tool",
					content: [
						{ type: "tool-result", toolName: "bash", output: { type: "text", value: "ok" } },
					],
				},
			]),
		)
		const tr = findByKind(chunks, "tool-result")[0]!
		expect(tr.collapsedByDefault).toBe(false)
	})

	it("appends a response chunk when responseText is set", () => {
		const chunks = buildChunks(
			makeDetail([{ role: "user", content: "hi" }], "final answer"),
		)
		const response = findByKind(chunks, "response")[0]!
		expect(response.body).toBe("final answer")
	})

	it("falls back to a raw-prompt chunk when messages is a plain string", () => {
		const chunks = buildChunks(makeDetail("bare prompt string"))
		expect(chunks[0]!.kind).toBe("raw-prompt")
		expect(chunks[0]!.body).toBe("bare prompt string")
	})

	it("gives each chunk a stable id keyed by message + part index", () => {
		const chunks = buildChunks(
			makeDetail([
				{ role: "user", content: "a" },
				{
					role: "assistant",
					content: [
						{ type: "tool-call", toolName: "read", input: { filePath: "/x" } },
						{ type: "tool-call", toolName: "read", input: { filePath: "/y" } },
					],
				},
			]),
		)
		const ids = chunks.map((c) => c.id)
		expect(new Set(ids).size).toBe(ids.length)
		// Second assistant part gets messageIndex=1, partIndex=1.
		expect(chunks.find((c) => c.id === "m1p1")).toBeDefined()
	})
})

describe("isChunkExpanded + toggleChunkExpansion", () => {
	const makeChunk = (over: Partial<Chunk> = {}): Chunk => ({
		id: "x",
		kind: "reasoning",
		role: "assistant",
		messageIndex: 0,
		partIndex: 0,
		header: "reasoning",
		headerMeta: null,
		body: "thinking",
		needsHeader: true,
		collapsible: true,
		collapsedByDefault: true,
		...over,
	})

	it("non-collapsible chunks are always expanded", () => {
		const chunk = makeChunk({ collapsible: false, collapsedByDefault: false })
		expect(isChunkExpanded(chunk, new Set())).toBe(true)
	})

	it("default-collapsed chunks need a positive override to expand", () => {
		const chunk = makeChunk({ collapsedByDefault: true })
		expect(isChunkExpanded(chunk, new Set())).toBe(false)
		expect(isChunkExpanded(chunk, new Set(["x"]))).toBe(true)
	})

	it("default-open chunks need a negative override to collapse", () => {
		const chunk = makeChunk({ collapsedByDefault: false })
		expect(isChunkExpanded(chunk, new Set())).toBe(true)
		expect(isChunkExpanded(chunk, new Set(["!x"]))).toBe(false)
	})

	it("toggleChunkExpansion flips visibility per chunk", () => {
		const chunk = makeChunk({ collapsedByDefault: true })
		const once = toggleChunkExpansion(chunk, new Set())
		expect(isChunkExpanded(chunk, once)).toBe(true)
		const twice = toggleChunkExpansion(chunk, once)
		expect(isChunkExpanded(chunk, twice)).toBe(false)
	})
})

describe("renderChunks", () => {
	it("emits a role divider when the role changes", () => {
		const chunks = buildChunks(
			makeDetail([
				{ role: "user", content: "hi" },
				{ role: "assistant", content: "hello" },
			]),
		)
		const lines = renderChunks(chunks, { width: 80, expanded: new Set() })
		const dividers = lines.filter((l) => l.kind === "role-divider")
		expect(dividers.length).toBe(2)
	})

	it("hides bodies for collapsed chunks (no per-chunk expand hint)", () => {
		const chunks = buildChunks(
			makeDetail([
				{ role: "system", content: "long system prompt here " .repeat(5) },
				{ role: "user", content: "hi" },
			]),
		)
		const lines = renderChunks(chunks, { width: 80, expanded: new Set() })
		const systemChunkId = chunks.find((c) => c.kind === "system")!.id
		const systemBodyLines = lines.filter((l) => l.chunkId === systemChunkId && l.kind === "text")
		// Collapsed: only the chunk-header line survives, no body text
		// and no "enter to expand" filler (the bottom footer carries the
		// global keyboard hint now).
		expect(systemBodyLines.length).toBe(0)
		const systemHeaders = lines.filter((l) => l.chunkId === systemChunkId && l.kind === "chunk-header")
		expect(systemHeaders.length).toBe(1)
	})

	it("renders role dividers on turn boundaries", () => {
		const chunks = buildChunks(
			makeDetail([
				{ role: "user", content: "hi" },
				{ role: "assistant", content: "hello" },
				{ role: "user", content: "thanks" },
			]),
		)
		const lines = renderChunks(chunks, { width: 80, expanded: new Set() })
		const dividers = lines.filter((l) => l.kind === "role-divider").map((l) => l.text)
		expect(dividers).toEqual(["USER", "ASSISTANT", "USER"])
	})

	it("omits chunk-header rows for plain text chunks (user/assistant/response)", () => {
		const chunks = buildChunks(
			makeDetail([
				{ role: "user", content: "hi" },
				{ role: "assistant", content: "hello" },
			], "final"),
		)
		const lines = renderChunks(chunks, { width: 80, expanded: new Set() })
		// No chunk-header rows should exist for the user-text / assistant-text / response chunks.
		const plainTextChunkIds = chunks
			.filter((c) => ["user-text", "assistant-text", "response"].includes(c.kind))
			.map((c) => c.id)
		const headersForPlainText = lines.filter(
			(l) => l.kind === "chunk-header" && plainTextChunkIds.includes(l.chunkId ?? ""),
		)
		expect(headersForPlainText.length).toBe(0)
	})

	it("annotates each line with its chunkId so selection can find it", () => {
		const chunks = buildChunks(
			makeDetail([{ role: "user", content: "hi" }]),
		)
		const lines = renderChunks(chunks, { width: 80, expanded: new Set() })
		const userChunkId = chunks[0]!.id
		const taggedLines = lines.filter((l) => l.chunkId === userChunkId)
		expect(taggedLines.length).toBeGreaterThan(0)
	})
})
