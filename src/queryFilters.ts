export const ATTRIBUTE_FILTER_PREFIX = "attr."

export const isAttributeFilterToken = (value: string) => value.startsWith(ATTRIBUTE_FILTER_PREFIX) && value.includes("=")

export const attributeFiltersFromEntries = (entries: Iterable<readonly [string, string]>) =>
	Object.fromEntries(
		[...entries]
			.filter(([key]) => key.startsWith(ATTRIBUTE_FILTER_PREFIX))
			.map(([key, value]) => [key.slice(ATTRIBUTE_FILTER_PREFIX.length), value]),
	)

export const attributeFiltersFromArgs = (values: readonly string[]) =>
	Object.fromEntries(
		values
			.filter(isAttributeFilterToken)
			.map((value) => {
				const index = value.indexOf("=")
				return [value.slice(ATTRIBUTE_FILTER_PREFIX.length, index), value.slice(index + 1)]
			}),
	)
