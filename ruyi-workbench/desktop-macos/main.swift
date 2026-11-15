import AppKit

let app = NSApplication.shared
let delegate = RuyiDesktop()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
