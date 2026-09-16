import CFNetwork
import Testing
@testable import OpenClawRustSidecar

struct SystemProxyTests {
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
