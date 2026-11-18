// Renders the systemd user unit used by `ws board --install` on Linux.
// Pure: no I/O, so it can be tested without systemd.

// systemd treats % (specifiers) and $ (variables) specially, and honours C-style escapes inside double quotes.
const q = (s) =>
  `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$").replace(/\n/g, "\\n")}"`

export function renderSystemdUnit({ node, nextBin, app, port, dist, root, path: envPath }) {
  return `[Unit]
Description=ws board (workstreams)

[Service]
Type=simple
ExecStart=${q(node)} ${q(nextBin)} start -H 127.0.0.1 -p ${Number(port)}
WorkingDirectory=${q(app)}
Environment=${q(`NEXT_DIST_DIR=${dist}`)}
Environment="NODE_ENV=production"
Environment=${q(`PATH=${envPath}`)}
Environment=${q(`WS_ROOT=${root}`)}
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`
}
