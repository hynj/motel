import { TextAttributes } from "@opentui/core"
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

export const SeparatorColumn = ({ height, junctionRows }: { height: number; junctionRows?: ReadonlySet<number> }) => {
	const lines: string[] = []
	for (let i = 0; i < Math.max(1, height); i++) {
		lines.push(junctionRows?.has(i) ? "\u251c" : "\u2502")
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

export const FooterHints = ({ spanNavActive, detailView, autoRefresh, width }: { spanNavActive: boolean; detailView: DetailView; autoRefresh: boolean; width: number }) => {
	// Group keys by purpose; render as `group: keys  group: keys`.
	// Only the most-used actions; `?` reveals the full list.
	const enterAction = detailView === "service-logs"
		? "trace"
		: spanNavActive && detailView === "waterfall"
			? "detail"
			: "spans"
	const escAction = spanNavActive
		? (detailView === "span-detail" ? "back" : "traces")
		: null

	const nav = "j/k move  ^d/^u page"
	const action = [
		`\u21b5 ${enterAction}`,
		escAction ? `esc ${escAction}` : null,
		"tab logs",
		"[/] svc",
	].filter((x) => x !== null).join("  ")
	const meta = [
		"/ filter",
		"s sort",
		`a live:${autoRefresh ? "on" : "off"}`,
		"r refresh",
	].join("  ")
	const go = "o open  O web  ? help  q quit"

	return (
		<box flexDirection="column">
			<TextLine fg={colors.muted} bg={colors.footerBg}>
				<span fg={colors.separator}>nav </span>
				<span>{nav}</span>
				<span fg={colors.separator}>{"   \u2502   "}</span>
				<span fg={colors.separator}>do </span>
				<span>{fitCell(action, Math.max(0, width - (nav.length + 7 + 7 + 4)))}</span>
			</TextLine>
			<TextLine fg={colors.muted} bg={colors.footerBg}>
				<span fg={colors.separator}>view </span>
				<span>{meta}</span>
				<span fg={colors.separator}>{"   \u2502   "}</span>
				<span>{fitCell(go, Math.max(0, width - (meta.length + 8 + 4)))}</span>
			</TextLine>
		</box>
	)
}
