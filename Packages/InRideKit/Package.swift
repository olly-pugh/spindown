// swift-tools-version:6.0
import PackageDescription

// InRideKit holds everything that does not need CoreBluetooth or UIKit:
// the inRide protocol, ride statistics, file export and the upload clients.
// Keeping it platform-neutral means it can be unit tested on macOS.
let package = Package(
    name: "InRideKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "InRideKit", targets: ["InRideKit"]),
    ],
    targets: [
        .target(name: "InRideKit"),
        .testTarget(name: "InRideKitTests", dependencies: ["InRideKit"]),
    ]
)
