import { RGBA, TextAttributes } from "@opentui/core"
import { colors } from "./theme.ts"
import { fitCell, truncateText } from "./format.ts"
import type { DetailView } from "./state.ts"

export const BlankRow = () => <box height={1} />

export const PlainLine = ({ text, fg = colors.text, bold = false }: { text: string; fg?: string; bold?: boolean }) => (
	<box height={1}>
		{bold ? (
			<text wrapMode="none" truncate fg={fg} attributes={TextAttributes.BOLD}>
				{text}
			</text>
		) : (
			<text wrapMode="none" truncate fg={fg}>
				{text}
			</text>
		)}
	</box>
)

export const TextLine = ({ children, fg = colors.text, bg }: { children: React.ReactNode; fg?: string; bg?: string | undefined }) => (
	<box height={1}>
		{bg ? (
			<text wrapMode="none" truncate fg={fg} bg={bg}>
				{children}
			</text>
		) : (
			<text wrapMode="none" truncate fg={fg}>
				{children}
			</text>
		)}
	</box>
)

export const AlignedHeaderLine = ({ left, right, width, rightFg = colors.muted }: { left: string; right: string; width: number; rightFg?: string }) => {
	const availableRightWidth = Math.max(8, width - left.length - 2)
	const rightText = truncateText(right, availableRightWidth)
	const gap = Math.max(2, width - left.length - rightText.length)

	return (
		<TextLine>
			<span fg={colors.accent} attributes={TextAttributes.BOLD}>{left}</span>
			<span fg={colors.muted}>{" ".repeat(gap)}</span>
			<span fg={rightFg}>{rightText}</span>
		</TextLine>
	)
}

export const Divider = ({ width }: { width: number }) => (
	<PlainLine text={"\u2500".repeat(Math.max(1, width))} fg={colors.separator} />
)

/** Horizontal divider split into left ─ junction ─ right, using flex row so
 *  the junction character lands at exactly the same column as the SeparatorColumn. */
export const SplitDivider = ({ leftWidth, junction, rightWidth }: { leftWidth: number; junction: string; rightWidth: number }) => (
	<box flexDirection="row" height={1}>
		<box width={leftWidth}><text fg={colors.separator} wrapMode="none" truncate>{"\u2500".repeat(leftWidth)}</text></box>
		<box width={1}><text fg={colors.separator}>{junction}</text></box>
		<box width={rightWidth}><text fg={colors.separator} wrapMode="none" truncate>{"\u2500".repeat(rightWidth)}</text></box>
	</box>
)

/** Row index → junction character override. Callers supply exactly the
 *  glyph they want at each row so the separator lines up with whatever
 *  divider geometry the neighboring panes happen to have:
 *    - `\u251c` (├) when only the right pane has a divider at that row
 *    - `\u2524` (┤) when only the left pane has a divider at that row
 *    - `\u253c` (┼) when both do
 */
export const SeparatorColumn = ({ height, junctionChars }: { height: number; junctionChars?: ReadonlyMap<number, string> }) => {
	const lines: string[] = []
	for (let i = 0; i < Math.max(1, height); i++) {
		lines.push(junctionChars?.get(i) ?? "\u2502")
	}
	return (
		<box width={1} height={height} overflow="hidden">
			<text fg={colors.separator}>{lines.join("\n")}</text>
		</box>
	)
}

export const FilterBar = ({ text, width }: { text: string; width: number }) => (
	<TextLine fg={colors.accent}>
		<span fg={colors.muted}>{"/"}</span>
		<span fg={colors.text}>{fitCell(text, width - 2)}</span>
		<span fg={colors.accent}>{"\u2588"}</span>
	</TextLine>
)

const FooterKey = ({ label }: { label: string }) => <span fg={colors.count} attributes={TextAttributes.BOLD}>{label}</span>

export const HelpModal = ({ width, height, autoRefresh, onClose }: { width: number; height: number; autoRefresh: boolean; onClose: () => void }) => {
	const panelWidth = Math.min(76, Math.max(52, width - 10))
	const left = Math.max(2, Math.floor((width - panelWidth) / 2))
	const top = Math.max(1, Math.floor(height / 5))
	const sectionGap = Math.max(1, panelWidth - 24)
	const row = (key: string, desc: string) => (
		<TextLine>
			<span fg={colors.count} attributes={TextAttributes.BOLD}>{key.padEnd(11)}</span>
			<span fg={colors.muted}>{desc}</span>
		</TextLine>
	)

	return (
		<box position="absolute" zIndex={3000} left={0} top={0} width={width} height={height} backgroundColor={RGBA.fromInts(0, 0, 0, 110)} onMouseUp={onClose}>
			<box position="absolute" left={left} top={top} width={panelWidth} flexDirection="column" backgroundColor={RGBA.fromInts(20, 20, 28, 255)}>
				<box paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} flexDirection="column">
					<TextLine>
						<span fg={colors.count} attributes={TextAttributes.BOLD}>Help</span>
						<span fg={colors.muted}>{" ".repeat(sectionGap)}</span>
						<span fg={colors.muted}>esc / enter / ? close</span>
					</TextLine>
					<BlankRow />
					{row("j k  ↑ ↓", "move selection")}
					{row("enter", "select spans / open detail / jump from logs")}
					{row("esc", "back out of detail or span selection")}
					{row("tab", "toggle service logs")}
					{row("[ ]", "switch service")}
					{row("/", "filter traces")}
					{row("s", "cycle sort mode")}
					{row("a", `auto refresh ${autoRefresh ? "on" : "off"}`)}
					{row("r", "refresh traces")}
					{row("y", "copy selected trace/span ids")}
					{row("o / O", "open trace / open web UI")}
					{row("gg / G", "jump to first / last")}
					{row("^d / ^u", "page down / up")}
					{row("q", "quit")}
				</box>
			</box>
		</box>
	)
}

export const FooterHints = ({ spanNavActive, detailView, autoRefresh, width: _width }: { spanNavActive: boolean; detailView: DetailView; autoRefresh: boolean; width: number }) => {
	const enterAction = detailView === "service-logs"
		? "trace"
		: spanNavActive && detailView === "waterfall"
			? "detail"
			: "spans"
	const escAction = spanNavActive
		? (detailView === "span-detail" ? "back" : "traces")
		: null
	const items: Array<[string, string]> = [
		["j/k", "move"],
		["enter", enterAction],
		...(escAction ? [["esc", escAction] as [string, string]] : []),
		["tab", "logs"],
		["/", "filter"],
		["s", "sort"],
		["a", autoRefresh ? "live" : "paused"],
		["?", "help"],
		["q", "quit"],
	]
	const renderItems = (items: ReadonlyArray<readonly [string, string]>) => (
		items.flatMap(([key, label], index) => [
			<FooterKey key={`${key}-key`} label={key} />,
			<span key={`${key}-label`} fg={colors.muted}>{` ${label}`}</span>,
			index < items.length - 1 ? <span key={`${key}-sep`} fg={colors.separator}>{" · "}</span> : null,
		])
	)

	return (
		<TextLine>
			{renderItems(items)}
		</TextLine>
	)
}
