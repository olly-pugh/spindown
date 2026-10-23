import AuthenticationServices
import SwiftUI
import WebKit
import InRideKit

#if os(iOS)
typealias PlatformViewRepresentable = UIViewRepresentable
#else
typealias PlatformViewRepresentable = NSViewRepresentable
#endif

/// Garmin's own sign-in page in a web view. Credentials go straight to Garmin; the app only
/// receives the one-time service ticket, which the page hands to its native host through the
/// `GMNEventHandler` bridge (as it does inside Garmin Connect Mobile).
struct GarminSignInView: View {
    @Environment(AppModel.self) private var model
    @Environment(UploadCoordinator.self) private var uploads
    @Environment(\.dismiss) private var dismiss
    @State private var status: String?
    @State private var working = false

    var body: some View {
        NavigationStack {
            ZStack {
                GarminWebView(config: uploads.garmin.config,
                              onTicket: { ticket in Task { await complete(ticket) } },
                              onExit: { dismiss() },
                              log: { model.log.log("Garmin sign-in: \($0)") })
                if working {
                    ProgressView("Finishing sign-in…")
                        .padding(24)
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
                }
            }
            .safeAreaInset(edge: .bottom) {
                if let status {
                    Text(status).font(.footnote).padding().frame(maxWidth: .infinity).background(.red.opacity(0.85))
                }
            }
            .navigationTitle("Garmin Connect")
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
    }

    private func complete(_ ticket: String) async {
        guard !working else { return }
        working = true
        defer { working = false }
        do {
            try await uploads.completeGarminSignIn(ticket: ticket)
            dismiss()
        } catch {
            let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            model.log.log("Garmin sign-in failed: \(message)", level: .error)
            status = message
        }
    }
}

private struct GarminWebView: PlatformViewRepresentable {
    let config: GarminConnectConfig
    let onTicket: (String) -> Void
    let onExit: () -> Void
    let log: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(config: config, onTicket: onTicket, onExit: onExit, log: log) }

    private func makeWebView(_ coordinator: Coordinator) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        // Fresh session each time: nothing from a previous sign-in lingers in the app.
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.add(coordinator, name: GarminConnectConfig.bridgeHandlerName)
        let web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = coordinator
        log("loading \(config.signInURL.host ?? "")\(config.signInURL.path)")
        web.load(URLRequest(url: config.signInURL))
        return web
    }

    private static func tearDown(_ web: WKWebView) {
        web.configuration.userContentController.removeScriptMessageHandler(forName: GarminConnectConfig.bridgeHandlerName)
    }

    #if os(iOS)
    func makeUIView(context: Context) -> WKWebView { makeWebView(context.coordinator) }
    func updateUIView(_ view: WKWebView, context: Context) {}
    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) { tearDown(view) }
    #else
    func makeNSView(context: Context) -> WKWebView { makeWebView(context.coordinator) }
    func updateNSView(_ view: WKWebView, context: Context) {}
    static func dismantleNSView(_ view: WKWebView, coordinator: Coordinator) { tearDown(view) }
    #endif

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        let config: GarminConnectConfig
        let onTicket: (String) -> Void
        let onExit: () -> Void
        let log: (String) -> Void
        private var delivered = false

        init(config: GarminConnectConfig, onTicket: @escaping (String) -> Void, onExit: @escaping () -> Void,
             log: @escaping (String) -> Void) {
            self.config = config
            self.onTicket = onTicket
            self.onExit = onExit
            self.log = log
        }

        private func deliver(_ ticket: String, via route: String) {
            guard !delivered else { return }
            delivered = true
            log("received service ticket via \(route)")
            onTicket(ticket)
        }

        // Primary path: the page posts events to the native bridge.
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let event = GarminConnectConfig.bridgeEvent(from: message.body) else {
                log("unrecognised bridge message")
                return
            }
            log("event \(event.type)\(event.flow.map { " (\($0))" } ?? "")\(event.title.map { " \"\($0)\"" } ?? "")")
            if let ticket = event.ticket {
                if let url = event.serviceURL, url != config.serviceURL {
                    log("page reported service URL \(url)")
                }
                deliver(ticket, via: "bridge")
            } else if event.type == "USER_EXIT" {
                onExit()
            }
        }

        // Fallback: some flows redirect to the service URL with ?ticket=ST-...
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            guard let url = action.request.url else { return .allow }
            if let ticket = config.ticket(fromRedirect: url) {
                deliver(ticket, via: "redirect")
                return .cancel
            }
            if delivered { return .cancel } // the page navigates away after handing over the ticket
            return .allow
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            log("navigation failed: \(error.localizedDescription)")
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            log("load failed: \(error.localizedDescription)")
        }
    }
}

/// Strava OAuth via the system authentication session.
struct StravaSignInButton: View {
    @Environment(UploadCoordinator.self) private var uploads
    @Environment(\.webAuthenticationSession) private var webAuth
    @State private var error: String?
    @State private var working = false

    var body: some View {
        Button {
            Task { await signIn() }
        } label: {
            HStack {
                Label("Connect Strava", systemImage: "link")
                if working { Spacer(); ProgressView() }
            }
        }
        .disabled(working)
        if let error {
            Text(error).font(.footnote).foregroundStyle(.red)
        }
    }

    private func signIn() async {
        working = true
        defer { working = false }
        error = nil
        let state = UUID().uuidString
        do {
            let url = try await uploads.strava.authorizeURL(state: state)
            let scheme = await uploads.strava.config.callbackScheme
            let callback = try await webAuth.authenticate(using: url, callbackURLScheme: scheme, preferredBrowserSession: .shared)
            try await uploads.completeStravaSignIn(callback: callback, state: state)
        } catch let e as ASWebAuthenticationSessionError where e.code == .canceledLogin {
            return
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }
}
