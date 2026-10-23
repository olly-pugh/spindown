import Foundation
import Security
import InRideKit

/// Generic-password Keychain items, available after first unlock so background uploads work
/// while the phone is locked.
struct KeychainStore: SecretStore {
    let service: String

    init(service: String = "com.spindown.app") {
        self.service = service
    }

    private func query(_ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: key]
    }

    func load(_ key: String) -> Data? {
        var q = query(key)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess else { return nil }
        return out as? Data
    }

    func save(_ data: Data, for key: String) {
        let update: [String: Any] = [kSecValueData as String: data]
        if SecItemUpdate(query(key) as CFDictionary, update as CFDictionary) == errSecItemNotFound {
            var add = query(key)
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            SecItemAdd(add as CFDictionary, nil)
        }
    }

    func delete(_ key: String) {
        SecItemDelete(query(key) as CFDictionary)
    }

    func string(_ key: String) -> String? { load(key).map { String(decoding: $0, as: UTF8.self) } }
    func set(_ value: String, for key: String) {
        if value.isEmpty { delete(key) } else { save(Data(value.utf8), for: key) }
    }
}
