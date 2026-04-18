import { Effect } from "effect"
import * as Atom from "effect/unstable/reactivity/Atom"
import type { AiCallDetail } from "../domain.ts"
import { queryRuntime } from "../runtime.ts"
import { TraceQueryService } from "../services/TraceQueryService.ts"
import type { LoadStatus } from "./atoms.ts"

// AI chat view (full-screen when drilled into an `isAiSpan` span).
// ---------------------------------------------------------------------
// Navigation is chunk-based: each message/tool-call/tool-result is a
// semantic unit the user can select with j/k and expand with enter.
// The scroll offset is still kept so long expanded chunks can be
// panned line-by-line if needed, but it's derived from the selected
// chunk most of the time.
// ---------------------------------------------------------------------
export const chatScrollOffsetAtom = Atom.make(0).pipe(Atom.keepAlive)
/** Chunk id currently selected (null = first chunk). */
export const selectedChatChunkIdAtom = Atom.make<string | null>(null).pipe(Atom.keepAlive)
/** Explicit expansion overrides; stored with a `!` prefix for
 *  default-open chunks the user has force-collapsed. */
export const expandedChatChunkIdsAtom = Atom.make<ReadonlySet<string>>(new Set<string>() as ReadonlySet<string>).pipe(Atom.keepAlive)

export interface AiCallDetailState {
	readonly status: LoadStatus
	readonly spanId: string | null
	readonly data: AiCallDetail | null
	readonly error: string | null
}

export const initialAiCallDetailState: AiCallDetailState = {
	status: "ready",
	spanId: null,
	data: null,
	error: null,
}

export const aiCallDetailStateAtom = Atom.make(initialAiCallDetailState).pipe(Atom.keepAlive)

export const loadAiCallDetail = (spanId: string) =>
	queryRuntime.runPromise(Effect.flatMap(TraceQueryService.asEffect(), (service) => service.getAiCall(spanId)))

// AI call detail cache: the `ai.prompt` payload can easily be 50KB+ and
// we don't want to re-hit SQLite every time j/k moves the selection
// between adjacent AI spans. Cleared alongside the other per-refresh
// caches in `useTraceScreenData`.
const aiCallDetailCache = new Map<string, AiCallDetail | null>()
const aiCallDetailInflight = new Map<string, Promise<AiCallDetail | null>>()

export const getCachedAiCallDetail = (spanId: string): AiCallDetail | null | undefined =>
	aiCallDetailCache.has(spanId) ? aiCallDetailCache.get(spanId) ?? null : undefined

export const ensureAiCallDetail = (spanId: string): Promise<AiCallDetail | null> => {
	if (aiCallDetailCache.has(spanId)) return Promise.resolve(aiCallDetailCache.get(spanId) ?? null)
	const existing = aiCallDetailInflight.get(spanId)
	if (existing) return existing
	const request = loadAiCallDetail(spanId)
		.then((data) => {
			aiCallDetailCache.set(spanId, data)
			return data
		})
		.finally(() => {
			aiCallDetailInflight.delete(spanId)
		})
	aiCallDetailInflight.set(spanId, request)
	return request
}

export const invalidateAiCallDetailCache = () => {
	aiCallDetailCache.clear()
	aiCallDetailInflight.clear()
}
