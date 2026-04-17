import type { ScrollBoxRenderable } from "@opentui/core"
import type { RefObject } from "react"
import { FilterBar } from "../primitives.tsx"
import { TraceList, type TraceListProps } from "../TraceList.tsx"

interface TraceListPaneProps {
	readonly traceListProps: TraceListProps
	readonly filterMode: boolean
	readonly filterText: string
	readonly filterWidth: number
	readonly containerHeight: number
	readonly bodyHeight: number
	readonly padding: number
	readonly scrollRef: RefObject<ScrollBoxRenderable | null>
}

export const TraceListPane = ({
	traceListProps,
	filterMode,
	filterText,
	filterWidth,
	containerHeight,
	bodyHeight,
	padding,
	scrollRef,
}: TraceListPaneProps) => (
	// paddingRight=0 on purpose — the vertical pane divider on the right
	// already separates this from the trace details pane, and the scrollbar
	// lives inside the scrollbox, so a trailing padding column would just
	// be wasted space. useAppLayout.leftContentWidth is sized to match.
	<box height={containerHeight} flexDirection="column" paddingLeft={padding} paddingRight={0}>
		<TraceList showHeader {...traceListProps} />
		{filterMode ? <FilterBar text={filterText} width={filterWidth} /> : null}
		<scrollbox ref={scrollRef} height={filterMode ? bodyHeight - 1 : bodyHeight} flexGrow={0}>
			<TraceList showHeader={false} {...traceListProps} />
		</scrollbox>
	</box>
)
