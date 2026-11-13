// Minimal toolchain gate. A failure here is unrelated to the product or macOS API design.
import Foundation
print(ProcessInfo.processInfo.operatingSystemVersionString)
