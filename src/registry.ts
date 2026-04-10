import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

export const MOTEL_VERSION = "0.1.0"
export const MOTEL_SERVICE_ID = "motel-local-server"

const stateHome = () =>
	process.env.XDG_STATE_HOME?.trim() || path.join(os.homedir(), ".local", "state")

export const registryDir = () => path.join(stateHome(), "motel", "instances")

export type RegistryEntry = {
	readonly pid: number
	readonly url: string
	readonly workdir: string
	readonly startedAt: string
	readonly version: string
}

const entryPath = (pid: number) => path.join(registryDir(), `${pid}.json`)

let currentEntryPath: string | null = null

const cleanup = () => {
	if (!currentEntryPath) return
	try {
		fs.unlinkSync(currentEntryPath)
	} catch {
		// already gone — ignore
	}
	currentEntryPath = null
}

export const isAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0)
		return true
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM"
	}
}

export const listAliveEntries = (): RegistryEntry[] => {
	const dir = registryDir()
	let files: string[]
	try {
		files = fs.readdirSync(dir)
	} catch {
		return []
	}
	const alive: RegistryEntry[] = []
	for (const f of files) {
		if (!f.endsWith(".json")) continue
		const full = path.join(dir, f)
		try {
			const entry = JSON.parse(fs.readFileSync(full, "utf8")) as RegistryEntry
			if (isAlive(entry.pid)) {
				alive.push(entry)
			} else {
				try { fs.unlinkSync(full) } catch {}
			}
		} catch {
			try { fs.unlinkSync(full) } catch {}
		}
	}
	return alive
}

export const writeRegistryEntry = (entry: RegistryEntry) => {
	fs.mkdirSync(registryDir(), { recursive: true })
	const file = entryPath(entry.pid)
	fs.writeFileSync(file, JSON.stringify(entry, null, 2), "utf8")
	currentEntryPath = file
	process.on("exit", cleanup)
	for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
		process.on(sig, () => {
			cleanup()
			process.exit(0)
		})
	}
}
