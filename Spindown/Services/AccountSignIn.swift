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
/// sees the one-time service ticket in the final redirect.
struct GarminSignInView: View {
    @Environment(UploadCoordinator.self) private var uploads
    @Environment(\.dismiss) private var dismiss
    @State private var status: String?
    @State private var working = false

    var body: some View {
        NavigationStack {
            ZStack {
                GarminWebView(config: uploads.garmin.config) { ticket in
                    Task { await complete(ticket) }
                }
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
        working = true
        defer { working = false }
        do {
            try await uploads.completeGarminSignIn(ticket: ticket)
            dismiss()
        } catch {
            status = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }
}

private struct GarminWebView: PlatformViewRepresentable {
    let config: GarminConnectConfig
    let onTicket: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(config: config, onTicket: onTicket) }

    private func makeWebView(_ coordinator: Coordinator) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        // Fresh session each time: nothing from a previous sign-in lingers in the app.
        configuration.websiteDataStore = .nonPersistent()
        let web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = coordinator
        web.load(URLRequest(url: config.signInURL))
        return web
    }

    #if os(iOS)
    func makeUIView(context: Context) -> WKWebView { makeWebView(context.coordinator) }
    func updateUIView(_ view: WKWebView, context: Context) {}
    #else
    func makeNSView(context: Context) -> WKWebView { makeWebView(context.coordinator) }
    func updateNSView(_ view: WKWebView, context: Context) {}
    #endif

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        let config: GarminConnectConfig
        let onTicket: (String) -> Void
        private var delivered = false

        init(config: GarminConnectConfig, onTicket: @escaping (String) -> Void) {
            self.config = config
            self.onTicket = onTicket
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            guard let url = action.request.url else { return .allow }
            if let ticket = config.ticket(fromRedirect: url) {
                if !delivered {
                    delivered = true
                    onTicket(ticket)
                }
                return .cancel
            }
            return .allow
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
