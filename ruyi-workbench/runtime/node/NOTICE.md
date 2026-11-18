# Bundled Node.js runtime

The bundled `node.exe` is the unmodified official Node.js v24.14.0 Windows x64
binary. `LICENSE` is the complete, unmodified top-level license from the matching
official Windows ZIP. It includes Node.js and the third-party notices carried by
that distribution. The ZIP has no separate top-level NOTICE file. This file is
Ruyi's source notice, not a replacement for the upstream license.

`provenance.lock.json` records the fixed official download URLs and SHA-256
identities. `SHASUMS256.txt` is the original official release checksum list. Both
the local executable and the executable in the verified ZIP match its
`win-x64/node.exe` entry. The ZIP also contains npm, which Ruyi does not bundle
with this independent runtime.

The material preparer downloads only when explicitly passed `-Download`; normal
packaging validates the checked-in material and performs no license download.
Updating Node requires reviewing and updating the matching complete license and
provenance together. Hash checks establish byte identity; they do not replace
cryptographic release signature validation or a legal redistribution review.
