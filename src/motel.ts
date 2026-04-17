#!/usr/bin/env bun

const [command, ...args] = process.argv.slice(2)

switch (command) {
case undefined:
case "tui":
case "ui": {
	await import("./index.js")
	break
}

case "server": {
	await import("./server.js")
	break
}

case "mcp": {
	await import("./mcp.js")
	break
}

case "help":
case "--help":
case "-h": {
	console.log(`Usage:
	motel
	motel tui
	motel server
	motel mcp
	motel services
	motel traces [service] [limit]
	motel trace <trace-id>
	motel span <span-id>
	motel trace-spans <trace-id>
	motel search-spans [service] [operation] [parent=<operation>] [attr.key=value ...]
	motel search-traces [service] [operation] [attr.key=value ...]
	motel trace-stats <groupBy> <agg> [service] [attr.key=value ...]
	motel logs [service]
	motel search-logs [service] [body] [attr.key=value ...]
	motel log-stats <groupBy> [service] [attr.key=value ...]
	motel trace-logs <trace-id>
	motel span-logs <span-id>
	motel facets <traces|logs> <field>
	motel instructions
	motel endpoints`)
	break
}

default: {
	process.argv = [process.argv[0]!, process.argv[1]!, command, ...args]
	await import("./cli.js")
	break
}
}
