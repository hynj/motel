import { TextAttributes } from "@opentui/core"
import { useMemo } from "react"
import { isAiSpan, type TraceSpanItem } from "../domain.ts"
import {
	type ChatLine,
	type ChatLineKind,
	type Chunk,
	chunkHeaderLineIndex,
	isChunkExpanded,
	renderChunks,
	type Role,
} from "./aiChatModel.ts"
import { formatDuration } from "./format.ts"
import { AlignedHeaderLine, BlankRow, Divider, PlainLine, TextLine } from "./primitives.tsx"
import type { AiCallDetailState } from "./state.ts"
import { colors, SEPARATOR } from "./theme.ts"

/** Header rows above the chat transcript: title + summary strip. */
export const AI_CHAT_HEADER_ROWS = 4

/** Colors for role labels and left-edge rails. */
const roleColor = (role: Role): string => {
	switch (role) {
		case "user": return colors.accent
		case "assistant": return colors.text
		case "system": return colors.muted
		case "tool": return colors.passing
		case "response": return colors.accent
		default: return colors.muted
	}
}

/** Body text color per line kind. */
const lineTextColor = (line: ChatLine): string => {
	switch (line.kind) {
		case "role-divider": return roleColor(line.role)
		// Chunk headers (tool call, tool result, reasoning, system)
		// render muted by default so the role divider above keeps
		// visual weight; the expand marker + meta do the work.
		case "chunk-header": return colors.muted
		case "text": return colors.text
		case "reasoning": return colors.muted
		case "tool-call-body": return colors.count
		case "tool-result-body": return colors.muted
		case "hint": return colors.separator
		case "empty": return colors.muted
		case "separator": return colors.separator
		default: return colors.text
	}
}

/**
 * Full-screen chat transcript for AI-flagged spans (level 2). Replaces
 * SpanContentView when `isAiSpan(span.tags)` is true. The transcript
 * is broken into semantic chunks (system, user/assistant text blocks,
 * individual tool calls, tool results, response). `j/k` moves the
 * selection cursor between chunks; `enter` toggles expansion on
 * collapsible chunks (system, reasoning, tool calls, long tool
 * results). The viewport auto-scrolls to keep the selected chunk
 * header visible.
 */
export const AiChatView = ({
	span,
	detailState,
	chunks,
	selectedChunkId,
	expandedChunkIds,
	contentWidth,
	bodyLines,
	paneWidth,
}: {
	readonly span: TraceSpanItem | null
	readonly detailState: AiCallDetailState
	readonly chunks: readonly Chunk[]
	readonly selectedChunkId: string | null
	readonly expandedChunkIds: ReadonlySet<string>
	readonly contentWidth: number
	readonly bodyLines: number
	readonly paneWidth: number
}) => {
	const lines = useMemo<readonly ChatLine[]>(
		() => renderChunks(chunks, { width: contentWidth, expanded: expandedChunkIds }),
		[chunks, contentWidth, expandedChunkIds],
	)

	if (!span || !isAiSpan(span.tags)) {
		return (
			<box flexDirection="column" width={paneWidth} height={bodyLines + AI_CHAT_HEADER_ROWS} overflow="hidden">
				<box paddingLeft={1} paddingRight={1}>
					<AlignedHeaderLine left="AI CHAT" right="not an ai span" width={contentWidth} rightFg={colors.muted} />
				</box>
			</box>
		)
	}

	const detail = detailState.data
	const model = detail?.model ?? span.tags["ai.model.id"] ?? "unknown model"
	const provider = detail?.provider ?? span.tags["ai.model.provider"] ?? null
	const operation = detail?.operation ?? span.operationName
	const finishReason = detail?.finishReason ?? null
	const usage = detail?.usage ?? null
	const durationLabel = formatDuration(detail?.durationMs ?? span.durationMs)

	// Viewport math — scroll so the selected chunk's header is visible.
	// If the selected chunk (expanded) is taller than bodyLines we show
	// as much as fits starting at the header; the user can expand other
	// chunks or rely on line-level scroll later.
	const totalLines = lines.length
	const selectedHeaderIdx = selectedChunkId ? chunkHeaderLineIndex(lines, selectedChunkId) : -1
	let offset = 0
	if (selectedHeaderIdx >= 0) {
		// Keep 1 line of context above the selected header when possible
		// so the user can see the previous chunk's tail.
		offset = Math.max(0, selectedHeaderIdx - 1)
		// Don't over-scroll past the last renderable window.
		offset = Math.min(offset, Math.max(0, totalLines - bodyLines))
	}
	const visible = lines.slice(offset, offset + bodyLines)

	const pct = totalLines === 0 ? 0 : Math.min(100, Math.round(((offset + visible.length) / totalLines) * 100))
	const scrollLabel = totalLines <= bodyLines ? "all" : `${pct}%`
	const headerRight = `${operation} ${SEPARATOR} ${durationLabel} ${SEPARATOR} ${scrollLabel}`

	const selectedChunk = selectedChunkId ? chunks.find((c) => c.id === selectedChunkId) ?? null : null
	const selectedIndex = selectedChunk ? chunks.indexOf(selectedChunk) : -1

	return (
		<box flexDirection="column" width={paneWidth} height={bodyLines + AI_CHAT_HEADER_ROWS} overflow="hidden">
			<box paddingLeft={1} paddingRight={1}>
				<AlignedHeaderLine left="AI CHAT" right={headerRight} width={contentWidth} rightFg={colors.count} />
			</box>
			<box flexDirection="column" paddingLeft={1} paddingRight={1}>
				<TextLine>
					<span fg={colors.accent} attributes={TextAttributes.BOLD}>{"\u2726 "}</span>
					<span fg={colors.text}>{model}</span>
					{provider ? (
						<>
							<span fg={colors.separator}>{SEPARATOR}</span>
							<span fg={colors.muted}>{provider}</span>
						</>
					) : null}
					{finishReason ? (
						<>
							<span fg={colors.separator}>{SEPARATOR}</span>
							<span fg={colors.muted}>{`finish=${finishReason}`}</span>
						</>
					) : null}
					{selectedChunk && selectedIndex >= 0 ? (
						<>
							<span fg={colors.separator}>{SEPARATOR}</span>
							<span fg={colors.muted}>{`${selectedIndex + 1}/${chunks.length}`}</span>
						</>
					) : null}
				</TextLine>
				<TextLine>
					{usage ? (
						<>
							<span fg={colors.muted}>{"tokens "}</span>
							<span fg={colors.count}>{usage.inputTokens != null ? `in=${usage.inputTokens}` : ""}</span>
							<span fg={colors.muted}>{usage.cachedInputTokens != null ? ` cached=${usage.cachedInputTokens}` : ""}</span>
							<span fg={colors.count}>{usage.outputTokens != null ? ` out=${usage.outputTokens}` : ""}</span>
							<span fg={colors.muted}>{usage.reasoningTokens != null ? ` reason=${usage.reasoningTokens}` : ""}</span>
						</>
					) : (
						<span fg={colors.muted}>{detail?.sessionId ? `session ${detail.sessionId}` : "no usage reported"}</span>
					)}
				</TextLine>
			</box>
			<Divider width={paneWidth} />
			<box flexDirection="column" paddingLeft={1} paddingRight={1}>
				{detailState.status === "loading" && !detail ? (
					<PlainLine text="loading chat transcript…" fg={colors.muted} />
				) : detailState.status === "error" ? (
					<PlainLine text={detailState.error ?? "failed to load chat detail"} fg={colors.error} />
				) : chunks.length === 0 ? (
					<PlainLine text="no chat content parsed from this span" fg={colors.muted} />
				) : (
					visible.map((line, i) => renderLine(line, offset + i, selectedChunkId, chunks, expandedChunkIds, contentWidth))
				)}
				{visible.length < bodyLines && chunks.length > 0 ? (
					Array.from({ length: bodyLines - visible.length }).map((_, i) => (
						<BlankRow key={`pad-${i}`} />
					))
				) : null}
			</box>
		</box>
	)
}

// Selection rendering: a single colored left-edge bar (`▎`) runs down
// the full footprint of the selected chunk — its header plus every
// body line that belongs to it. Reads much cleaner than background
// highlight and matches the vim-style "range is visible on the left
// gutter" convention.
const SELECTION_BAR = "\u258e" // left one-quarter block
const INACTIVE_GUTTER = " "

const renderLine = (
	line: ChatLine,
	index: number,
	selectedChunkId: string | null,
	chunks: readonly Chunk[],
	expanded: ReadonlySet<string>,
	width: number,
) => {
	const color = lineTextColor(line)
	const isSelected = line.chunkId !== null && line.chunkId === selectedChunkId
	const gutterChar = isSelected ? SELECTION_BAR : INACTIVE_GUTTER
	const gutterColor = isSelected ? roleColor(line.role) : colors.separator

	if (line.kind === "role-divider") {
		// Role dividers are never selectable (no chunkId) so the
		// gutter is always blank but the label gets the role color for
		// instant visual tagging.
		return (
			<TextLine key={`l-${index}`}>
				<span fg={colors.separator}>{" "}</span>
				<span fg={color} attributes={TextAttributes.BOLD}>{line.text}</span>
			</TextLine>
		)
	}

	if (line.kind === "separator") {
		return <BlankRow key={`l-${index}`} />
	}

	if (line.kind === "chunk-header") {
		const chunk = line.chunkId ? chunks.find((c) => c.id === line.chunkId) : null
		const expandedNow = chunk ? isChunkExpanded(chunk, expanded) : false
		// Single marker per header: `▸` when collapsed, `▾` when
		// expanded, blank for non-collapsible chunks. No second cursor
		// — the left-gutter bar already tells the reader what's
		// selected.
		const marker = chunk?.collapsible
			? (expandedNow ? "\u25be " : "\u25b8 ")
			: "  "
		const meta = line.headerMeta ?? ""
		const rightWidth = Math.max(0, width - line.text.length - marker.length - 2)
		const padding = Math.max(1, rightWidth - meta.length)
		return (
			<TextLine key={`l-${index}`}>
				<span fg={gutterColor}>{gutterChar}</span>
				<span fg={chunk?.collapsible ? colors.muted : colors.separator}>{marker}</span>
				<span fg={color} attributes={isSelected ? TextAttributes.BOLD : undefined}>{line.text}</span>
				{meta ? (
					<>
						<span fg={colors.muted}>{" ".repeat(padding)}</span>
						<span fg={colors.muted}>{meta}</span>
					</>
				) : null}
			</TextLine>
		)
	}

	// Body line (text / reasoning / tool body / hint).
	return (
		<TextLine key={`l-${index}`}>
			<span fg={gutterColor}>{gutterChar}</span>
			<span fg={color}>{line.text}</span>
		</TextLine>
	)
}
