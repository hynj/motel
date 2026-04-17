import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import path from "node:path"

export default defineConfig({
	plugins: [tailwindcss(), react()],
	resolve: {
		alias: {
			"@motel": path.resolve(__dirname, "../src"),
		},
	},
	server: {
		port: 5173,
		proxy: {
			"/api": "http://127.0.0.1:27686",
			"/v1": "http://127.0.0.1:27686",
			"/openapi.json": "http://127.0.0.1:27686",
		},
	},
	build: {
		outDir: "dist",
		emptyOutDir: true,
	},
})
