import Foundation
import Translation

// A persistent JSON-lines worker. No networking, article files, or credentials.
@main
struct AppleTranslate {
    static func reply(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
        FileHandle.standardOutput.write(data + Data([10]))
    }

    static func main() async {
        let source = Locale.Language(identifier: "en")
        let target = Locale.Language(identifier: "zh-Hans")
        var session: TranslationSession?
        while let line = readLine() {
            do {
                guard let data = line.data(using: .utf8),
                      let input = try JSONSerialization.jsonObject(with: data) as? [String: Any]
                else { reply(["ok": false, "code": "invalid_input"]); continue }
                let status = await LanguageAvailability().status(from: source, to: target)
                guard status == .installed else {
                    reply(["ok": false, "code": "languages_missing", "status": String(describing: status)])
                    continue
                }
                if input["op"] as? String == "status" {
                    reply(["ok": true, "status": "installed"])
                    continue
                }
                guard let segments = input["segments"] as? [[String: Any]],
                      !segments.isEmpty, segments.count <= 500 else {
                    reply(["ok": false, "code": "invalid_input"]); continue
                }
                let requests: [TranslationSession.Request] = try segments.map { item in
                    guard let id = item["id"] as? String, let text = item["text"] as? String else {
                        throw CocoaError(.coderInvalidValue)
                    }
                    return TranslationSession.Request(sourceText: text, clientIdentifier: id)
                }
                if session == nil { session = TranslationSession(installedSource: source, target: target) }
                guard let active = session else { continue }
                let responses = try await active.translations(from: requests)
                let output = responses.map { ["id": $0.clientIdentifier ?? "", "text": $0.targetText] }
                reply(["ok": true, "translations": output])
            } catch {
                session = nil
                // Keep system diagnostics and source text out of the wire protocol.
                reply(["ok": false, "code": "translation_failed"])
            }
        }
    }
}
