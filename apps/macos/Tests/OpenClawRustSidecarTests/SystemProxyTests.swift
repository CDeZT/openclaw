import CFNetwork
import Testing
@testable import OpenClawRustSidecar

struct SystemProxyTests {
    @Test func `WebSocket routes use their HTTP equivalents for proxy lookup`() throws {
        let secure = try #require(URL(string: "wss://gateway.example:8443/ws?token=one"))
        let plaintext = try #require(URL(string: "ws://127.0.0.1:18789/ws"))

        #expect(
            RustGatewayWebSocketSession.proxyLookupURL(for: secure)?.absoluteString ==
                "https://gateway.example:8443/ws?token=one")
        #expect(
            RustGatewayWebSocketSession.proxyLookupURL(for: plaintext)?.absoluteString ==
                "http://127.0.0.1:18789/ws")
    }

    @Test func `direct routes can use the Rust transport`() {
        let proxies = [[AnyHashable: Any](
            dictionaryLiteral: (kCFProxyTypeKey as String, kCFProxyTypeNone as String))]

        #expect(!RustGatewayWebSocketSession.requiresURLSessionProxy(proxies))
    }

    @Test func `configured and unknown proxy routes preserve URLSession`() {
        let configured = [[AnyHashable: Any](
            dictionaryLiteral: (kCFProxyTypeKey as String, kCFProxyTypeHTTPS as String))]
        let unknown = [[AnyHashable: Any]()]

        #expect(RustGatewayWebSocketSession.requiresURLSessionProxy(configured))
        #expect(RustGatewayWebSocketSession.requiresURLSessionProxy(unknown))
    }
}
