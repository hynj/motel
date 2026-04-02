const parseBoolean = (value: string | undefined, defaultValue: boolean) => {
	const normalized = value?.trim().toLowerCase()
	if (!normalized) return defaultValue
	return !["0", "false", "no", "off"].includes(normalized)
}

const parsePositiveInt = (value: string | undefined, defaultValue: number) => {
	const parsed = Number.parseInt(value ?? "", 10)
	return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue
}

export const config = {
	otel: {
		enabled: parseBoolean(process.env.LETO_OTEL_ENABLED, true),
		serviceName: process.env.LETO_OTEL_SERVICE_NAME?.trim() || "leto-otel-tui",
		exporterUrl: process.env.LETO_OTEL_EXPORTER_URL?.trim() || "http://127.0.0.1:25318/v1/traces",
		queryUrl: process.env.LETO_OTEL_QUERY_URL?.trim() || "http://127.0.0.1:27686",
		traceLookbackMinutes: parsePositiveInt(process.env.LETO_OTEL_TRACE_LOOKBACK_MINUTES, 90),
		traceFetchLimit: parsePositiveInt(process.env.LETO_OTEL_TRACE_LIMIT, 40),
	},
} as const
