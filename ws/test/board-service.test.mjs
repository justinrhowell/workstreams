import { test } from "node:test"
import assert from "node:assert/strict"
import { renderSystemdUnit } from "../lib/board-service.mjs"

const base = { node: "/usr/bin/node", nextBin: "/opt/ws/node_modules/next/dist/bin/next", app: "/opt/ws", port: "3311", dist: ".next-prod", root: "/home/u/.local/share/ws", path: "/usr/bin:/bin" }

test("systemd unit binds 127.0.0.1 on the configured port and pins env", () => {
  const u = renderSystemdUnit(base)
  assert.match(u, /^ExecStart="\/usr\/bin\/node" "\/opt\/ws\/node_modules\/next\/dist\/bin\/next" start -H 127\.0\.0\.1 -p 3311$/m)
  assert.match(u, /^WorkingDirectory="\/opt\/ws"$/m)
  assert.match(u, /^Environment="NEXT_DIST_DIR=\.next-prod"$/m)
  assert.match(u, /^Environment="WS_ROOT=\/home\/u\/\.local\/share\/ws"$/m)
  assert.match(u, /^Restart=always$/m)
  assert.match(u, /^WantedBy=default\.target$/m)
})

test("systemd unit escapes quotes, backslashes, % and $ in paths", () => {
  const u = renderSystemdUnit({ ...base, root: '/data/my "ws" 100%/$HOME\\dir' })
  assert.ok(u.includes('Environment="WS_ROOT=/data/my \\"ws\\" 100%%/$$HOME\\\\dir"'))
})
